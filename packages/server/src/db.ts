import { DatabaseSync } from "node:sqlite";
import type { Diet, Traits } from "@terrarium/sdk";
import type { MatchResult, MatchSpec } from "./match.js";
import type { EntrantSummary, RatingState } from "./scoring.js";

export interface CreatureRecord {
  codeHash: string;
  name: string;
  diet: Diet;
  traits: Traits;
  /** Owner's user id; null for builtin species. */
  ownerId: string | null;
  /** Display name of the owner ("builtin" for builtin species). */
  author: string | null;
  /** 1, 2, 3... per owner and species name. */
  version: number;
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

export interface UserRecord {
  id: string;
  provider: string;
  subject: string;
  email: string;
  name: string;
  picture: string | null;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RunRecord {
  id: string;
  kind: RunKind;
  createdBy: string | null;
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
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
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
    this.migrate();
  }

  /** Additive column migrations for databases created by earlier versions. */
  private migrate(): void {
    const has = (table: string, col: string) =>
      (this.sql.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((r) => r.name === col);
    if (!has("creatures", "owner_id")) this.sql.exec("ALTER TABLE creatures ADD COLUMN owner_id TEXT");
    if (!has("creatures", "version")) this.sql.exec("ALTER TABLE creatures ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    if (!has("runs", "created_by")) this.sql.exec("ALTER TABLE runs ADD COLUMN created_by TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS creatures_owner ON creatures(owner_id, name)");
  }

  // ---- users, sessions, API keys ----

  upsertUser(u: Omit<UserRecord, "id" | "createdAt"> & { id: string }): UserRecord {
    this.sql
      .prepare(
        `INSERT INTO users (id, provider, subject, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`,
      )
      .run(u.id, u.provider, u.subject, u.email, u.name, u.picture, now());
    return this.userBySubject(u.provider, u.subject)!;
  }

  userBySubject(provider: string, subject: string): UserRecord | undefined {
    const row = this.sql.prepare("SELECT * FROM users WHERE provider = ? AND subject = ?").get(provider, subject) as Row | undefined;
    return row && userFromRow(row);
  }

  getUser(id: string): UserRecord | undefined {
    const row = this.sql.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row && userFromRow(row);
  }

  createSession(tokenHash: string, userId: string, expiresAt: string): void {
    this.sql.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(tokenHash, userId, now(), expiresAt);
  }

  sessionUser(tokenHash: string): UserRecord | undefined {
    const row = this.sql
      .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .get(tokenHash, now()) as Row | undefined;
    return row && userFromRow(row);
  }

  deleteSession(tokenHash: string): void {
    this.sql.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  createApiKey(k: { id: string; userId: string; name: string; keyHash: string; prefix: string }): void {
    this.sql
      .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(k.id, k.userId, k.name, k.keyHash, k.prefix, now());
  }

  apiKeyUser(keyHash: string): UserRecord | undefined {
    const row = this.sql
      .prepare("SELECT u.*, k.id AS key_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.revoked_at IS NULL")
      .get(keyHash) as Row | undefined;
    if (!row) return undefined;
    this.sql.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), String(row.key_id));
    return userFromRow(row);
  }

  listApiKeys(userId: string): ApiKeyRecord[] {
    return (
      this.sql.prepare("SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(userId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      prefix: String(r.prefix),
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at === null ? null : String(r.last_used_at),
    }));
  }

  revokeApiKey(userId: string, id: string): boolean {
    return Number(this.sql.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), id, userId).changes) > 0;
  }

  activeRuns(userId: string): number {
    const row = this.sql.prepare("SELECT COUNT(*) AS n FROM runs WHERE created_by = ? AND status IN ('queued', 'running')").get(userId) as Row;
    return Number(row.n);
  }

  nextVersion(ownerId: string | null, name: string): number {
    const row = this.sql
      .prepare(`SELECT MAX(version) AS v FROM creatures WHERE ${ownerId === null ? "owner_id IS NULL" : "owner_id = ?"} AND name = ?`)
      .get(...(ownerId === null ? [name] : [ownerId, name])) as Row;
    return Number(row.v ?? 0) + 1;
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
        `INSERT OR IGNORE INTO creatures (code_hash, name, diet, traits, owner_id, version, author, description, builtin, source, code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.codeHash, c.name, c.diet, JSON.stringify(c.traits), c.ownerId, c.version, c.author, c.description, c.builtin ? 1 : 0, c.source, c.code, c.createdAt);
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
    const row = this.sql
      .prepare(`SELECT c.*, u.name AS owner_name FROM creatures c LEFT JOIN users u ON u.id = c.owner_id WHERE c.code_hash = ?`)
      .get(hash) as Row | undefined;
    return row && { ...creatureFromRow(row), source: String(row.source), code: String(row.code) };
  }

  /** Accepts a full hash or a unique prefix of at least 8 characters. */
  resolveCreature(ref: string): CreatureWithCode | undefined {
    const exact = this.getCreature(ref);
    if (exact || ref.length < 8 || !/^[0-9a-f]+$/.test(ref)) return exact;
    const rows = this.sql.prepare("SELECT code_hash FROM creatures WHERE code_hash LIKE ? LIMIT 2").all(`${ref}%`) as Row[];
    return rows.length === 1 ? this.getCreature(String(rows[0]!.code_hash)) : undefined;
  }

  listCreatures(opts: { ownerId?: string; builtin?: boolean; limit?: number } = {}): CreatureRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.ownerId) {
      where.push("c.owner_id = ?");
      args.push(opts.ownerId);
    }
    if (opts.builtin !== undefined) {
      where.push("c.builtin = ?");
      args.push(opts.builtin ? 1 : 0);
    }
    const sql = `SELECT c.code_hash, c.name, c.diet, c.traits, c.owner_id, c.version, c.author, c.description, c.builtin, c.created_at,
        u.name AS owner_name
      FROM creatures c LEFT JOIN users u ON u.id = c.owner_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.created_at DESC LIMIT ?`;
    return (this.sql.prepare(sql).all(...args, opts.limit ?? 100) as Row[]).map(creatureFromRow);
  }

  // ---- runs & matches ----

  insertRun(run: RunRecord, matches: MatchRecord[]): void {
    this.transaction(() => {
      this.sql
        .prepare("INSERT INTO runs (id, kind, status, spec, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(run.id, run.kind, run.status, JSON.stringify(run.spec), run.createdBy, run.createdAt);
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

  leaderboard(ladder: string, limit = 100): Array<RatingState & { codeHash: string; name: string; version: number; author: string | null }> {
    const rows = this.sql
      .prepare(
        `SELECT r.code_hash, r.rating, r.matches, c.name, c.version, COALESCE(u.name, c.author) AS author
         FROM ratings r JOIN creatures c ON c.code_hash = r.code_hash LEFT JOIN users u ON u.id = c.owner_id
         WHERE r.ladder = ? ORDER BY r.rating DESC LIMIT ?`,
      )
      .all(ladder, limit) as Row[];
    return rows.map((r) => ({
      codeHash: String(r.code_hash),
      name: String(r.name),
      version: Number(r.version ?? 1),
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

function userFromRow(row: Row): UserRecord {
  return {
    id: String(row.id),
    provider: String(row.provider),
    subject: String(row.subject),
    email: String(row.email),
    name: String(row.name),
    picture: row.picture === null ? null : String(row.picture),
    createdAt: String(row.created_at),
  };
}

function creatureFromRow(row: Row): CreatureRecord {
  const ownerName = row.owner_name ?? row.author;
  return {
    codeHash: String(row.code_hash),
    name: String(row.name),
    diet: String(row.diet) as Diet,
    traits: json(row.traits),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    author: ownerName === null || ownerName === undefined ? null : String(ownerName),
    version: Number(row.version ?? 1),
    description: row.description === null ? null : String(row.description),
    builtin: Number(row.builtin) === 1,
    createdAt: String(row.created_at),
  };
}

function runFromRow(row: Row): RunRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as RunKind,
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
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
