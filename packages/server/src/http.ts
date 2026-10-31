import { readFileSync, readdirSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { DEFAULT_CONFIG } from "@terrarium/engine";
import { DEFAULT_LIMITS } from "@terrarium/sandbox";
import type { Db } from "./db.js";
import { UserError } from "./errors.js";
import type { LiveManager } from "./live.js";
import { FITNESS_WEIGHTS, SCORING_VERSION } from "./fitness.js";
import { ENGINE_VERSION } from "./match.js";
import type { Registry } from "./registry.js";
import type { RunService } from "./runs.js";
import type { BatchPool } from "./workers/pool.js";
import { sessionCookie, readCookie, SESSION_COOKIE, type Auth, type User } from "./auth.js";

export interface Services {
  db: Db;
  registry: Registry;
  runs: RunService;
  live: LiveManager;
  pool: BatchPool;
  auth: Auth;
  secureCookies: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

/** Queued or running runs one non-admin user may have at once. */
export const MAX_ACTIVE_RUNS_PER_USER = 5;

const SDK_DIR = new URL("../../sdk/", import.meta.url);
const VIEWER = new URL("../static/viewer.html", import.meta.url);
const PRIVACY = new URL("../static/privacy.html", import.meta.url);
const ADMIN = new URL("../static/admin.html", import.meta.url);
const MAX_WAIT_MS = 10 * 60_000;

const worldOverrides = z
  .object({
    width: z.number().int().min(100).max(4000),
    height: z.number().int().min(100).max(4000),
    maxTicks: z.number().int().min(10).max(50_000),
    traitBudget: z.number().int().min(1).max(200),
    initialPopulation: z.number().int().min(0).max(100),
    maxPopulationPerSpecies: z.number().int().min(1).max(1000),
    maxVisible: z.number().int().min(1).max(100),
    params: z.record(z.string(), z.record(z.string(), z.number())),
  })
  .partial()
  .strict();

const creatureRefs = z.array(z.string().min(8)).max(64);
const seeds = z.union([z.number().int().min(1).max(100), z.array(z.string().min(1).max(100)).min(1).max(100)]);
const wait = z.boolean().optional();

const schemas = {
  submit: z.object({
    source: z.string().min(1),
    filename: z.string().max(100).optional(),
    description: z.string().max(2000).optional(),
  }),
  googleSignIn: z.object({ credential: z.string().min(20).max(8000) }),
  devSignIn: z.object({ name: z.string().min(1).max(40) }),
  apiKey: z.object({ name: z.string().min(1).max(60) }),
  match: z.object({ entrants: creatureRefs.min(1), background: creatureRefs.optional(), seed: z.string().max(100).optional(), world: worldOverrides.optional(), wait }),
  evaluation: z.object({
    creature: z.string().min(8),
    opponents: creatureRefs.optional(),
    background: creatureRefs.optional(),
    seeds: seeds.optional(),
    world: worldOverrides.optional(),
    wait,
  }),
  tournament: z.object({
    name: z.string().max(200).optional(),
    entrants: creatureRefs.min(2),
    background: creatureRefs.optional(),
    format: z.enum(["ffa", "round-robin"]).optional(),
    seeds: seeds.optional(),
    world: worldOverrides.optional(),
    ladder: z.string().regex(/^[\w.@-]{1,64}$/).nullable().optional(),
    wait,
  }),
  world: z.object({
    name: z.string().max(100).optional(),
    world: worldOverrides.extend({ seed: z.string().max(100) }).partial().optional(),
    tps: z.number().min(0.5).max(200).optional(),
    migration: z.boolean().optional(),
    recolonizeAfter: z.number().int().min(0).max(100_000).optional(),
    species: z.array(z.object({ creature: z.string().min(8), population: z.number().int().min(0).max(100).optional() })).max(20).optional(),
  }),
  worldPatch: z.object({ name: z.string().min(1).max(100).optional(), tps: z.number().min(0.5).max(200).optional() }),
  addSpecies: z.object({ creature: z.string().min(8), population: z.number().int().min(0).max(100).optional() }),
  control: z.object({ action: z.enum(["pause", "resume", "step"]).optional(), tps: z.number().min(0.5).max(200).optional() }),
  replay: z.object({
    from: z.coerce.number().int().min(0).default(0),
    to: z.coerce.number().int().min(0).optional(),
    every: z.coerce.number().int().min(1).default(5),
  }),
};

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new UserError(`Invalid request:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export async function createApp(s: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(websocket);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply: FastifyReply) => {
    if (err instanceof UserError) return reply.status(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    console.error(err);
    return reply.status(500).send({ error: "internal error" });
  });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = s.auth.resolve(req.headers.authorization, req.headers.cookie);
  });

  const requireUser = (req: { user: User | null }): User => {
    if (!req.user) throw new UserError("Sign in first. Agents and scripts can send an API key: Authorization: Bearer trk_...", 401);
    return req.user;
  };
  const requireAdmin = (req: { user: User | null }): User => {
    const u = requireUser(req);
    if (!u.isAdmin) throw new UserError("Only admins can do this", 403);
    return u;
  };
  const requireUsable = (user: User, refs: string[]) => {
    for (const ref of refs) {
      const c = s.registry.resolve(ref);
      if (!s.registry.canUse(c, user)) throw new UserError(`"${c.name}" belongs to someone else. Use your own creatures or builtin ones.`, 403);
    }
  };
  const checkQuota = (user: User) => {
    if (!user.isAdmin && s.db.activeRuns(user.id) >= MAX_ACTIVE_RUNS_PER_USER) {
      throw new UserError(`You already have ${MAX_ACTIVE_RUNS_PER_USER} runs queued or running. Wait for one to finish.`, 429);
    }
  };
  const secure = (req: { headers: Record<string, unknown> }) => s.secureCookies || req.headers["x-forwarded-proto"] === "https";

  const finishRun = async (id: string, waitFor: boolean | undefined) =>
    waitFor ? s.runs.waitFor(id, MAX_WAIT_MS) : s.runs.get(id);

  // Browsers asking for the home page get the viewer; agents and scripts get the JSON docs.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url === "/" && (req.headers.accept ?? "").includes("text/html")) return reply.redirect("/view");
  });

  app.get("/privacy", async (_req, reply) => reply.type("text/html").send(readFileSync(PRIVACY, "utf8")));

  app.get("/", async () => ({
    name: "terrarium",
    engine: ENGINE_VERSION,
    docs: {
      overview: "Write a species in TypeScript against @terrarium/sdk, submit it, then evaluate it or enter tournaments.",
      sdk: "GET /sdk returns the creature API (types and runtime contract). GET /sdk/examples lists example species.",
      scoring: {
        version: SCORING_VERSION,
        range: "0-100, higher is better. Results include the per-component breakdown.",
        weights: FITNESS_WEIGHTS,
        components: {
          survival: "fraction of the scheduled match the species had living members",
          dominance: "mean per-tick share of biomass among species with the same diet",
          lineage: "deepest generation reached / generations the rules allow in the match",
          finish: "population at the end / founding population, capped at 1",
        },
      },
      determinism: "Same creatures + seed + world config = identical result. Evaluations use fixed 'bench-N' seeds; tournaments use fresh ones.",
      limits: { sandbox: DEFAULT_LIMITS, world: DEFAULT_CONFIG },
    },
    endpoints: {
      "AUTH": "Browsers sign in with Google (POST /auth/google). Agents and scripts use an API key from POST /me/api-keys: send 'Authorization: Bearer trk_...'. Reading is public; anything that runs code needs an account.",
      "POST /auth/google": "{credential} Google ID token from Sign in with Google. Sets a session cookie.",
      "POST /auth/logout": "End the browser session.",
      "GET /me": "The signed-in user (or null).",
      "GET /me/api-keys | POST /me/api-keys {name} | DELETE /me/api-keys/:id": "Manage API keys. A new key is shown once.",
      "POST /creatures": "{source, filename?, description?} -> {creature, created}. Signed in. You own what you upload; re-uploading a species name makes a new version.",
      "GET /creatures": "?mine=1&builtin=true|false&limit=",
      "GET /creatures/:ref": "?source=1 includes source, for your own and builtin creatures only. ref = code hash or unique prefix (8+ chars).",
      "POST /evaluations": "{creature, opponents?, background?, seeds?, world?, wait?}. Signed in, your own or builtin creatures. Unranked. Default background = builtin species.",
      "POST /matches": "{entrants, background?, seed?, world?, wait?}. Signed in. One unranked match.",
      "POST /tournaments": "{entrants, background?, format: ffa|round-robin, seeds?, world?, ladder?, wait?}. Signed in; rated ladders (ladder set) are admin only. Admins default to '<ruleset>/<scoring>'.",
      "GET /runs/:id": "Status and summary of a match, evaluation or tournament. ?matches=1 adds per-match results.",
      "GET /runs": "?kind=match|evaluation|tournament",
      "GET /privacy": "Privacy policy.",
      "GET /view": "Browser viewer for live worlds (?world=id) and replays (?match=id).",
      "GET /matches": "Recent finished matches.",
      "GET /matches/:id": "Full match result: stats, logs, timeline.",
      "GET /matches/:id/replay": "?from=&to=&every= Re-simulates deterministically and returns frames. verified=true when the hash matches.",
      "GET /ladders": "List ladders. GET /ladders/:ladder is the leaderboard.",
      "POST /worlds": "{name?, world?, tps?, migration?, recolonizeAfter? (ticks, 0 = off, default 500), species?: [{creature, population?}]} Admin. Start a live shared world. Worlds are saved and come back after restarts (from tick 0).",
      "GET /worlds": "List live worlds. GET /worlds/:id for one.",
      "POST /worlds/:id/species": "{creature, population?} Signed in, your own or builtin creatures. Add a species to a live world.",
      "POST /worlds/:id/control": "{action?: pause|resume|step, tps?} Admin.",
      "DELETE /worlds/:id": "Admin. Delete a live world (stops it and forgets its saved definition).",
      "PATCH /worlds/:id": "{name?, tps?} Admin.",
      "POST /worlds/:id/restart": "Admin. Start the world again from tick 0 with its saved settings and species.",
      "DELETE /worlds/:id/species/:creature": "Admin. Remove a species from a live world.",
      "GET /admin": "Backoffice (admins). Data: GET /admin/overview, /admin/users, /admin/runs.",
      "WS /worlds/:id/stream": "Messages: species | frame | stats | notice | focus | error (JSON). Send {type:'follow', id} to receive the full state of one organism as 'focus' messages (id null to stop). Frame entity = [id, kind(0 plant,1 animal,2 corpse), x, y, r, species, energy].",
    },
  }));

  app.get("/view", async (_req, reply) => reply.type("text/html").send(readFileSync(VIEWER, "utf8")));

  app.get("/matches", async (req) => {
    const q = req.query as { limit?: string };
    return s.db.recentMatches(q.limit ? Math.min(Number(q.limit), 100) : 20);
  });

  // ---- accounts ----

  app.get("/auth/config", async () => ({ googleClientId: s.auth.opts.googleClientId ?? null, devLogin: !!s.auth.opts.devLogin }));

  app.post("/auth/google", async (req, reply) => {
    const { credential } = parse(schemas.googleSignIn, req.body);
    const { user, session } = await s.auth.signInWithGoogle(credential);
    return reply.header("set-cookie", sessionCookie(session, secure(req))).send({ user });
  });

  app.post("/auth/dev", async (req, reply) => {
    const loopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    if (!loopback) throw new UserError("Development sign-in only works from this machine", 403);
    const { name } = parse(schemas.devSignIn, req.body);
    const { user, session } = s.auth.signInDev(name);
    return reply.header("set-cookie", sessionCookie(session, secure(req))).send({ user });
  });

  app.post("/auth/logout", async (req, reply) => {
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (session) s.auth.signOut(session);
    return reply.header("set-cookie", sessionCookie("", secure(req), 0)).send({ ok: true });
  });

  app.get("/me", async (req) => ({ user: req.user }));
  app.get("/me/api-keys", async (req) => s.db.listApiKeys(requireUser(req).id));
  app.post("/me/api-keys", async (req, reply) => {
    const user = requireUser(req);
    const { name } = parse(schemas.apiKey, req.body);
    if (s.db.listApiKeys(user.id).length >= 10) throw new UserError("You have 10 API keys. Revoke one first.", 429);
    return reply.status(201).send({ ...s.auth.createApiKey(user, name), name, note: "Copy this key now. It is not shown again." });
  });
  app.delete("/me/api-keys/:id", async (req, reply) => {
    const user = requireUser(req);
    if (!s.db.revokeApiKey(user.id, (req.params as { id: string }).id)) throw new UserError("No such API key", 404);
    return reply.status(204).send();
  });

  app.get("/health", async () => ({ ok: true, workers: s.pool.size, busy: s.pool.busy, queued: s.pool.queued }));

  app.get("/sdk", async (_req, reply) =>
    reply.type("text/plain").send(readFileSync(new URL("src/index.ts", SDK_DIR), "utf8")),
  );
  app.get("/sdk/examples", async () =>
    readdirSync(new URL("examples/", SDK_DIR))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => ({ name: f, source: readFileSync(new URL(`examples/${f}`, SDK_DIR), "utf8") })),
  );

  // ---- creatures ----

  app.post("/creatures", async (req, reply) => {
    const owner = requireUser(req);
    const body = parse(schemas.submit, req.body);
    const out = await s.registry.submit({ ...body, owner });
    return reply.status(out.created ? 201 : 200).send(out);
  });

  app.get("/creatures", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return s.db.listCreatures({
      ownerId: q.mine ? requireUser(req).id : undefined,
      builtin: q.builtin === undefined ? undefined : q.builtin === "true",
      limit: q.limit ? Math.min(Number(q.limit), 500) : undefined,
    });
  });

  app.get("/creatures/:ref", async (req) => {
    const { ref } = req.params as { ref: string };
    const creature = s.registry.resolve(ref);
    const { code: _code, source, ...rest } = creature;
    if (!(req.query as { source?: string }).source) return rest;
    if (!s.registry.canReadSource(creature, req.user)) throw new UserError("Only the owner can read this creature's code", 403);
    return { ...rest, source };
  });

  // ---- runs ----

  const builtinBackground = () => s.db.listCreatures({ builtin: true }).map((c) => c.codeHash);

  app.post("/matches", async (req, reply) => {
    const user = requireUser(req);
    const b = parse(schemas.match, req.body);
    checkQuota(user);
    const run = s.runs.create({ kind: "match", createdBy: user.id, entrants: b.entrants, background: b.background, seeds: b.seed ? [b.seed] : 1, world: b.world });
    return reply.status(202).send(await finishRun(run.id, b.wait));
  });

  app.post("/evaluations", async (req, reply) => {
    const user = requireUser(req);
    const b = parse(schemas.evaluation, req.body);
    requireUsable(user, [b.creature]);
    checkQuota(user);
    const run = s.runs.create({
      kind: "evaluation",
      createdBy: user.id,
      name: `evaluation of ${b.creature.slice(0, 12)}`,
      entrants: [b.creature, ...(b.opponents ?? [])],
      background: b.background ?? (b.opponents ? [] : builtinBackground()),
      seeds: b.seeds,
      world: b.world,
    });
    return reply.status(202).send(await finishRun(run.id, b.wait));
  });

  app.post("/tournaments", async (req, reply) => {
    const user = requireUser(req);
    const b = parse(schemas.tournament, req.body);
    const ladder = b.ladder === undefined ? (user.isAdmin ? `${s.runs.ruleset}/${SCORING_VERSION}` : null) : b.ladder;
    if (ladder !== null && !user.isAdmin) throw new UserError("Only admins can run rated tournaments. Leave out 'ladder' for an unrated one.", 403);
    checkQuota(user);
    const run = s.runs.create({
      kind: "tournament",
      createdBy: user.id,
      name: b.name,
      entrants: b.entrants,
      background: b.background,
      format: b.format,
      seeds: b.seeds,
      world: b.world,
      ladder,
    });
    return reply.status(202).send(await finishRun(run.id, b.wait));
  });

  app.get("/runs", async (req) => {
    const q = req.query as { kind?: "match" | "evaluation" | "tournament"; limit?: string };
    return s.db.listRuns({ kind: q.kind, limit: q.limit ? Math.min(Number(q.limit), 200) : undefined });
  });

  app.get("/runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const run = s.runs.get(id);
    if (!(req.query as { matches?: string }).matches) return run;
    const matches = s.db.runMatches(id).map((m) => ({
      id: m.id,
      index: m.index,
      seed: m.spec.seed,
      status: m.status,
      error: m.error,
      progress: s.runs.liveProgress(m.id),
      ticks: m.result?.ticks,
      valid: m.result?.valid,
      entrants: m.result?.entrants.map((e) => ({ name: e.name, codeHash: e.codeHash, ranked: e.ranked, score: e.score, rank: e.rank, population: e.stats.population, extinctAt: e.stats.extinctAt })),
    }));
    return { ...run, matches };
  });

  app.get("/matches/:id", async (req) => {
    const { id } = req.params as { id: string };
    const m = s.db.getMatch(id);
    if (!m) throw new UserError(`Unknown match ${id}`, 404);
    // A creature's debug logs reveal its strategy: only its owner (or an admin) sees them.
    if (m.result) {
      m.result.entrants = m.result.entrants.map((e) => {
        const c = s.db.getCreature(e.codeHash);
        return c && s.registry.canReadSource(c, req.user) ? e : { ...e, stats: { ...e.stats, logs: [] } };
      });
    }
    return { ...m, progress: s.runs.liveProgress(id) };
  });

  app.get("/matches/:id/replay", async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(schemas.replay, req.query);
    const m = s.db.getMatch(id);
    if (!m?.result) throw new UserError(`No finished match ${id}`, 404);
    const to = Math.min(q.to ?? m.result.ticks, m.result.ticks);
    const species = m.spec.entrants.map(({ slot, codeHash, name, ranked }) => ({ slot, codeHash, name, ranked }));
    return { species, world: m.spec.world, ...(await s.runs.replay(id, { from: q.from, to, every: q.every })) };
  });

  // ---- ladders ----

  app.get("/ladders", async () => s.db.ladders());
  app.get("/ladders/:ladder", async (req) => s.db.leaderboard((req.params as { ladder: string }).ladder));

  // ---- live worlds ----

  app.post("/worlds", async (req, reply) => {
    const admin = requireAdmin(req);
    return reply.status(201).send(s.live.create(parse(schemas.world, req.body), admin.id));
  });
  app.patch("/worlds/:id", async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const b = parse(schemas.worldPatch, req.body);
    if (b.name) s.live.rename(id, b.name);
    if (b.tps) s.live.setTps(id, b.tps);
    return s.live.get(id);
  });
  app.post("/worlds/:id/restart", async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await s.live.restart(id);
    return s.live.get(id);
  });
  app.delete("/worlds/:id/species/:creature", async (req, reply) => {
    requireAdmin(req);
    const { id, creature } = req.params as { id: string; creature: string };
    s.live.removeSpecies(id, creature);
    return reply.status(204).send();
  });

  // ---- backoffice ----

  app.get("/admin", async (_req, reply) => reply.type("text/html").send(readFileSync(ADMIN, "utf8")));
  app.get("/admin/overview", async (req) => {
    requireAdmin(req);
    return { ...s.db.counts(), pool: { workers: s.pool.size, busy: s.pool.busy, queued: s.pool.queued }, worlds: s.live.list().length, engine: ENGINE_VERSION };
  });
  app.get("/admin/users", async (req) => {
    requireAdmin(req);
    const admins = new Set(s.auth.opts.admins.map((e) => e.trim().toLowerCase()));
    return s.db.listUsers().map((u) => ({ ...u, isAdmin: admins.has(u.email.toLowerCase()) }));
  });
  app.get("/admin/runs", async (req) => {
    requireAdmin(req);
    const runs = s.db.listRuns({ limit: 100 });
    const names = s.db.userNames(runs.flatMap((r) => (r.createdBy ? [r.createdBy] : [])));
    return runs.map((r) => ({ ...r, createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null }));
  });
  app.get("/worlds", async () => s.live.list());
  app.get("/worlds/:id", async (req) => s.live.get((req.params as { id: string }).id));
  app.delete("/worlds/:id", async (req, reply) => {
    requireAdmin(req);
    await s.live.stop((req.params as { id: string }).id);
    return reply.status(204).send();
  });
  app.post("/worlds/:id/species", async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const b = parse(schemas.addSpecies, req.body);
    requireUsable(user, [b.creature]);
    s.live.addSpecies(id, b.creature, b.population);
    return reply.status(202).send({ ok: true });
  });
  app.post("/worlds/:id/control", async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const b = parse(schemas.control, req.body);
    if (b.action) s.live.control(id, b.action);
    if (b.tps) s.live.setTps(id, b.tps);
    return s.live.get(id);
  });

  app.get("/worlds/:id/stream", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    let sub: ReturnType<LiveManager["subscribe"]> | undefined;
    try {
      sub = s.live.subscribe(id, (msg) => {
        // Slow spectators drop frames rather than buffering without bound.
        if (msg.type === "frame" && socket.bufferedAmount > 1_000_000) return;
        socket.send(JSON.stringify(msg));
      });
    } catch (e) {
      socket.send(JSON.stringify({ type: "error", error: e instanceof Error ? e.message : String(e) }));
      socket.close();
      return;
    }
    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; id?: unknown };
        if (msg.type === "follow") sub?.follow(typeof msg.id === "number" && Number.isInteger(msg.id) ? msg.id : null);
      } catch {
        // Ignore malformed spectator messages.
      }
    });
    socket.on("close", () => sub?.unsubscribe());
  });

  return app;
}
