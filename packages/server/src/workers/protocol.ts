import type { Migrant, SpeciesStats, WorldConfig } from "@terrarium/engine";
import type { Frame } from "../frames.js";
import type { EntrantSpec, MatchResult, MatchSpec } from "../match.js";

export type BatchJob =
  | { kind: "match"; spec: MatchSpec }
  | { kind: "replay"; spec: MatchSpec; from: number; to: number; every: number };

export interface ReplayResult {
  frames: Frame[];
  /** Hash at the end of the replayed run. Equals the recorded hash when the replay ran to the end. */
  hash: string;
  ticks: number;
  complete: boolean;
}

export type BatchOutput = MatchResult | ReplayResult;

export type BatchRequest = { jobId: number; job: BatchJob };
export type BatchResponse =
  | { jobId: number; type: "progress"; tick: number }
  | { jobId: number; type: "done"; output: BatchOutput }
  | { jobId: number; type: "error"; error: string };

export interface LiveWorkerData {
  worldId: string;
  name: string;
  ruleset: string;
  config: Partial<WorldConfig>;
  tps: number;
  migration: boolean;
  /** Ticks after a species dies out before a few founders recolonise. 0 disables it. */
  recolonizeAfter: number;
}

export interface LiveSpeciesInfo {
  slot: string;
  codeHash: string;
  name: string;
  diet: string;
}

export type LiveCommand =
  | { type: "addSpecies"; entrant: EntrantSpec; population: number }
  | { type: "immigrate"; entrant: EntrantSpec; migrant: Migrant }
  | { type: "control"; action: "pause" | "resume" | "step"; }
  | { type: "setTps"; tps: number }
  | { type: "stop" };

export type LiveEvent =
  | { type: "ready" }
  | { type: "frame"; frame: Frame }
  | { type: "species"; species: LiveSpeciesInfo[] }
  | { type: "stats"; tick: number; stats: SpeciesStats[]; plants: number; tps: number; paused: boolean }
  | { type: "emigrants"; migrants: Array<{ codeHash: string; migrant: Migrant }> }
  | { type: "speciesError"; codeHash: string; error: string }
  | { type: "notice"; tick: number; message: string }
  | { type: "fatal"; error: string };
