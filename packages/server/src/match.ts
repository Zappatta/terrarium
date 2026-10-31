import { STANDARD_RULESET_VERSION, World, standardModules, type RuleModule, type SpeciesStats, type WorldConfig } from "@terrarium/engine";
import { QUICKJS_VERSION, SandboxController, type SandboxLimits } from "@terrarium/sandbox";
import { FitnessTracker, SCORING_VERSION, type FitnessBreakdown } from "./fitness.js";
import { encodeFrame, type Frame } from "./frames.js";

export const ENGINE_VERSION = `${STANDARD_RULESET_VERSION}+quickjs@${QUICKJS_VERSION}`;

export function rulesetModules(ruleset: string): RuleModule[] {
  if (ruleset === STANDARD_RULESET_VERSION) return standardModules();
  throw new Error(`Unknown ruleset ${ruleset}`);
}

export interface EntrantSpec {
  slot: string;
  codeHash: string;
  code: string;
  name: string;
  /** Background species fill the ecosystem but are not scored or rated. */
  ranked: boolean;
}

export type WorldOverrides = Partial<Omit<WorldConfig, "seed">>;

export interface MatchSpec {
  seed: string;
  ruleset: string;
  world: WorldOverrides;
  entrants: EntrantSpec[];
  timelineEvery: number;
  limits?: Partial<SandboxLimits>;
}

export interface TimelinePoint {
  tick: number;
  plants: number;
  population: Record<string, number>;
  biomass: Record<string, number>;
}

export interface EntrantResult {
  slot: string;
  codeHash: string;
  name: string;
  ranked: boolean;
  /** 0-100 fitness, see fitness.ts. */
  score: number;
  breakdown: FitnessBreakdown;
  /** 1 = best among ranked entrants. Ties share a rank. */
  rank: number | null;
  stats: SpeciesStats;
}

export interface MatchResult {
  engine: string;
  scoring: string;
  ticks: number;
  maxTicks: number;
  hash: string;
  valid: boolean;
  durationMs: number;
  entrants: EntrantResult[];
  timeline: TimelinePoint[];
}

export interface RunHooks {
  frameEvery?: number;
  frameFrom?: number;
  frameTo?: number;
  onFrame?(frame: Frame): void;
  onProgress?(tick: number): void;
  /** Stop early (partial replays). The result then reflects the truncated run. */
  stopAfter?: number;
}

export async function buildWorld(spec: MatchSpec): Promise<World> {
  const world = new World(rulesetModules(spec.ruleset), { ...spec.world, seed: spec.seed });
  try {
    for (const e of spec.entrants) {
      world.addSpecies(e.slot, await SandboxController.create({ code: e.code, codeHash: e.codeHash }, { limits: spec.limits }));
    }
  } catch (err) {
    world.dispose();
    throw err;
  }
  return world;
}

export async function runMatch(spec: MatchSpec, hooks: RunHooks = {}): Promise<MatchResult> {
  const slots = new Set(spec.entrants.map((e) => e.slot));
  if (slots.size !== spec.entrants.length) throw new Error("Duplicate entrant slot");
  const world = await buildWorld(spec);
  const t0 = performance.now();
  const timeline: TimelinePoint[] = [];
  const fitness = new FitnessTracker(world);
  const sample = () => {
    const population: Record<string, number> = {};
    const biomass: Record<string, number> = {};
    for (const s of world.allStats()) population[s.speciesId] = s.population;
    for (const e of world.all("animal")) {
      const id = e.c.species!.speciesId;
      biomass[id] = Math.round((biomass[id] ?? 0) + (e.c.energy?.value ?? 0));
    }
    timeline.push({ tick: world.tick, plants: world.count("plant"), population, biomass });
  };

  try {
    const every = hooks.frameEvery ?? 1;
    const from = hooks.frameFrom ?? 0;
    const to = hooks.frameTo ?? Infinity;
    while (!world.finished) {
      world.step();
      fitness.sample();
      if (spec.timelineEvery > 0 && world.tick % spec.timelineEvery === 0) sample();
      if (hooks.onFrame && world.tick >= from && world.tick <= to && world.tick % every === 0) {
        hooks.onFrame(encodeFrame(world));
      }
      if (hooks.onProgress && world.tick % 250 === 0) hooks.onProgress(world.tick);
      if (hooks.stopAfter !== undefined && world.tick >= hooks.stopAfter) break;
    }
    if (timeline.at(-1)?.tick !== world.tick) sample();

    const maxTicks = world.config.maxTicks;
    const entrants: EntrantResult[] = spec.entrants.map((e) => ({
      slot: e.slot,
      codeHash: e.codeHash,
      name: e.name,
      ranked: e.ranked,
      ...fitness.score(e.slot),
      rank: null,
      stats: world.getStats(e.slot),
    }));
    assignRanks(entrants);
    return {
      engine: ENGINE_VERSION,
      scoring: SCORING_VERSION,
      ticks: world.tick,
      maxTicks,
      hash: world.hash(),
      valid: world.valid,
      durationMs: Math.round(performance.now() - t0),
      entrants,
      timeline,
    };
  } finally {
    world.dispose();
  }
}

function assignRanks(entrants: EntrantResult[]): void {
  const ranked = entrants.filter((e) => e.ranked).sort((a, b) => b.score - a.score);
  ranked.forEach((e, i) => {
    e.rank = i > 0 && ranked[i - 1]!.score === e.score ? ranked[i - 1]!.rank : i + 1;
  });
}
