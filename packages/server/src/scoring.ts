import type { MatchResult } from "./match.js";

export const INITIAL_RATING = 1500;

export interface RatingState {
  rating: number;
  matches: number;
}

/**
 * Multiplayer Elo: each match is treated as every pairwise duel between ranked entrants, with K
 * split across opponents so a 6-way match moves ratings about as much as a 1v1.
 */
export function applyElo(ratings: Map<string, RatingState>, result: MatchResult, k = 32): void {
  const ranked = result.entrants.filter((e) => e.ranked && e.rank !== null);
  if (ranked.length < 2 || !result.valid) return;
  const get = (h: string) => {
    let r = ratings.get(h);
    if (!r) ratings.set(h, (r = { rating: INITIAL_RATING, matches: 0 }));
    return r;
  };
  const before = new Map(ranked.map((e) => [e.codeHash, get(e.codeHash).rating]));
  const kEach = k / (ranked.length - 1);
  for (const a of ranked) {
    let delta = 0;
    for (const b of ranked) {
      if (a === b) continue;
      const expected = 1 / (1 + 10 ** ((before.get(b.codeHash)! - before.get(a.codeHash)!) / 400));
      const actual = a.rank! < b.rank! ? 1 : a.rank === b.rank ? 0.5 : 0;
      delta += kEach * (actual - expected);
    }
    const r = get(a.codeHash);
    r.rating += delta;
    r.matches++;
  }
}

export interface EntrantSummary {
  codeHash: string;
  name: string;
  /** Unranked rows are background species, included as a reference point. */
  ranked: boolean;
  matches: number;
  meanScore: number;
  meanRank: number | null;
  wins: number;
  survivalRate: number;
  scores: number[];
  /** Mean of each fitness component across matches. */
  breakdown: Record<string, number>;
}

export function summarise(results: MatchResult[]): EntrantSummary[] {
  const by = new Map<string, EntrantSummary & { rankSum: number; rankCount: number; survived: number }>();
  for (const r of results) {
    for (const e of r.entrants) {
      let s = by.get(e.codeHash);
      if (!s) {
        s = { codeHash: e.codeHash, name: e.name, ranked: e.ranked, matches: 0, meanScore: 0, meanRank: null, wins: 0, survivalRate: 0, scores: [], breakdown: {}, rankSum: 0, rankCount: 0, survived: 0 };
        by.set(e.codeHash, s);
      }
      s.matches++;
      s.scores.push(e.score);
      for (const [k, v] of Object.entries(e.breakdown)) s.breakdown[k] = (s.breakdown[k] ?? 0) + v;
      if (e.rank !== null) {
        s.rankSum += e.rank;
        s.rankCount++;
        if (e.rank === 1) s.wins++;
      }
      if (e.stats.population > 0) s.survived++;
    }
  }
  return [...by.values()]
    .map(({ rankSum, rankCount, survived, ...s }) => ({
      ...s,
      meanScore: Math.round((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 100) / 100,
      breakdown: Object.fromEntries(Object.entries(s.breakdown).map(([k, v]) => [k, Math.round((v / s.matches) * 1000) / 1000])),
      meanRank: rankCount ? rankSum / rankCount : null,
      survivalRate: survived / s.matches,
    }))
    .sort((a, b) => Number(b.ranked) - Number(a.ranked) || b.meanScore - a.meanScore);
}
