import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { STANDARD_RULESET_VERSION } from "@terrarium/engine";
import { now, type Db, type MatchRecord, type RunKind, type RunRecord, type RunSpec, type StoredMatchSpec } from "./db.js";
import { UserError } from "./errors.js";
import type { MatchResult, MatchSpec, WorldOverrides } from "./match.js";
import type { Registry } from "./registry.js";
import { applyElo, summarise } from "./scoring.js";
import type { BatchPool } from "./workers/pool.js";
import type { ReplayResult } from "./workers/protocol.js";

export interface RunRequest {
  kind: RunKind;
  createdBy?: string | null;
  name?: string;
  entrants: string[];
  background?: string[];
  format?: "ffa" | "round-robin";
  /** A count, or explicit seeds. */
  seeds?: number | string[];
  world?: WorldOverrides;
  /** Ranked runs update this ladder's ratings when they finish. */
  ladder?: string | null;
  timelineEvery?: number;
}

export const MAX_MATCHES_PER_RUN = 500;
export const MAX_ENTRANTS_PER_MATCH = 12;

export class RunService {
  private readonly events = new EventEmitter();
  private readonly progress = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    private readonly pool: BatchPool,
    readonly ruleset = STANDARD_RULESET_VERSION,
  ) {
    this.events.setMaxListeners(0);
  }

  create(req: RunRequest): RunRecord {
    const id = randomUUID();
    const entrants = dedupe(req.entrants.map((r) => this.registry.resolve(r).codeHash));
    if (entrants.length === 0) throw new UserError("At least one entrant is required");
    const background = dedupe((req.background ?? []).map((r) => this.registry.resolve(r).codeHash)).filter(
      (h) => !entrants.includes(h),
    );
    const format = req.format ?? "ffa";
    const seeds = resolveSeeds(req, id);

    const groups = format === "ffa" ? [entrants] : pairs(entrants);
    if (format === "round-robin" && entrants.length < 2) throw new UserError("round-robin needs at least two entrants");
    if (groups.some((g) => g.length + background.length > MAX_ENTRANTS_PER_MATCH)) {
      throw new UserError(`At most ${MAX_ENTRANTS_PER_MATCH} species per match (entrants + background)`);
    }
    const total = groups.length * seeds.length;
    if (total > MAX_MATCHES_PER_RUN) throw new UserError(`Run would have ${total} matches, the limit is ${MAX_MATCHES_PER_RUN}`);

    const spec: RunSpec = {
      name: req.name ?? `${req.kind} ${new Date().toISOString()}`,
      format,
      entrants,
      background,
      seeds,
      ladder: req.ladder ?? null,
    };
    const createdAt = now();
    const matches: MatchRecord[] = [];
    for (const seed of seeds) {
      for (const group of groups) {
        const matchSpec: StoredMatchSpec = {
          seed,
          ruleset: this.ruleset,
          world: req.world ?? {},
          timelineEvery: req.timelineEvery ?? 50,
          entrants: [
            ...group.map((h, i) => ({ slot: `e${i}`, codeHash: h, name: this.registry.resolve(h).name, ranked: true })),
            ...background.map((h, i) => ({ slot: `b${i}`, codeHash: h, name: this.registry.resolve(h).name, ranked: false })),
          ],
        };
        matches.push({ id: randomUUID(), runId: id, index: matches.length, status: "queued", spec: matchSpec, result: null, error: null, createdAt, finishedAt: null });
      }
    }
    const run: RunRecord = { id, kind: req.kind, createdBy: req.createdBy ?? null, status: "queued", spec, summary: null, error: null, matchesTotal: matches.length, matchesDone: 0, createdAt, finishedAt: null };
    this.db.insertRun(run, matches);
    void this.execute(id);
    return this.db.getRun(id)!;
  }

  get(id: string): RunRecord {
    const run = this.db.getRun(id);
    if (!run) throw new UserError(`Unknown run ${id}`, 404);
    return run;
  }

  /** Resolves when the run finishes or the timeout passes, whichever is first. */
  async waitFor(id: string, timeoutMs: number): Promise<RunRecord> {
    const run = this.get(id);
    if (run.status === "done" || run.status === "failed") return run;
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.events.once(`finished:${id}`, done);
    });
    return this.get(id);
  }

  /** Re-queue runs interrupted by a restart. Matches are deterministic, so re-running is safe. */
  resume(): number {
    const runs = this.db.unfinishedRuns();
    for (const r of runs) void this.execute(r.id);
    return runs.length;
  }

  liveProgress(matchId: string): number | undefined {
    return this.progress.get(matchId);
  }

  async replay(matchId: string, opts: { from: number; to: number; every: number }): Promise<ReplayResult & { verified: boolean | null }> {
    const m = this.db.getMatch(matchId);
    if (!m) throw new UserError(`Unknown match ${matchId}`, 404);
    if (m.status !== "done" || !m.result) throw new UserError("Match has not finished");
    const frames = (opts.to - opts.from) / opts.every;
    if (frames > 2000) throw new UserError("Replay window too large: at most 2000 frames per request");
    const out = (await this.pool.run({ kind: "replay", spec: this.hydrate(m.spec), ...opts })) as ReplayResult;
    return { ...out, verified: out.complete ? out.hash === m.result.hash : null };
  }

  private hydrate(spec: StoredMatchSpec): MatchSpec {
    return {
      ...spec,
      entrants: spec.entrants.map((e) => ({ ...e, code: this.registry.resolve(e.codeHash).code })),
    };
  }

  private async execute(runId: string): Promise<void> {
    this.db.setRunStatus(runId, "running");
    const matches = this.db.runMatches(runId);
    await Promise.all(
      matches
        .filter((m) => m.status !== "done")
        .map(async (m) => {
          this.db.setMatchStatus(m.id, "running");
          try {
            const result = (await this.pool.run({ kind: "match", spec: this.hydrate(m.spec) }, (tick) =>
              this.progress.set(m.id, tick),
            )) as MatchResult;
            this.db.setMatchStatus(m.id, "done", { result });
          } catch (e) {
            this.db.setMatchStatus(m.id, "failed", { error: e instanceof Error ? e.message : String(e) });
          } finally {
            this.progress.delete(m.id);
          }
        }),
    );
    this.finish(runId);
  }

  private finish(runId: string): void {
    const run = this.get(runId);
    const matches = this.db.runMatches(runId);
    const results = matches.flatMap((m) => (m.result ? [m.result] : []));
    const failed = matches.filter((m) => m.status === "failed");
    const invalid = results.filter((r) => !r.valid).length;
    const notes = [
      failed.length ? `${failed.length} match(es) failed: ${failed[0]!.error}` : "",
      invalid ? `${invalid} match(es) hit host faults and were not rated` : "",
    ].filter(Boolean);

    if (results.length === 0) {
      this.db.setRunStatus(runId, "failed", { error: notes.join("; ") || "no results" });
    } else {
      if (run.spec.ladder) {
        // Apply in match order, not completion order, so ratings never depend on scheduling.
        this.db.transaction(() => {
          const hashes = dedupe(results.flatMap((r) => r.entrants.filter((e) => e.ranked).map((e) => e.codeHash)));
          const ratings = this.db.getRatings(run.spec.ladder!, hashes);
          for (const r of results) applyElo(ratings, r);
          this.db.saveRatings(run.spec.ladder!, ratings);
        });
      }
      this.db.setRunStatus(runId, "done", { summary: summarise(results), error: notes.length ? notes.join("; ") : undefined });
    }
    this.events.emit(`finished:${runId}`);
  }
}

function resolveSeeds(req: RunRequest, runId: string): string[] {
  if (Array.isArray(req.seeds)) {
    if (req.seeds.length === 0) throw new UserError("seeds must not be empty");
    return dedupe(req.seeds.map(String));
  }
  const n = req.seeds ?? (req.kind === "match" ? 1 : 5);
  if (!Number.isInteger(n) || n < 1) throw new UserError("seeds must be a positive integer or a list of seeds");
  // Evaluations use a fixed bench so an agent can compare versions of its creature like for like.
  // Tournaments use fresh seeds so nobody can tune for them in advance.
  const prefix = req.kind === "evaluation" ? "bench" : runId;
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

function pairs<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) out.push([items[i]!, items[j]!]);
  return out;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
