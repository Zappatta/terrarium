import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, createServices } from "@terrarium/server";

let dir: string;
let dbPath: string;
let services: Awaited<ReturnType<typeof createServices>>;
let app: FastifyInstance;
let boss: string;
let alice: string;
let builtins: Array<{ codeHash: string; name: string }>;

async function req(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie?: string, body?: unknown, on = app) {
  const r = await on.inject({ method, url, headers: cookie ? { cookie } : {}, payload: body as object | undefined });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const login = async (name: string, on = app) =>
  String((await on.inject({ method: "POST", url: "/auth/dev", payload: { name } })).headers["set-cookie"]).split(";")[0]!;

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

const options = () => ({ dbPath, workers: 1, devLogin: true, admins: ["boss@dev.local"] });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-admin-"));
  dbPath = join(dir, "t.db");
  services = await createServices(options());
  app = await createApp(services);
  boss = await login("Boss");
  alice = await login("Alice");
  builtins = (await req("GET", "/creatures?builtin=true")).body;
});

afterAll(async () => {
  await app.close();
  await services.close();
  rmSync(dir, { recursive: true, force: true });
});

const grazer = () => builtins.find((c) => c.name === "Grazer")!;
const hunter = () => builtins.find((c) => c.name === "Hunter")!;

describe("backoffice access", () => {
  it.each(["/admin/overview", "/admin/users", "/admin/runs"])("keeps %s for admins", async (url) => {
    expect((await req("GET", url)).status).toBe(401);
    expect((await req("GET", url, alice)).status).toBe(403);
    expect((await req("GET", url, boss)).status).toBe(200);
  });

  it("serves the backoffice page and lists users with their counts", async () => {
    expect((await app.inject({ method: "GET", url: "/admin" })).body).toContain("Backoffice");
    const users = (await req("GET", "/admin/users", boss)).body;
    expect(users.find((u: { name: string }) => u.name === "Boss")).toMatchObject({ isAdmin: true, creatures: 0 });
    expect(users.find((u: { name: string }) => u.name === "Alice")).toMatchObject({ isAdmin: false });
  });

  it("refuses world management to non-admins", async () => {
    const w = (await req("POST", "/worlds", boss, { name: "Guarded", tps: 5 })).body;
    expect((await req("PATCH", `/worlds/${w.id}`, alice, { name: "Mine now" })).status).toBe(403);
    expect((await req("POST", `/worlds/${w.id}/restart`, alice)).status).toBe(403);
    expect((await req("DELETE", `/worlds/${w.id}/species/${grazer().codeHash}`, alice)).status).toBe(403);
    expect((await req("DELETE", `/worlds/${w.id}`, alice)).status).toBe(403);
    await req("DELETE", `/worlds/${w.id}`, boss);
  });
});

describe("managing worlds", () => {
  it("creates a world with starting species, renames it, and removes a species", async () => {
    const created = await req("POST", "/worlds", boss, {
      name: "Garden",
      tps: 50,
      world: { width: 300, height: 300 },
      species: [{ creature: grazer().codeHash, population: 4 }, { creature: hunter().codeHash, population: 2 }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const both = await until(() => req("GET", `/worlds/${id}`).then((r) => r.body), (w) => w.species.length === 2);
    expect(both.species.map((s: { name: string }) => s.name).sort()).toEqual(["Grazer", "Hunter"]);

    expect((await req("PATCH", `/worlds/${id}`, boss, { name: "Walled garden", tps: 40 })).body.name).toBe("Walled garden");

    expect((await req("DELETE", `/worlds/${id}/species/${hunter().codeHash}`, boss)).status).toBe(204);
    const one = await until(() => req("GET", `/worlds/${id}`).then((r) => r.body), (w) => w.species.length === 1);
    expect(one.species[0].name).toBe("Grazer");
    expect(one.config.startingSpecies).toEqual([{ codeHash: grazer().codeHash, population: 4 }]);
    await req("DELETE", `/worlds/${id}`, boss);
  });

  it("restarts a world from tick 0 with the same id", async () => {
    const id = (await req("POST", "/worlds", boss, { name: "Phoenix", tps: 200, world: { width: 200, height: 200 } })).body.id;
    await until(() => req("GET", `/worlds/${id}`).then((r) => r.body.tick), (t) => t >= 30);
    const restarted = await req("POST", `/worlds/${id}/restart`, boss);
    expect(restarted.body.id).toBe(id);
    expect(restarted.body.tick).toBeLessThan(30);
    await req("DELETE", `/worlds/${id}`, boss);
  });

  it("brings saved worlds back after a server restart, and forgets deleted ones", async () => {
    const kept = (await req("POST", "/worlds", boss, { name: "Survivor", tps: 7, species: [{ creature: grazer().codeHash, population: 3 }] })).body.id;
    const gone = (await req("POST", "/worlds", boss, { name: "Doomed" })).body.id;
    await req("DELETE", `/worlds/${gone}`, boss);

    await services.live.closeAll();
    const second = await createServices(options());
    const secondApp = await createApp(second);
    try {
      expect(second.live.restoreAll()).toBeGreaterThanOrEqual(1);
      const worlds = (await req("GET", "/worlds", undefined, undefined, secondApp)).body;
      const survivor = worlds.find((w: { id: string }) => w.id === kept);
      expect(survivor).toMatchObject({ name: "Survivor" });
      expect(worlds.some((w: { id: string }) => w.id === gone)).toBe(false);
      const withSpecies = await until(
        () => req("GET", `/worlds/${kept}`, undefined, undefined, secondApp).then((r) => r.body),
        (w) => w.species.length === 1,
      );
      expect(withSpecies.species[0].name).toBe("Grazer");
      expect(withSpecies.tps ?? 7).toBe(7);
    } finally {
      await secondApp.close();
      await second.close();
    }
    services.live.restoreAll();
  });
});
