import { DatabaseSync } from "node:sqlite";
import type { Diet, Traits } from "@terrarium/sdk";
import type { MatchResult, MatchSpec } from "./match.js";
import type { EntrantSummary, RatingState } from "./scoring.js";

export interface CreatureRecord {
  codeHash: string;
  name: string;
  diet: Diet;
  traits: Traits;
  author: string | null;
  description: string | null;
  builtin: boolean;
  createdAt: string;
}

export interface CreatureWithCode extends CreatureRecord {
  source: string;
  code: string;
}

export type RunKind = "match" | "evaluation" | "tournament";
export type Status = "queued" | "running" | "done" | "failed";

/** Match spec as stored: entrant code is looked up by hash rather than duplicated per match. */
export type StoredMatchSpec = Omit<MatchSpec, "entrants"> & { entrants: Array<Omit<MatchSpec["entrants"][number], "code">> };

export interface MatchRecord {
  id: string;
  runId: string;
  index: number;
  status: Status;
  spec: StoredMatchSpec;
  result: MatchResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunSpec {
  name: string;
  format: "ffa" | "round-robin";
  entrants: string[];
  background: string[];
  seeds: string[];
  ladder: string | null;
}

export interface RunRecord {
  id: string;
  kind: RunKind;
  status: Status;
  spec: RunSpec;
  summary: EntrantSummary[] | null;
  error: string | null;
  matchesTotal: number;
  matchesDone: number;
  createdAt: string;
  finishedAt: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creatures (
  code_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  diet TEXT NOT NULL,
  traits TEXT NOT NULL,
  author TEXT,
  description TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  spec TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  idx INTEGER NOT NULL,
  status TEXT NOT NULL,
  spec TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS matches_run ON matches(run_id, idx);
CREATE TABLE IF NOT EXISTS ratings (
  ladder TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  rating REAL NOT NULL,
  matches INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ladder, code_hash)
);
`;

const now = () => new Date().toISOString();
const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;
type Row = Record<string, unknown>;

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
  }

  close(): void {
    this.sql.close();
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN");
    try {
      const out = fn();
      this.sql.exec("COMMIT");
      return out;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- creatures ----

  insertCreature(c: CreatureWithCode): void {
    this.sql
      .prepare(
        `INSERT OR IGNORE INTO creatures (code_hash, name, diet, traits, author, description, builtin, source, code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.codeHash, c.name, c.diet, JSON.stringify(c.traits), c.author, c.description, c.builtin ? 1 : 0, c.source, c.code, c.createdAt);
  }

  /** Exactly these creatures are builtin; earlier versions keep their records but lose the flag. */
  setBuiltins(hashes: string[]): void {
    this.transaction(() => {
      this.sql.prepare("UPDATE creatures SET builtin = 0 WHERE builtin = 1").run();
      const q = this.sql.prepare("UPDATE creatures SET builtin = 1 WHERE code_hash = ?");
      for (const h of hashes) q.run(h);
    });
  }

  getCreature(hash: string): CreatureWithCode | undefined {
    const row = this.sql.prepare("SELECT * FROM creatures WHERE code_hash = ?").get(hash) as Row | undefined;
    return row && { ...creatureFromRow(row), source: String(row.source), code: String(row.code) };
  }

  /** Accepts a full hash or a unique prefix of at least 8 characters. */
  resolveCreature(ref: string): CreatureWithCode | undefined {
    const exact = this.getCreature(ref);
    if (exact || ref.length < 8 || !/^[0-9a-f]+$/.test(ref)) return exact;
    const rows = this.sql.prepare("SELECT code_hash FROM creatures WHERE code_hash LIKE ? LIMIT 2").all(`${ref}%`) as Row[];
    return rows.length === 1 ? this.getCreature(String(rows[0]!.code_hash)) : undefined;
  }

  listCreatures(opts: { author?: string; builtin?: boolean; limit?: number } = {}): CreatureRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.author) {
      where.push("author = ?");
      args.push(opts.author);
    }
    if (opts.builtin !== undefined) {
      where.push("builtin = ?");
      args.push(opts.builtin ? 1 : 0);
    }
    const sql = `SELECT code_hash, name, diet, traits, author, description, builtin, created_at FROM creatures
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    return (this.sql.prepare(sql).all(...args, opts.limit ?? 100) as Row[]).map(creatureFromRow);
  }

  // ---- runs & matches ----

  insertRun(run: RunRecord, matches: MatchRecord[]): void {
    this.transaction(() => {
      this.sql
        .prepare("INSERT INTO runs (id, kind, status, spec, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(run.id, run.kind, run.status, JSON.stringify(run.spec), run.createdAt);
      const ins = this.sql.prepare(
        "INSERT INTO matches (id, run_id, idx, status, spec, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const m of matches) ins.run(m.id, m.runId, m.index, m.status, JSON.stringify(m.spec), m.createdAt);
    });
  }

  setRunStatus(id: string, status: Status, extra: { summary?: EntrantSummary[]; error?: string } = {}): void {
    const finished = status === "done" || status === "failed" ? now() : null;
    this.sql
      .prepare("UPDATE runs SET status = ?, summary = COALESCE(?, summary), error = COALESCE(?, error), finished_at = COALESCE(?, finished_at) WHERE id = ?")
      .run(status, extra.summary ? JSON.stringify(extra.summary) : null, extra.error ?? null, finished, id);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.sql
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM matches m WHERE m.run_id = r.id) AS total,
                (SELECT COUNT(*) FROM matches m WHERE m.run_id = r.id AND m.status IN ('done', 'failed')) AS done
         FROM runs r WHERE r.id = ?`,
      )
      .get(id) as Row | undefined;
    return row && runFromRow(row);
  }

  listRuns(opts: { kind?: RunKind; limit?: number } = {}): RunRecord[] {
    const rows = this.sql
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM matches m WHERE m.run_id = r.id) AS total,
                (SELECT COUNT(*) FROM matches m WHERE m.run_id = r.id AND m.status IN ('done', 'failed')) AS done
         FROM runs r ${opts.kind ? "WHERE r.kind = ?" : ""} ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(...(opts.kind ? [opts.kind] : []), opts.limit ?? 50) as Row[];
    return rows.map(runFromRow);
  }

  unfinishedRuns(): RunRecord[] {
    return (this.sql.prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')").all() as Row[]).map(
      (r) => this.getRun(String(r.id))!,
    );
  }

  setMatchStatus(id: string, status: Status, extra: { result?: MatchResult; error?: string } = {}): void {
    const finished = status === "done" || status === "failed" ? now() : null;
    this.sql
      .prepare("UPDATE matches SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, extra.result ? JSON.stringify(extra.result) : null, extra.error ?? null, finished, id);
  }

  getMatch(id: string): MatchRecord | undefined {
    const row = this.sql.prepare("SELECT * FROM matches WHERE id = ?").get(id) as Row | undefined;
    return row && matchFromRow(row);
  }

  recentMatches(limit = 20): Array<{ id: string; runId: string; kind: string; seed: string; finishedAt: string; ticks: number; entrants: Array<{ name: string; score: number; ranked: boolean }> }> {
    const rows = this.sql
      .prepare(
        `SELECT m.id, m.run_id, r.kind, m.spec, m.result, m.finished_at FROM matches m JOIN runs r ON r.id = m.run_id
         WHERE m.status = 'done' ORDER BY m.finished_at DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => {
      const result = json<MatchResult>(r.result);
      return {
        id: String(r.id),
        runId: String(r.run_id),
        kind: String(r.kind),
        seed: json<StoredMatchSpec>(r.spec).seed,
        finishedAt: String(r.finished_at),
        ticks: result.ticks,
        entrants: result.entrants.map((e) => ({ name: e.name, score: e.score, ranked: e.ranked })),
      };
    });
  }

  runMatches(runId: string): MatchRecord[] {
    return (this.sql.prepare("SELECT * FROM matches WHERE run_id = ? ORDER BY idx").all(runId) as Row[]).map(matchFromRow);
  }

  // ---- ratings ----

  getRatings(ladder: string, hashes: string[]): Map<string, RatingState> {
    const out = new Map<string, RatingState>();
    const q = this.sql.prepare("SELECT rating, matches FROM ratings WHERE ladder = ? AND code_hash = ?");
    for (const h of hashes) {
      const row = q.get(ladder, h) as Row | undefined;
      if (row) out.set(h, { rating: Number(row.rating), matches: Number(row.matches) });
    }
    return out;
  }

  saveRatings(ladder: string, ratings: Map<string, RatingState>): void {
    const q = this.sql.prepare(
      `INSERT INTO ratings (ladder, code_hash, rating, matches, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ladder, code_hash) DO UPDATE SET rating = excluded.rating, matches = excluded.matches, updated_at = excluded.updated_at`,
    );
    const ts = now();
    for (const [h, r] of ratings) q.run(ladder, h, r.rating, r.matches, ts);
  }

  leaderboard(ladder: string, limit = 100): Array<RatingState & { codeHash: string; name: string; author: string | null }> {
    const rows = this.sql
      .prepare(
        `SELECT r.code_hash, r.rating, r.matches, c.name, c.author FROM ratings r JOIN creatures c ON c.code_hash = r.code_hash
         WHERE r.ladder = ? ORDER BY r.rating DESC LIMIT ?`,
      )
      .all(ladder, limit) as Row[];
    return rows.map((r) => ({
      codeHash: String(r.code_hash),
      name: String(r.name),
      author: r.author === null ? null : String(r.author),
      rating: Math.round(Number(r.rating) * 10) / 10,
      matches: Number(r.matches),
    }));
  }

  ladders(): Array<{ ladder: string; entrants: number }> {
    return (this.sql.prepare("SELECT ladder, COUNT(*) AS n FROM ratings GROUP BY ladder ORDER BY ladder").all() as Row[]).map((r) => ({
      ladder: String(r.ladder),
      entrants: Number(r.n),
    }));
  }
}

function creatureFromRow(row: Row): CreatureRecord {
  return {
    codeHash: String(row.code_hash),
    name: String(row.name),
    diet: String(row.diet) as Diet,
    traits: json(row.traits),
    author: row.author === null ? null : String(row.author),
    description: row.description === null ? null : String(row.description),
    builtin: Number(row.builtin) === 1,
    createdAt: String(row.created_at),
  };
}

function runFromRow(row: Row): RunRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as RunKind,
    status: String(row.status) as Status,
    spec: json(row.spec),
    summary: row.summary === null ? null : json(row.summary),
    error: row.error === null ? null : String(row.error),
    matchesTotal: Number(row.total ?? 0),
    matchesDone: Number(row.done ?? 0),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function matchFromRow(row: Row): MatchRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    index: Number(row.idx),
    status: String(row.status) as Status,
    spec: json(row.spec),
    result: row.result === null ? null : json(row.result),
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

export { now };
