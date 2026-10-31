import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { FastifyInstance } from "fastify";
import { createApp, createServices, googleVerifier } from "@terrarium/server";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const SMALL = { maxTicks: 100, width: 300, height: 300, initialPopulation: 3, params: { plants: { initial: 40, max: 80 } } };

const species = (name: string, salt = "") => `
import { defineSpecies } from "@terrarium/sdk";
export default defineSpecies({ name: "${name}", diet: "herbivore", traits: { size: 2 }, think(me, ctx) { ctx.log("secret plan ${salt}"); } });`;

let dir: string;
let services: Awaited<ReturnType<typeof createServices>>;
let app: FastifyInstance;
let signGoogle: (claims: Record<string, unknown>, audience?: string) => Promise<string>;

async function req(method: "GET" | "POST" | "DELETE", url: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const r = await app.inject({ method, url, headers, payload: opts.body as object | undefined });
  return { status: r.statusCode, body: r.body ? r.json() : null, cookie: r.headers["set-cookie"] as string | undefined };
}
const devLogin = async (name: string) => String((await req("POST", "/auth/dev", { body: { name } })).cookie).split(";")[0]!;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  signGoogle = (claims, audience = CLIENT_ID) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://accounts.google.com")
      .setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  dir = mkdtempSync(join(tmpdir(), "terrarium-auth-"));
  services = await createServices({
    dbPath: join(dir, "t.db"),
    workers: 1,
    devLogin: true,
    admins: ["boss@dev.local"],
    googleClientId: CLIENT_ID,
    verifyGoogle: googleVerifier(CLIENT_ID, createLocalJWKSet({ keys: [jwk] })),
  });
  app = await createApp(services);
});

afterAll(async () => {
  await app.close();
  await services.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Google sign-in", () => {
  it("accepts a valid Google ID token and starts a session", async () => {
    const credential = await signGoogle({ sub: "g-123", email: "ada@example.com", email_verified: true, name: "Ada" });
    const r = await req("POST", "/auth/google", { body: { credential } });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: "ada@example.com", name: "Ada", isAdmin: false });
    expect(r.cookie).toMatch(/terrarium_session=trs_.*HttpOnly; SameSite=Lax/);
    const me = await req("GET", "/me", { cookie: r.cookie!.split(";")[0] });
    expect(me.body.user.email).toBe("ada@example.com");
  });

  it("keeps one account per Google user across sign-ins", async () => {
    const a = await req("POST", "/auth/google", { body: { credential: await signGoogle({ sub: "g-9", email: "x@example.com", email_verified: true, name: "X" }) } });
    const b = await req("POST", "/auth/google", { body: { credential: await signGoogle({ sub: "g-9", email: "x@example.com", email_verified: true, name: "X Renamed" }) } });
    expect(b.body.user.id).toBe(a.body.user.id);
    expect(b.body.user.name).toBe("X Renamed");
  });

  it.each([
    ["another app's token", { sub: "g-1", email: "e@example.com", email_verified: true }, "other-app"],
    ["an unverified email", { sub: "g-2", email: "e@example.com", email_verified: false }, CLIENT_ID],
  ])("rejects %s", async (_label, claims, audience) => {
    const r = await req("POST", "/auth/google", { body: { credential: await signGoogle(claims, audience) } });
    expect(r.status).toBe(401);
  });

  it("rejects a forged token", async () => {
    const r = await req("POST", "/auth/google", { body: { credential: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl" } });
    expect(r.status).toBe(401);
  });

  it("ends the session on logout", async () => {
    const cookie = await devLogin("Leaver");
    await req("POST", "/auth/logout", { cookie });
    expect((await req("GET", "/me", { cookie })).body.user).toBeNull();
  });
});

describe("ownership", () => {
  it("requires an account to upload", async () => {
    expect((await req("POST", "/creatures", { body: { source: species("Anon") } })).status).toBe(401);
  });

  it("versions re-uploads of the same species name per owner", async () => {
    const alice = await devLogin("Alice");
    const v1 = await req("POST", "/creatures", { cookie: alice, body: { source: species("Twin", "1") } });
    const v2 = await req("POST", "/creatures", { cookie: alice, body: { source: species("Twin", "2") } });
    expect([v1.body.creature.version, v2.body.creature.version]).toEqual([1, 2]);
    expect(v2.body.creature.author).toBe("Alice");
    const bob = await devLogin("Bob");
    const other = await req("POST", "/creatures", { cookie: bob, body: { source: species("Twin", "bob") } });
    expect(other.body.creature.version).toBe(1);
    const mine = await req("GET", "/creatures?mine=1", { cookie: alice });
    expect(mine.body.map((c: { name: string }) => c.name)).toEqual(["Twin", "Twin"]);
  });

  it("hides source code from everyone but the owner", async () => {
    const alice = await devLogin("Alice");
    const bob = await devLogin("Bob");
    const { body } = await req("POST", "/creatures", { cookie: alice, body: { source: species("Private") } });
    const hash = body.creature.codeHash;
    expect((await req("GET", `/creatures/${hash}?source=1`, { cookie: alice })).body.source).toContain("Private");
    expect((await req("GET", `/creatures/${hash}?source=1`, { cookie: bob })).status).toBe(403);
    expect((await req("GET", `/creatures/${hash}?source=1`)).status).toBe(403);
    const builtin = (await req("GET", "/creatures?builtin=true")).body[0];
    expect((await req("GET", `/creatures/${builtin.codeHash}?source=1`)).body.source).toBeTruthy();
  });

  it("lets users evaluate only their own or builtin creatures, and hides their logs from others", async () => {
    const alice = await devLogin("Alice");
    const bob = await devLogin("Bob");
    const hash = (await req("POST", "/creatures", { cookie: alice, body: { source: species("Logger") } })).body.creature.codeHash;
    expect((await req("POST", "/evaluations", { cookie: bob, body: { creature: hash, seeds: 1, world: SMALL } })).status).toBe(403);

    const run = await req("POST", "/evaluations", { cookie: alice, body: { creature: hash, seeds: 1, world: SMALL, wait: true } });
    expect(run.body.status).toBe("done");
    const matchId = (await req("GET", `/runs/${run.body.id}?matches=1`, { cookie: alice })).body.matches[0].id;
    const logsFor = async (cookie?: string) =>
      (await req("GET", `/matches/${matchId}`, { cookie })).body.result.entrants.find((e: { codeHash: string }) => e.codeHash === hash).stats.logs;
    expect((await logsFor(alice)).join()).toContain("secret plan");
    expect(await logsFor(bob)).toEqual([]);
    expect(await logsFor()).toEqual([]);
  });
});

describe("API keys", () => {
  it("lets scripts act as the user, and stops working once revoked", async () => {
    const alice = await devLogin("Alice");
    const created = await req("POST", "/me/api-keys", { cookie: alice, body: { name: "my agent" } });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^trk_/);

    const upload = await req("POST", "/creatures", { bearer: key, body: { source: species("ViaKey") } });
    expect(upload.status).toBe(201);
    expect(upload.body.creature.author).toBe("Alice");

    const keys = (await req("GET", "/me/api-keys", { cookie: alice })).body;
    expect(keys[0]).toMatchObject({ name: "my agent", prefix: key.slice(0, 12) });
    expect(JSON.stringify(keys)).not.toContain(key);

    expect((await req("DELETE", `/me/api-keys/${created.body.id}`, { cookie: alice })).status).toBe(204);
    expect((await req("POST", "/creatures", { bearer: key, body: { source: species("ViaKey", "2") } })).status).toBe(401);
  });

  it("cannot revoke someone else's key", async () => {
    const alice = await devLogin("Alice");
    const bob = await devLogin("Bob");
    const { body } = await req("POST", "/me/api-keys", { cookie: alice, body: { name: "k" } });
    expect((await req("DELETE", `/me/api-keys/${body.id}`, { cookie: bob })).status).toBe(404);
  });
});

describe("admin-only actions", () => {
  it("keeps live-world control and rated tournaments for admins", async () => {
    const alice = await devLogin("Alice");
    const boss = await devLogin("Boss");
    expect((await req("POST", "/worlds", { cookie: alice, body: { name: "nope" } })).status).toBe(403);
    const world = await req("POST", "/worlds", { cookie: boss, body: { name: "ok", tps: 5 } });
    expect(world.status).toBe(201);
    expect((await req("POST", `/worlds/${world.body.id}/control`, { cookie: alice, body: { action: "pause" } })).status).toBe(403);
    await req("DELETE", `/worlds/${world.body.id}`, { cookie: boss });

    const a = (await req("POST", "/creatures", { cookie: alice, body: { source: species("TA") } })).body.creature.codeHash;
    const b = (await req("POST", "/creatures", { cookie: alice, body: { source: species("TB") } })).body.creature.codeHash;
    const rated = await req("POST", "/tournaments", { cookie: alice, body: { entrants: [a, b], ladder: "main", seeds: 1, world: SMALL } });
    expect(rated.status).toBe(403);
    const unrated = await req("POST", "/tournaments", { cookie: alice, body: { entrants: [a, b], seeds: 1, world: SMALL } });
    expect(unrated.status).toBe(202);
    expect(unrated.body.spec.ladder).toBeNull();
  });

  it("refuses development sign-in when it is switched off", async () => {
    const strict = await createServices({ dbPath: join(dir, "strict.db"), workers: 1, seedBuiltins: false });
    const strictApp = await createApp(strict);
    const r = await strictApp.inject({ method: "POST", url: "/auth/dev", payload: { name: "Mallory" } });
    expect(r.statusCode).toBe(404);
    await strictApp.close();
    await strict.close();
  });
});
