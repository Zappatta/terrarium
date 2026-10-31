import type {
  Action,
  PlantAction,
  DecideInput,
  EntityId,
  GameEvent,
  Perception,
  PlantSelfView,
  SelfView,
  SpeciesDescriptor,
  Traits,
  Vec2,
  VisibleEntity,
} from "@terrarium/sdk";
import { Rng, fnv1a } from "./rng.js";
import { SpatialHash } from "./spatial.js";
import {
  PHASES,
  type ActionHandler,
  type DeathCause,
  type Entity,
  type Migrant,
  type RuleModule,
  type SpawnOptions,
  type SpeciesController,
  type SpeciesStats,
  type System,
  type TraitDef,
  type WorldObserver,
} from "./types.js";
import { dist } from "./vec.js";

export interface WorldConfig {
  seed: string;
  width: number;
  height: number;
  maxTicks: number;
  traitBudget: number;
  initialPopulation: number;
  maxPopulationPerSpecies: number;
  initialPlantPopulation: number;
  maxPlantsPerSpecies: number;
  /** Plant species decide only every this many ticks: they are numerous and slow by nature. */
  plantThinkInterval: number;
  /** Nearest-N cap on perception, bounds payload size and sandbox work. */
  maxVisible: number;
  /** Per-module parameter overrides, keyed by module id. */
  params: Record<string, Record<string, number>>;
  maxLogLinesPerSpecies: number;
}

export const DEFAULT_CONFIG: WorldConfig = {
  seed: "terrarium",
  width: 800,
  height: 800,
  maxTicks: 5000,
  traitBudget: 30,
  initialPopulation: 10,
  maxPopulationPerSpecies: 150,
  initialPlantPopulation: 25,
  maxPlantsPerSpecies: 200,
  plantThinkInterval: 5,
  maxVisible: 24,
  params: {},
  maxLogLinesPerSpecies: 200,
};

interface SpeciesEntry {
  id: string;
  descriptor: SpeciesDescriptor;
  controller: SpeciesController;
  rng: Rng;
  pendingDied: EntityId[];
}

export class World {
  readonly config: WorldConfig;
  readonly rng: Rng;
  readonly spatial: SpatialHash;
  tick = 0;

  private readonly modules: RuleModule[];
  private readonly systems: System[];
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly traitDefs = new Map<string, TraitDef>();
  private readonly entities = new Map<EntityId, Entity>();
  private readonly species = new Map<string, SpeciesEntry>();
  private readonly stats = new Map<string, SpeciesStats>();
  private readonly events = new Map<EntityId, GameEvent[]>();
  private readonly dying: Array<[Entity, DeathCause]> = [];
  private readonly dyingSet = new Set<Entity>();
  private nextId = 1;
  private initialised = false;
  /** Organisms that left via migration this tick; the host drains it with takeEmigrants(). */
  private readonly outbox: Migrant[] = [];
  readonly ruleIds: string[];
  observer: WorldObserver | undefined;

  constructor(modules: RuleModule[], config: Partial<WorldConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config, params: { ...config.params } };
    this.rng = new Rng(this.config.seed);
    this.spatial = new SpatialHash(this.config.width, this.config.height, 64);
    this.modules = orderModules(modules);
    this.ruleIds = this.modules.map((m) => m.id);

    const systems: Array<System & { idx: number }> = [];
    this.modules.forEach((m) => {
      for (const t of m.traits ?? []) {
        if (this.traitDefs.has(t.name)) throw new Error(`Trait ${t.name} defined twice (module ${m.id})`);
        this.traitDefs.set(t.name, t);
      }
      for (const a of m.actions ?? []) {
        if (this.actionHandlers.has(a.type)) throw new Error(`Action ${a.type} defined twice (module ${m.id})`);
        this.actionHandlers.set(a.type, a);
      }
      for (const s of m.systems ?? []) systems.push({ ...s, idx: systems.length });
    });
    this.systems = systems.sort(
      (a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || (a.order ?? 0) - (b.order ?? 0) || a.idx - b.idx,
    );
  }

  param(moduleId: string, name: string, fallback: number): number {
    return this.config.params[moduleId]?.[name] ?? fallback;
  }

  /** Resolve a module's params against its defaults once, typed. */
  params<T extends Record<string, number>>(moduleId: string, defaults: T): T {
    const overrides = this.config.params[moduleId] ?? {};
    const out = { ...defaults };
    for (const k of Object.keys(defaults) as Array<keyof T>) {
      const v = overrides[k as string];
      if (typeof v === "number") out[k] = v as T[keyof T];
    }
    return out;
  }

  // ---- species ----

  /**
   * Species may join a world that is already running (shared live worlds); they get their initial
   * population straight away. `population` overrides config.initialPopulation, 0 for migrants only.
   */
  addSpecies(speciesId: string, controller: SpeciesController, population?: number): void {
    if (this.species.has(speciesId)) throw new Error(`Species ${speciesId} already in world`);
    const descriptor = { ...controller.descriptor, traits: this.validateTraits(controller.descriptor) };
    controller.attach?.({ speciesId, seed: `${this.config.seed}/brain:${speciesId}` });
    this.species.set(speciesId, {
      id: speciesId,
      descriptor,
      controller,
      rng: this.rng.fork(`species:${speciesId}`),
      pendingDied: [],
    });
    this.stats.set(speciesId, {
      speciesId,
      name: descriptor.name,
      diet: descriptor.diet,
      population: 0,
      peakPopulation: 0,
      births: 0,
      deaths: {},
      kills: 0,
      biomass: 0,
      biomassIntegral: 0,
      maxGeneration: 0,
      ticksAlive: 0,
      extinctAt: null,
      emigrated: 0,
      immigrated: 0,
      faults: 0,
      hostFaults: 0,
      lastError: null,
      fuelUsed: 0,
      logs: [],
    });
    const count = population ?? (descriptor.diet === "plant" ? this.config.initialPlantPopulation : this.config.initialPopulation);
    if (this.initialised) this.spawnInitial(speciesId, count, this.rng.fork(`placement:${speciesId}:${this.tick}`));
    else this.initialCounts.set(speciesId, count);
  }

  private readonly initialCounts = new Map<string, number>();

  private spawnInitial(speciesId: string, count: number, rng: Rng): void {
    for (let i = 0; i < count; i++) {
      this.spawnOrganism(speciesId, { x: rng.range(0, this.config.width), y: rng.range(0, this.config.height) }, {
        energyFraction: 0.6,
      });
    }
  }

  populationCap(speciesId: string): number {
    return this.species.get(speciesId)?.descriptor.diet === "plant"
      ? this.config.maxPlantsPerSpecies
      : this.config.maxPopulationPerSpecies;
  }

  /** Take a species out of the world entirely: members vanish (no corpses) and its brain is disposed. */
  removeSpecies(speciesId: string): void {
    const sp = this.species.get(speciesId);
    if (!sp) return;
    for (const e of this.organisms()) if (e.c.species?.speciesId === speciesId) this.remove(e);
    this.dying.splice(0, this.dying.length, ...this.dying.filter(([e]) => e.c.species?.speciesId !== speciesId));
    for (const e of [...this.dyingSet]) if (e.c.species?.speciesId === speciesId) this.dyingSet.delete(e);
    sp.controller.dispose?.();
    this.species.delete(speciesId);
    this.stats.delete(speciesId);
    this.initialCounts.delete(speciesId);
  }

  hasSpecies(speciesId: string): boolean {
    return this.species.has(speciesId);
  }

  validateTraits(d: SpeciesDescriptor): Traits {
    if (d.diet !== "herbivore" && d.diet !== "carnivore" && d.diet !== "plant") {
      throw new Error(`Invalid diet: ${String(d.diet)}`);
    }
    const applies = (def: TraitDef) => (def.diets ?? ["herbivore", "carnivore"]).includes(d.diet);
    if (d.diet === "plant" && !this.modules.some((m) => m.id === "flora")) throw new Error("Plant species need the flora rules");
    const traits: Traits = {};
    let spent = 0;
    for (const name of Object.keys(d.traits ?? {})) {
      const def = this.traitDefs.get(name);
      if (!def) throw new Error(`Unknown trait: ${name}`);
      if (!applies(def)) throw new Error(`Trait ${name} is not available to ${d.diet} species`);
    }
    for (const [name, def] of this.traitDefs) {
      if (!applies(def)) continue;
      const raw = d.traits?.[name] ?? def.default;
      if (!Number.isInteger(raw) || raw < def.min || raw > def.max) {
        throw new Error(`Trait ${name} must be an integer in [${def.min}, ${def.max}], got ${raw}`);
      }
      traits[name] = raw;
      spent += raw * (def.cost ?? 1);
    }
    if (spent > this.config.traitBudget) {
      throw new Error(`Traits cost ${spent} points, budget is ${this.config.traitBudget}`);
    }
    return traits;
  }

  traitDef(name: string): TraitDef | undefined {
    return this.traitDefs.get(name);
  }

  speciesIds(): string[] {
    return [...this.species.keys()].sort();
  }

  speciesDescriptor(speciesId: string): SpeciesDescriptor | undefined {
    return this.species.get(speciesId)?.descriptor;
  }

  getStats(speciesId: string): SpeciesStats {
    const s = this.stats.get(speciesId);
    if (!s) throw new Error(`Unknown species ${speciesId}`);
    return s;
  }

  allStats(): SpeciesStats[] {
    return this.speciesIds().map((id) => this.getStats(id));
  }

  // ---- entities ----

  get(id: EntityId): Entity | undefined {
    const e = this.entities.get(id);
    return e?.alive ? e : undefined;
  }

  /** Living entities in id order. Returns a copy, so callers may spawn or kill while iterating. */
  all(kind?: string): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) if (e.alive && (!kind || e.kind === kind)) out.push(e);
    return out;
  }

  /** Living members of any species (animals and plant-species plants), in id order. */
  organisms(): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) if (e.alive && e.c.species) out.push(e);
    return out;
  }

  count(kind: string): number {
    let n = 0;
    for (const e of this.entities.values()) if (e.alive && e.kind === kind) n++;
    return n;
  }

  /** Living entities whose bodies touch the circle, sorted by id. */
  near(p: Vec2, radius: number, kind?: string): Entity[] {
    const out: Entity[] = [];
    for (const id of this.spatial.near(p, radius + 16)) {
      const e = this.entities.get(id);
      if (e?.alive && (!kind || e.kind === kind) && dist(p, e.pos) <= radius + e.radius) out.push(e);
    }
    return out;
  }

  spawn(kind: string, pos: Vec2, radius: number, components: Entity["c"] = {}): Entity {
    const e: Entity = { id: this.nextId++, kind, pos: this.clampToWorld(pos), radius, alive: true, c: components };
    this.entities.set(e.id, e);
    this.spatial.upsert(e.id, e.pos);
    return e;
  }

  /** Spawn a member of a species: an "animal", or a "plant" for plant species. */
  spawnOrganism(speciesId: string, pos: Vec2, opts: SpawnOptions = {}): Entity | undefined {
    const sp = this.species.get(speciesId);
    if (!sp) throw new Error(`Unknown species ${speciesId}`);
    const stats = this.getStats(speciesId);
    if (stats.population >= this.populationCap(speciesId)) return undefined;
    const e = this.spawn(sp.descriptor.diet === "plant" ? "plant" : "animal", pos, 1, {
      species: {
        speciesId,
        diet: sp.descriptor.diet,
        traits: { ...sp.descriptor.traits },
        generation: opts.generation ?? 0,
        parentId: opts.parentId ?? null,
      },
    });
    for (const m of this.modules) m.onOrganismCreated?.(this, e, opts);
    stats.population++;
    stats.births++;
    stats.peakPopulation = Math.max(stats.peakPopulation, stats.population);
    stats.maxGeneration = Math.max(stats.maxGeneration, opts.generation ?? 0);
    this.emit(e.id, { type: "born", parentId: opts.parentId ?? null });
    return e;
  }

  move(e: Entity, to: Vec2): void {
    e.pos = this.clampToWorld(to);
    this.spatial.upsert(e.id, e.pos);
  }

  clampToWorld(p: Vec2): Vec2 {
    return {
      x: Math.min(Math.max(p.x, 0), this.config.width),
      y: Math.min(Math.max(p.y, 0), this.config.height),
    };
  }

  /** Death is deferred to the lifecycle phase so every module sees a consistent tick. */
  kill(e: Entity, cause: DeathCause): void {
    if (!e.alive || this.dyingSet.has(e)) return;
    this.dying.push([e, cause]);
    this.dyingSet.add(e);
  }

  isDying(e: Entity): boolean {
    return this.dyingSet.has(e);
  }

  remove(e: Entity): void {
    e.alive = false;
    this.entities.delete(e.id);
    this.spatial.remove(e.id);
    this.events.delete(e.id);
  }

  /** Remove a living animal without a death (no corpse, no death stats) and queue it to leave. */
  emigrate(e: Entity, from: string): void {
    const speciesId = e.c.species?.speciesId;
    if (!speciesId || !e.alive || this.isDying(e)) return;
    this.outbox.push({ speciesId, radius: e.radius, c: structuredClone(e.c), from });
    const stats = this.getStats(speciesId);
    stats.population--;
    stats.emigrated++;
    this.species.get(speciesId)!.pendingDied.push(e.id);
    this.remove(e);
  }

  takeEmigrants(): Migrant[] {
    return this.outbox.splice(0);
  }

  /** Accept a migrant. The species must already be in this world (add it with population 0). */
  immigrate(m: Migrant, pos: Vec2): Entity | undefined {
    if (!this.species.has(m.speciesId)) throw new Error(`Species ${m.speciesId} is not in this world`);
    const stats = this.getStats(m.speciesId);
    if (stats.population >= this.populationCap(m.speciesId)) return undefined;
    const e = this.spawn("animal", pos, m.radius, structuredClone(m.c));
    if (e.c.motion) e.c.motion.target = null;
    stats.population++;
    stats.immigrated++;
    stats.peakPopulation = Math.max(stats.peakPopulation, stats.population);
    this.emit(e.id, { type: "immigrated", from: m.from });
    return e;
  }

  emit(id: EntityId, event: GameEvent): void {
    this.observer?.onEvent?.(id, event);
    let q = this.events.get(id);
    if (!q) this.events.set(id, (q = []));
    if (q.length < 32) q.push(event);
  }

  // ---- simulation ----

  /** False if any host-side fault made this run non-reproducible. Such results must not be ranked. */
  get valid(): boolean {
    return this.allStats().every((s) => s.hostFaults === 0);
  }

  get finished(): boolean {
    if (this.tick >= this.config.maxTicks) return true;
    return this.initialised && this.species.size > 0 && this.allStats().every((s) => s.population === 0);
  }

  step(): void {
    if (!this.initialised) this.initialise();
    this.tick++;
    this.runPhase("pre");
    const intents = this.decide();
    this.act(intents);
    for (const phase of ["physics", "metabolism", "environment", "lifecycle"] as const) {
      this.runPhase(phase);
      if (phase === "lifecycle") this.processDeaths();
    }
    this.runPhase("post");
    this.processDeaths();
    this.updateStats();
  }

  run(maxSteps = Infinity): void {
    for (let i = 0; i < maxSteps && !this.finished; i++) this.step();
  }

  private initialise(): void {
    this.initialised = true;
    for (const m of this.modules) m.init?.(this);
    const placement = this.rng.fork("placement");
    for (const id of this.speciesIds()) this.spawnInitial(id, this.initialCounts.get(id) ?? 0, placement);
  }

  private runPhase(phase: string): void {
    for (const s of this.systems) if (s.phase === phase) s.run(this);
  }

  private decide(): Array<[Entity, Action | PlantAction]> {
    const intents: Array<[Entity, Action | PlantAction]> = [];
    const organisms = this.organisms();
    const interval = Math.max(1, this.config.plantThinkInterval);
    for (const sp of [...this.species.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (sp.descriptor.diet === "plant" && this.tick % interval !== 0) continue;
      const members = organisms.filter((e) => e.c.species?.speciesId === sp.id);
      if (members.length === 0 && sp.pendingDied.length === 0) continue;
      const input: DecideInput = {
        world: {
          tick: this.tick,
          width: this.config.width,
          height: this.config.height,
          speciesId: sp.id,
          rules: this.ruleIds,
          plantThinkInterval: interval,
        },
        organisms: members.map((e) => this.perceive(e)),
        died: sp.pendingDied.splice(0),
      };
      for (const e of members) this.events.delete(e.id);

      const stats = this.getStats(sp.id);
      const result = sp.controller.decide(input);
      stats.fuelUsed += result.fuelUsed ?? 0;
      if (result.logs?.length) {
        stats.logs.push(...result.logs.map((l) => `[${this.tick}] ${l}`));
        if (stats.logs.length > this.config.maxLogLinesPerSpecies) {
          stats.logs.splice(0, stats.logs.length - this.config.maxLogLinesPerSpecies);
        }
      }
      if (result.error || !result.output) {
        stats.faults++;
        if (result.hostFault) stats.hostFaults++;
        stats.lastError = result.error ?? "no output";
        continue;
      }
      const memberIds = new Set(members.map((e) => e.id));
      const seen = new Set<EntityId>();
      const actions = Array.isArray(result.output.actions) ? result.output.actions : [];
      for (const pair of actions) {
        if (!Array.isArray(pair)) continue;
        const [id, action] = pair as [unknown, unknown];
        // A species may only steer its own living members, once per tick.
        if (typeof id !== "number" || !memberIds.has(id) || seen.has(id)) continue;
        if (typeof action !== "object" || action === null || typeof (action as Action).type !== "string") continue;
        seen.add(id);
        intents.push([this.entities.get(id)!, action as Action]);
      }
    }
    return intents;
  }

  private act(intents: Array<[Entity, Action | PlantAction]>): void {
    // Simultaneous turns: a fresh deterministic order each tick so no species wins ties by id.
    const order = this.rng.fork(`act:${this.tick}`);
    for (const [actor, action] of order.shuffle(intents)) {
      if (!actor.alive || this.isDying(actor)) continue;
      const handler = this.actionHandlers.get(action.type);
      const failure = handler ? handler.handle(this, actor, action) : `unknown action "${action.type}"`;
      this.observer?.onAction?.(actor, action, failure || undefined);
      if (failure) this.emit(actor.id, { type: "actionFailed", action: String(action.type).slice(0, 32), reason: failure });
    }
  }

  perceive(e: Entity): Perception {
    const self = { id: e.id, pos: { ...e.pos }, radius: e.radius } as SelfView & PlantSelfView;
    self.generation = e.c.species?.generation ?? 0;
    self.parentId = e.c.species?.parentId ?? null;
    for (const m of this.modules) m.extendSelf?.(this, e, self);

    const sight = self.sightRadius ?? 0;
    const candidates: Array<[Entity, number]> = [];
    for (const other of this.near(e.pos, sight)) {
      if (other === e || this.isDying(other)) continue;
      const d = dist(e.pos, other.pos);
      if (this.modules.every((m) => m.canSee?.(this, e, other, d) ?? true)) candidates.push([other, d]);
    }
    candidates.sort((a, b) => a[1] - b[1] || a[0].id - b[0].id);

    const visible: VisibleEntity[] = candidates.slice(0, this.config.maxVisible).map(([other, d]) => {
      const view: VisibleEntity = {
        id: other.id,
        kind: other.kind as VisibleEntity["kind"],
        pos: { ...other.pos },
        radius: other.radius,
        distance: d,
      };
      for (const m of this.modules) m.extendVisible?.(this, e, other, view);
      return view;
    });
    return { self, visible, events: this.events.get(e.id) ?? [] };
  }

  private processDeaths(): void {
    while (this.dying.length) {
      const [e, cause] = this.dying.shift()!;
      this.dyingSet.delete(e);
      if (!e.alive) continue;
      for (const m of this.modules) m.onDeath?.(this, e, cause);
      this.observer?.onDeath?.(e, cause);
      const speciesId = e.c.species?.speciesId;
      if (speciesId) {
        const stats = this.getStats(speciesId);
        stats.population--;
        stats.deaths[cause] = (stats.deaths[cause] ?? 0) + 1;
        this.species.get(speciesId)?.pendingDied.push(e.id);
      }
      this.remove(e);
    }
  }

  private updateStats(): void {
    const biomass = new Map<string, number>();
    for (const e of this.organisms()) {
      const id = e.c.species!.speciesId;
      biomass.set(id, (biomass.get(id) ?? 0) + (e.c.energy?.value ?? 0));
    }
    for (const s of this.stats.values()) {
      s.biomass = biomass.get(s.speciesId) ?? 0;
      s.biomassIntegral += s.biomass;
      if (s.population > 0) s.ticksAlive++;
      else if (s.extinctAt === null) s.extinctAt = this.tick;
    }
  }

  // ---- observation ----

  /** Hash of the full simulation state. Equal hashes on two runs prove they were identical. */
  hash(): string {
    let h = fnv1a(`tick:${this.tick}`);
    for (const e of this.entities.values()) {
      h = fnv1a(JSON.stringify([e.id, e.kind, e.pos.x, e.pos.y, e.radius, e.c]), h);
    }
    for (const s of this.allStats()) {
      h = fnv1a(JSON.stringify([s.speciesId, s.population, s.births, s.kills, s.biomassIntegral]), h);
    }
    return h.toString(16).padStart(8, "0");
  }

  snapshot(): { tick: number; entities: Array<Record<string, unknown>> } {
    return {
      tick: this.tick,
      entities: this.all().map((e) => {
        const out: Record<string, unknown> = { id: e.id, kind: e.kind, x: e.pos.x, y: e.pos.y, r: e.radius };
        if (e.c.species) out.species = e.c.species.speciesId;
        for (const m of this.modules) m.snapshot?.(e, out);
        return out;
      }),
    };
  }

  dispose(): void {
    for (const sp of this.species.values()) sp.controller.dispose?.();
  }
}

function orderModules(modules: RuleModule[]): RuleModule[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const out: RuleModule[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (m: RuleModule) => {
    const s = state.get(m.id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`Module dependency cycle at ${m.id}`);
    state.set(m.id, "visiting");
    for (const dep of m.requires ?? []) {
      const d = byId.get(dep);
      if (!d) throw new Error(`Module ${m.id} requires missing module ${dep}`);
      visit(d);
    }
    state.set(m.id, "done");
    out.push(m);
  };
  modules.forEach(visit);
  return out;
}
