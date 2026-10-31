import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { createApp, createServices } from "@terrarium/server";

const SMALL_WORLD = { maxTicks: 200, width: 300, height: 300, initialPopulation: 5, params: { plants: { initial: 60, max: 120 } } };

const forager = (name: string, extra = "") => `
import { defineSpecies } from "@terrarium/sdk";
export default defineSpecies({
  name: "${name}",
  diet: "herbivore",
  traits: { size: 2, speed: 4, sight: 5 },
  think(me, ctx) {
    ${extra}
    if (me.self.canReproduce) return { type: "reproduce" };
    const p = me.visible.find((v) => v.kind === "plant");
    if (p) return p.distance <= me.self.radius + p.radius + 2 ? { type: "eat", target: p.id } : { type: "move", to: p.pos };
    if (!me.self.moving) return { type: "move", to: { x: ctx.random() * ctx.world.width, y: ctx.random() * ctx.world.height } };
  },
});`;

// Walks to the left edge and leaves as soon as the world allows it.
const nomad = `
import { defineSpecies } from "@terrarium/sdk";
export default defineSpecies({
  name: "Nomad",
  diet: "herbivore",
  traits: { size: 1, speed: 10 },
  think(me) {
    if (me.self.pos.x <= 8) return me.events.some((e) => e.type === "immigrated") ? { type: "idle" } : { type: "migrate" };
    return { type: "move", to: { x: 0, y: me.self.pos.y } };
  },
});`;

let dir: string;
let services: Awaited<ReturnType<typeof createServices>>;
let app: FastifyInstance;
let address: string | undefined;
const listen = async () => (address ??= await app.listen({ port: 0, host: "127.0.0.1" }));

const post = async (url: string, payload: unknown) => {
  const r = await app.inject({ method: "POST", url, payload: payload as object });
  return { status: r.statusCode, body: r.json() };
};
const get = async (url: string) => (await app.inject({ method: "GET", url })).json();
const submit = async (source: string) => (await post("/creatures", { source, author: "test" })).body.creature.codeHash as string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-test-"));
  services = await createServices({ dbPath: join(dir, "t.db"), workers: 2 });
  app = await createApp(services);
});

afterAll(async () => {
  await app.close();
  await services.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("creatures", () => {
  it("seeds the builtin species", async () => {
    const builtins = await get("/creatures?builtin=true");
    expect(builtins.map((c: { name: string }) => c.name).sort()).toEqual(["Bramble", "Foxglove", "Grazer", "Herd", "Hunter"]);
  });

  it("is idempotent by code hash and resolves hash prefixes", async () => {
    const a = await post("/creatures", { source: forager("Idem") });
    const b = await post("/creatures", { source: forager("Idem") });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.creature.codeHash).toBe(a.body.creature.codeHash);
    const fetched = await get(`/creatures/${a.body.creature.codeHash.slice(0, 10)}?source=1`);
    expect(fetched.source).toContain("Idem");
  });

  it("returns readable errors", async () => {
    const bad = await post("/creatures", { source: `export default { name: "x", diet: "herbivore", traits: { wings: 1 } }` });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unknown trait: wings/);
  });
});

describe("runs", () => {
  it("evaluates a creature against the builtin background on fixed seeds", async () => {
    const hash = await submit(forager("Evaluated"));
    const { body: run } = await post("/evaluations", { creature: hash, seeds: 2, world: SMALL_WORLD, wait: true });
    expect(run.status).toBe("done");
    expect(run.spec.seeds).toEqual(["bench-0", "bench-1"]);
    expect(run.summary[0]).toMatchObject({ name: "Evaluated", ranked: true, matches: 2 });
    expect(run.summary.filter((s: { ranked: boolean }) => !s.ranked)).toHaveLength(5);
  });

  it("produces the same result for the same seed, and a replay verifies against it", async () => {
    const hash = await submit(forager("Replayed"));
    const a = await post("/matches", { entrants: [hash], seed: "fixed", world: SMALL_WORLD, wait: true });
    const b = await post("/matches", { entrants: [hash], seed: "fixed", world: SMALL_WORLD, wait: true });
    const matchA = (await get(`/runs/${a.body.id}?matches=1`)).matches[0];
    const matchB = (await get(`/runs/${b.body.id}?matches=1`)).matches[0];
    const resA = await get(`/matches/${matchA.id}`);
    const resB = await get(`/matches/${matchB.id}`);
    expect(resA.result.hash).toBe(resB.result.hash);

    const replay = await get(`/matches/${matchA.id}/replay?every=20`);
    expect(replay.verified).toBe(true);
    expect(replay.frames).toHaveLength(10);
  });

  it("rates a ranked tournament on its ladder", async () => {
    const strong = await submit(forager("Strong"));
    const idle = await submit(`export default { name: "Idle", diet: "herbivore", traits: { size: 1 } };`);
    const { body: run } = await post("/tournaments", {
      entrants: [strong, idle],
      format: "round-robin",
      seeds: 2,
      world: SMALL_WORLD,
      ladder: "test-ladder",
      wait: true,
    });
    expect(run.status).toBe("done");
    expect(run.spec.seeds[0]).not.toBe("bench-0");
    const board = await get("/ladders/test-ladder");
    expect(board.map((r: { name: string }) => r.name)).toEqual(["Strong", "Idle"]);
    expect(board[0].rating).toBeGreaterThan(1500);
    expect(board[0].matches).toBe(2);
  });

  it("rejects oversized or malformed runs", async () => {
    const hash = await submit(forager("Limits"));
    expect((await post("/evaluations", { creature: hash, seeds: 1000 })).status).toBe(400);
    expect((await post("/matches", { entrants: [hash], world: { maxTicks: 10_000_000 } })).status).toBe(400);
    expect((await post("/matches", { entrants: ["deadbeefdeadbeef"] })).status).toBe(404);
  });
});

describe("live worlds", () => {
  it("streams frames and stats over WebSocket", async () => {
    const hash = await submit(forager("Live"));
    const { body: world } = await post("/worlds", { name: "stream-test", tps: 50, world: { width: 300, height: 300 } });
    await post(`/worlds/${world.id}/species`, { creature: hash, population: 4 });

    const ws = new WebSocket(`${(await listen()).replace("http", "ws")}/worlds/${world.id}/stream`);
    const seen = new Set<string>();
    let livePop = 0;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out, saw ${[...seen]}`)), 15_000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        seen.add(msg.type);
        if (msg.type === "frame") livePop = msg.frame.e.filter((e: number[]) => e[1] === 1).length;
        if (seen.has("frame") && seen.has("stats") && livePop > 0) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    ws.close();
    expect(livePop).toBeGreaterThan(0);

    await post(`/worlds/${world.id}/control`, { action: "pause" });
    await new Promise((r) => setTimeout(r, 300));
    const t1 = (await get(`/worlds/${world.id}`)).tick;
    await new Promise((r) => setTimeout(r, 300));
    expect((await get(`/worlds/${world.id}`)).tick).toBe(t1);
    expect((await app.inject({ method: "DELETE", url: `/worlds/${world.id}` })).statusCode).toBe(204);
  });

  it("streams the full state of a followed organism", async () => {
    const hash = await submit(forager("Followed"));
    const { body: world } = await post("/worlds", { name: "follow-test", tps: 50, world: { width: 300, height: 300 } });
    await post(`/worlds/${world.id}/species`, { creature: hash, population: 3 });
    const ws = new WebSocket(`${(await listen()).replace("http", "ws")}/worlds/${world.id}/stream`);
    const focus = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no focus message")), 15_000);
      let asked = false;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "frame" && !asked) {
          const animal = msg.frame.e.find((e: number[]) => e[1] === 1);
          if (animal) {
            asked = true;
            ws.send(JSON.stringify({ type: "follow", id: animal[0] }));
          }
        }
        if (msg.type === "focus") {
          clearTimeout(t);
          resolve(msg.details[0]);
        }
      });
    });
    ws.close();
    expect(focus).toMatchObject({ alive: true, kind: "animal" });
    expect(focus.c.energy.max).toBeGreaterThan(0);
    expect(focus.c.species.traits).toBeDefined();
    await app.inject({ method: "DELETE", url: `/worlds/${world.id}` });
  });

  it("recolonises a species that died out", async () => {
    const hash = await submit(forager("Phoenix"));
    const { body: w } = await post("/worlds", { name: "phoenix", tps: 200, recolonizeAfter: 20, world: { width: 200, height: 200 } });
    await post(`/worlds/${w.id}/species`, { creature: hash, population: 0 });
    const deadline = Date.now() + 15_000;
    let info = await get(`/worlds/${w.id}`);
    while (Date.now() < deadline && !info.notices.some((n: { message: string }) => n.message.includes("founders arrived"))) {
      await new Promise((r) => setTimeout(r, 100));
      info = await get(`/worlds/${w.id}`);
    }
    expect(info.notices.map((n: { message: string }) => n.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("died out"), "4 Phoenix founders arrived."]),
    );
    await app.inject({ method: "DELETE", url: `/worlds/${w.id}` });
  });

  it("moves migrating organisms into another world", async () => {
    const hash = await submit(nomad);
    const config = { tps: 100, world: { width: 200, height: 200, params: { plants: { initial: 0, spontaneousPerTick: 0 } } } };
    const { body: a } = await post("/worlds", { name: "a", ...config });
    const { body: b } = await post("/worlds", { name: "b", ...config });
    await post(`/worlds/${a.id}/species`, { creature: hash, population: 5 });

    const deadline = Date.now() + 15_000;
    let arrived = 0;
    while (Date.now() < deadline) {
      const info = await get(`/worlds/${b.id}`);
      arrived = info.species.find((s: { codeHash: string }) => s.codeHash === hash)?.population ?? 0;
      if (arrived > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(arrived).toBeGreaterThan(0);
    await app.inject({ method: "DELETE", url: `/worlds/${a.id}` });
    await app.inject({ method: "DELETE", url: `/worlds/${b.id}` });
  });
});
