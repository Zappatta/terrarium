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

export interface Services {
  db: Db;
  registry: Registry;
  runs: RunService;
  live: LiveManager;
  pool: BatchPool;
  token?: string;
}

const SDK_DIR = new URL("../../sdk/", import.meta.url);
const VIEWER = new URL("../static/viewer.html", import.meta.url);
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
    author: z.string().max(100).optional(),
    description: z.string().max(2000).optional(),
  }),
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
  }),
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

  if (s.token) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/" || req.url === "/health" || req.url.startsWith("/view")) return;
      const header = req.headers.authorization ?? "";
      const query = new URL(req.url, "http://x").searchParams.get("token");
      if (header !== `Bearer ${s.token}` && query !== s.token) return reply.status(401).send({ error: "unauthorised" });
    });
  }

  const finishRun = async (id: string, waitFor: boolean | undefined) =>
    waitFor ? s.runs.waitFor(id, MAX_WAIT_MS) : s.runs.get(id);

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
      "POST /creatures": "{source, filename?, author?, description?} -> {creature, created}. Compile + validation errors are 400s.",
      "GET /creatures": "?author=&builtin=true|false&limit=",
      "GET /creatures/:ref": "?source=1 to include source. ref = code hash or unique prefix (8+ chars).",
      "POST /evaluations": "{creature, opponents?, background?, seeds?, world?, wait?}. Unranked. Default background = builtin species.",
      "POST /matches": "{entrants, background?, seed?, world?, wait?}. One unranked match.",
      "POST /tournaments": "{entrants, background?, format: ffa|round-robin, seeds?, world?, ladder?, wait?}. Rated on ladder (default '<ruleset>/<scoring>'); ladder: null for unrated.",
      "GET /runs/:id": "Status and summary of a match, evaluation or tournament. ?matches=1 adds per-match results.",
      "GET /runs": "?kind=match|evaluation|tournament",
      "GET /view": "Browser viewer for live worlds (?world=id) and replays (?match=id).",
      "GET /matches": "Recent finished matches.",
      "GET /matches/:id": "Full match result: stats, logs, timeline.",
      "GET /matches/:id/replay": "?from=&to=&every= Re-simulates deterministically and returns frames. verified=true when the hash matches.",
      "GET /ladders": "List ladders. GET /ladders/:ladder is the leaderboard.",
      "POST /worlds": "{name?, world?, tps?, migration?, recolonizeAfter? (ticks, 0 = off, default 500)} Start a live shared world.",
      "GET /worlds": "List live worlds. GET /worlds/:id for one.",
      "POST /worlds/:id/species": "{creature, population?} Add a species to a live world.",
      "POST /worlds/:id/control": "{action?: pause|resume|step, tps?}",
      "DELETE /worlds/:id": "Stop a live world.",
      "WS /worlds/:id/stream": "Messages: species | frame | stats | notice | focus | error (JSON). Send {type:'follow', id} to receive the full state of one organism as 'focus' messages (id null to stop). Frame entity = [id, kind(0 plant,1 animal,2 corpse), x, y, r, species, energy].",
    },
  }));

  app.get("/view", async (_req, reply) => reply.type("text/html").send(readFileSync(VIEWER, "utf8")));

  app.get("/matches", async (req) => {
    const q = req.query as { limit?: string };
    return s.db.recentMatches(q.limit ? Math.min(Number(q.limit), 100) : 20);
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
    const body = parse(schemas.submit, req.body);
    const out = await s.registry.submit(body);
    return reply.status(out.created ? 201 : 200).send(out);
  });

  app.get("/creatures", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return s.db.listCreatures({
      author: q.author,
      builtin: q.builtin === undefined ? undefined : q.builtin === "true",
      limit: q.limit ? Math.min(Number(q.limit), 500) : undefined,
    });
  });

  app.get("/creatures/:ref", async (req) => {
    const { ref } = req.params as { ref: string };
    const { code: _code, source, ...rest } = s.registry.resolve(ref);
    return (req.query as { source?: string }).source ? { ...rest, source } : rest;
  });

  // ---- runs ----

  const builtinBackground = () => s.db.listCreatures({ builtin: true }).map((c) => c.codeHash);

  app.post("/matches", async (req, reply) => {
    const b = parse(schemas.match, req.body);
    const run = s.runs.create({ kind: "match", entrants: b.entrants, background: b.background, seeds: b.seed ? [b.seed] : 1, world: b.world });
    return reply.status(202).send(await finishRun(run.id, b.wait));
  });

  app.post("/evaluations", async (req, reply) => {
    const b = parse(schemas.evaluation, req.body);
    const run = s.runs.create({
      kind: "evaluation",
      name: `evaluation of ${b.creature.slice(0, 12)}`,
      entrants: [b.creature, ...(b.opponents ?? [])],
      background: b.background ?? (b.opponents ? [] : builtinBackground()),
      seeds: b.seeds,
      world: b.world,
    });
    return reply.status(202).send(await finishRun(run.id, b.wait));
  });

  app.post("/tournaments", async (req, reply) => {
    const b = parse(schemas.tournament, req.body);
    const run = s.runs.create({
      kind: "tournament",
      name: b.name,
      entrants: b.entrants,
      background: b.background,
      format: b.format,
      seeds: b.seeds,
      world: b.world,
      ladder: b.ladder === undefined ? `${s.runs.ruleset}/${SCORING_VERSION}` : b.ladder,
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

  app.post("/worlds", async (req, reply) => reply.status(201).send(s.live.create(parse(schemas.world, req.body))));
  app.get("/worlds", async () => s.live.list());
  app.get("/worlds/:id", async (req) => s.live.get((req.params as { id: string }).id));
  app.delete("/worlds/:id", async (req, reply) => {
    await s.live.stop((req.params as { id: string }).id);
    return reply.status(204).send();
  });
  app.post("/worlds/:id/species", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = parse(schemas.addSpecies, req.body);
    s.live.addSpecies(id, b.creature, b.population);
    return reply.status(202).send({ ok: true });
  });
  app.post("/worlds/:id/control", async (req) => {
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
