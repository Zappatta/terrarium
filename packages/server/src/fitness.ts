import { floraParams, metabolismParams, reproductionParams, type World } from "@terrarium/engine";

/**
 * What "best creature" means. Bump the version whenever the formula or weights change: ladders are
 * keyed by it, so ratings earned under different definitions never mix.
 */
export const SCORING_VERSION = "fitness@1";

export const FITNESS_WEIGHTS = { survival: 0.3, dominance: 0.35, lineage: 0.2, finish: 0.15 } as const;

export type FitnessBreakdown = Record<keyof typeof FITNESS_WEIGHTS, number>;

/** Per-tick accumulation for the parts of fitness that depend on the whole history of a match. */
export class FitnessTracker {
  private readonly shareSum = new Map<string, number>();

  constructor(private readonly world: World) {}

  /** Call once after every tick. */
  sample(): void {
    const byDiet = new Map<string, number>();
    const stats = this.world.allStats();
    for (const s of stats) byDiet.set(s.diet, (byDiet.get(s.diet) ?? 0) + s.biomass);
    for (const s of stats) {
      const total = byDiet.get(s.diet)!;
      const share = total > 0 ? s.biomass / total : 0;
      this.shareSum.set(s.speciesId, (this.shareSum.get(s.speciesId) ?? 0) + share);
    }
  }

  breakdown(speciesId: string): FitnessBreakdown {
    const w = this.world;
    const s = w.getStats(speciesId);
    const maxTicks = w.config.maxTicks;
    const generationTime =
      s.diet === "plant" ? floraParams(w).matureAt : metabolismParams(w).matureAt + reproductionParams(w).gestation;
    const possibleGenerations = Math.max(1, Math.floor(maxTicks / generationTime));
    const founders = Math.max(1, s.diet === "plant" ? w.config.initialPlantPopulation : w.config.initialPopulation);
    return {
      // Ticks after an early end (everyone extinct) count as dead, never as a free pass.
      survival: s.ticksAlive / maxTicks,
      dominance: (this.shareSum.get(speciesId) ?? 0) / maxTicks,
      lineage: Math.min(1, s.maxGeneration / possibleGenerations),
      finish: Math.min(1, s.population / founders),
    };
  }

  score(speciesId: string): { score: number; breakdown: FitnessBreakdown } {
    const breakdown = this.breakdown(speciesId);
    let total = 0;
    for (const k of Object.keys(FITNESS_WEIGHTS) as Array<keyof FitnessBreakdown>) total += FITNESS_WEIGHTS[k] * breakdown[k];
    const round = (v: number) => Math.round(v * 10000) / 10000;
    return {
      score: Math.round(total * 100 * 100) / 100,
      breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, round(v)])) as FitnessBreakdown,
    };
  }
}
