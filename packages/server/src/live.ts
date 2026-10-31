import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { STANDARD_RULESET_VERSION, type SpeciesStats } from "@terrarium/engine";
import { UserError } from "./errors.js";
import type { Frame } from "./frames.js";
import type { WorldOverrides } from "./match.js";
import type { Registry } from "./registry.js";
import { spawnWorker } from "./workers/spawn.js";
import type { FocusDetail, LiveCommand, LiveEvent, LiveSpeciesInfo, LiveWorkerData } from "./workers/protocol.js";

export type LiveMessage =
  | { type: "species"; species: LiveSpeciesInfo[] }
  | { type: "frame"; frame: Frame }
  | { type: "stats"; tick: number; stats: SpeciesStats[]; plants: number; tps: number; paused: boolean }
  | { type: "error"; error: string }
  | { type: "notice"; tick: number; message: string }
  | { type: "focus"; tick: number; details: FocusDetail[] };

export interface CreateLiveWorld {
  name?: string;
  world?: WorldOverrides & { seed?: string };
  tps?: number;
  migration?: boolean;
  recolonizeAfter?: number;
}

interface Subscriber {
  send(msg: LiveMessage): void;
  follow: number | null;
}

export interface Subscription {
  unsubscribe(): void;
  /** Follow one organism (or stop with null). Its full state then arrives as "focus" messages. */
  follow(id: number | null): void;
}

class LiveWorld {
  species: LiveSpeciesInfo[] = [];
  lastFrame: Frame | null = null;
  lastStats: Extract<LiveMessage, { type: "stats" }> | null = null;
  errors: string[] = [];
  notices: Array<{ tick: number; message: string }> = [];
  stopped = false;
  readonly subscribers = new Set<Subscriber>();
  readonly createdAt = new Date().toISOString();

  constructor(readonly id: string, readonly name: string, readonly migration: boolean, readonly worker: Worker) {}

  send(cmd: LiveCommand): void {
    if (!this.stopped) this.worker.postMessage(cmd);
  }

  broadcast(msg: LiveMessage): void {
    for (const s of this.subscribers) s.send(msg);
  }

  syncFollows(): void {
    const ids = [...new Set([...this.subscribers].flatMap((s) => (s.follow === null ? [] : [s.follow])))];
    this.send({ type: "follow", ids });
  }

  routeFocus(msg: { type: "focus"; tick: number; details: FocusDetail[] }): void {
    for (const s of this.subscribers) {
      if (s.follow === null) continue;
      const mine = msg.details.filter((d) => d.id === s.follow);
      if (mine.length) s.send({ type: "focus", tick: msg.tick, details: mine });
    }
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      migration: this.migration,
      createdAt: this.createdAt,
      stopped: this.stopped,
      tick: this.lastStats?.tick ?? this.lastFrame?.tick ?? 0,
      tps: this.lastStats?.tps,
      paused: this.lastStats?.paused ?? false,
      plants: this.lastStats?.plants,
      species: this.species.map((s) => ({
        ...s,
        population: this.lastStats?.stats.find((x) => x.speciesId === s.slot)?.population ?? 0,
      })),
      spectators: this.subscribers.size,
      errors: this.errors.slice(-10),
      notices: this.notices.slice(-10),
    };
  }
}

/** Shared, never-ending worlds. Each runs in its own worker; organisms can migrate between them. */
export class LiveManager {
  private readonly worlds = new Map<string, LiveWorld>();

  constructor(private readonly registry: Registry, private readonly maxWorlds = 16) {}

  create(req: CreateLiveWorld) {
    if ([...this.worlds.values()].filter((w) => !w.stopped).length >= this.maxWorlds) {
      throw new UserError(`At most ${this.maxWorlds} live worlds`, 429);
    }
    const id = randomUUID().slice(0, 8);
    const data: LiveWorkerData = {
      worldId: id,
      name: req.name ?? `world-${id}`,
      ruleset: STANDARD_RULESET_VERSION,
      config: req.world ?? {},
      tps: req.tps ?? 10,
      migration: req.migration ?? true,
      recolonizeAfter: req.recolonizeAfter ?? 500,
    };
    const world = new LiveWorld(id, data.name, data.migration, spawnWorker(new URL("./workers/live-worker.ts", import.meta.url), data));
    world.worker.on("message", (m: LiveEvent) => this.onEvent(world, m));
    world.worker.on("error", (e) => this.fail(world, e instanceof Error ? e.message : String(e)));
    world.worker.on("exit", () => {
      world.stopped = true;
    });
    this.worlds.set(id, world);
    return world.info();
  }

  list() {
    return [...this.worlds.values()].map((w) => w.info());
  }

  get(id: string) {
    return this.world(id).info();
  }

  addSpecies(id: string, ref: string, population = 10): void {
    const w = this.world(id);
    const creature = this.registry.resolve(ref);
    w.send({ type: "addSpecies", entrant: this.registry.entrant(creature, slotFor(creature.codeHash), false), population });
  }

  control(id: string, action: "pause" | "resume" | "step"): void {
    this.world(id).send({ type: "control", action });
  }

  setTps(id: string, tps: number): void {
    this.world(id).send({ type: "setTps", tps });
  }

  subscribe(id: string, fn: (msg: LiveMessage) => void): Subscription {
    const w = this.world(id);
    fn({ type: "species", species: w.species });
    if (w.lastStats) fn(w.lastStats);
    if (w.lastFrame) fn({ type: "frame", frame: w.lastFrame });
    const sub: Subscriber = { send: fn, follow: null };
    w.subscribers.add(sub);
    return {
      unsubscribe: () => {
        w.subscribers.delete(sub);
        if (sub.follow !== null) w.syncFollows();
      },
      follow: (target) => {
        sub.follow = target;
        w.syncFollows();
      },
    };
  }

  async stop(id: string): Promise<void> {
    const w = this.world(id);
    w.send({ type: "stop" });
    w.stopped = true;
    await w.worker.terminate();
    w.subscribers.clear();
    this.worlds.delete(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.worlds.keys()].map((id) => this.stop(id)));
  }

  private world(id: string): LiveWorld {
    const w = this.worlds.get(id);
    if (!w) throw new UserError(`Unknown live world ${id}`, 404);
    return w;
  }

  private fail(w: LiveWorld, error: string): void {
    w.errors.push(error);
    w.broadcast({ type: "error", error });
  }

  private onEvent(w: LiveWorld, m: LiveEvent): void {
    switch (m.type) {
      case "frame":
        w.lastFrame = m.frame;
        return w.broadcast(m);
      case "stats":
        w.lastStats = m;
        return w.broadcast(m);
      case "species":
        w.species = m.species;
        return w.broadcast(m);
      case "speciesError":
        return this.fail(w, `species ${m.codeHash.slice(0, 12)}: ${m.error}`);
      case "fatal":
        return this.fail(w, m.error);
      case "emigrants":
        for (const { codeHash, migrant } of m.migrants) {
          const targets = [...this.worlds.values()].filter((x) => x !== w && x.migration && !x.stopped);
          // Nowhere to go: the organism wraps round into its own world.
          const dest = targets.length ? targets[Math.floor(Math.random() * targets.length)]! : w;
          const creature = this.registry.resolve(codeHash);
          dest.send({ type: "immigrate", entrant: this.registry.entrant(creature, slotFor(codeHash), false), migrant });
        }
        return;
      case "focus":
        return w.routeFocus(m);
      case "notice":
        w.notices.push({ tick: m.tick, message: m.message });
        if (w.notices.length > 50) w.notices.shift();
        return w.broadcast(m);
      case "ready":
        return;
    }
  }
}

/** Same creature, same slot in every live world, so migrants land in their own species. */
const slotFor = (codeHash: string) => `c${codeHash.slice(0, 12)}`;
