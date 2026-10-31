import { describe, expect, it } from "vitest";
import { World, standardModules } from "@terrarium/engine";
import { CompileError, SandboxController, compileCreature } from "@terrarium/sandbox";
import type { DecideInput } from "@terrarium/sdk";

const species = (body: string, header = `name: "T", diet: "herbivore", traits: {},`) => `
import { defineSpecies } from "@terrarium/sdk";
export default defineSpecies({ ${header} ${body} });
`;

const load = async (src: string, limits = {}) =>
  SandboxController.create(await compileCreature(src), { limits, isolation: "runtime" });

const input = (n = 1): DecideInput => ({
  world: { tick: 1, width: 100, height: 100, speciesId: "t", rules: [], plantThinkInterval: 5 },
  organisms: Array.from({ length: n }, (_, i) => ({
    self: { id: i + 1 } as never,
    visible: [],
    events: [],
  })),
  died: [],
});

describe("compile", () => {
  it("compiles TypeScript and reads the descriptor", async () => {
    const c = await load(species("", `name: "Typed", diet: "carnivore", traits: { size: 4 } as Record<string, number>,`));
    expect(c.descriptor).toEqual({ name: "Typed", diet: "carnivore", traits: { size: 4 } });
    expect(c.codeHash).toMatch(/^[0-9a-f]{64}$/);
    c.dispose();
  });

  it.each(["node:fs", "fs", "./other", "https://evil.example/x.js"])("rejects importing %s", async (mod) => {
    await expect(compileCreature(`import x from "${mod}"; export default x;`)).rejects.toThrow(CompileError);
  });

  it("reports syntax errors with a location", async () => {
    await expect(compileCreature("export default {", "bad.ts")).rejects.toThrow(/bad\.ts:1:/);
  });
});

describe("isolation", () => {
  it("exposes no host or non-deterministic globals", async () => {
    const c = await load(
      species(`think(me, ctx) {
        ctx.log([typeof process, typeof globalThis.require, typeof Date, typeof WeakRef, typeof fetch, typeof setTimeout, typeof globalThis.__hostLog].join(","));
      },`),
    );
    const r = c.decide(input());
    expect(r.logs).toEqual(["undefined,undefined,undefined,undefined,undefined,undefined,undefined"]);
    c.dispose();
  });

  it("cannot replace Math.random", async () => {
    const c = await load(species(`think(me, ctx) { try { Math.random = () => 0.5; } catch (e) {} ctx.log(String(Math.random() !== 0.5)); },`));
    expect(c.decide(input()).logs).toEqual(["true"]);
    c.dispose();
  });
});

describe("limits", () => {
  it("stops an infinite loop with an out-of-fuel fault and keeps working afterwards", async () => {
    const c = await load(species(`thinkAll(orgs, ctx) { if (ctx.world.tick === 1) { while (true) {} } return []; },`));
    const first = c.decide(input());
    expect(first.error).toMatch(/out of fuel/);
    expect(first.hostFault).toBeUndefined();
    const second = c.decide({ ...input(), world: { ...input().world, tick: 2 } });
    expect(second.error).toBeUndefined();
    expect(second.output).toEqual({ actions: [] });
    c.dispose();
  });

  it("cannot catch the out-of-fuel interrupt", async () => {
    const c = await load(species(`think(me, ctx) { for (;;) { try { while (true) {} } catch (e) {} } },`));
    expect(c.decide(input()).error).toMatch(/out of fuel/);
    c.dispose();
  });

  it("refuses to load code that loops at top level", async () => {
    await expect(load(`while (true) {} export default {};`)).rejects.toThrow(/failed to load/);
  });

  it("contains memory exhaustion", async () => {
    const c = await load(
      species(`thinkAll() { const a = []; for (;;) a.push(new Array(10000).fill(1)); },`),
      { memoryBytes: 8 * 1024 * 1024, fuelBase: 100000, fuelMax: 100000 },
    );
    const r = c.decide(input());
    expect(r.error).toBeDefined();
    c.dispose();
  });

  it("caps log output", async () => {
    const c = await load(species(`think(me, ctx) { for (let i = 0; i < 100; i++) console.log("x".repeat(1000)); },`));
    const r = c.decide(input());
    expect(r.logs).toHaveLength(20);
    expect(r.logs![0]).toHaveLength(300);
    c.dispose();
  });

  it("scales fuel with population", async () => {
    // ~30 fuel of work per organism: fine for a few, too much for 400 under the default cap.
    const src = species(`think(me) { let s = 0; for (let i = 0; i < 150000; i++) s += i; return { type: "idle" }; },`);
    const c = await load(src);
    expect(c.decide(input(2)).error).toBeUndefined();
    expect(c.decide(input(400)).error).toMatch(/out of fuel/);
    c.dispose();
  });
});

describe("reproducibility", () => {
  const forager = species(
    `think(me, ctx) {
      const p = me.visible.find((v) => v.kind === "plant");
      if (me.self.canReproduce) return { type: "reproduce" };
      if (p && p.distance <= me.self.radius + p.radius + 2) return { type: "eat", target: p.id };
      if (p) return { type: "move", to: p.pos };
      if (!me.self.moving) return { type: "move", to: { x: Math.random() * 800, y: ctx.random() * 800 } };
    },`,
    `name: "Forager", diet: "herbivore", traits: { size: 2, speed: 4, sight: 4 },`,
  );

  const run = async (seed: string) => {
    const code = await compileCreature(forager);
    const w = new World(standardModules(), { seed, maxTicks: 400 });
    w.addSpecies("a", await SandboxController.create(code));
    w.addSpecies("b", await SandboxController.create(code));
    w.run();
    const h = w.hash();
    w.dispose();
    return h;
  };

  it("replays a sandboxed match exactly", async () => {
    expect(await run("replay")).toBe(await run("replay"));
  });

  it("seeds Math.random per species and world", async () => {
    expect(await run("replay")).not.toBe(await run("other"));
  });
});

describe("binary transfer", () => {
  it("delivers the same perception as the plain JSON format", async () => {
    const { encodeBinary } = await import("../src/wire.js");
    const { SPECIES_RUNTIME_SOURCE } = await import("@terrarium/sdk");
    const { NativeController } = await import("@terrarium/engine");
    // Decode in the host with the same runtime source, then compare with the original input.
    const createRuntime = new Function(`${SPECIES_RUNTIME_SOURCE}; return __createSpeciesRuntime;`)();
    const rt = createRuntime({ name: "x", diet: "herbivore", traits: {} }, Math.random, () => {});
    const world = new World(standardModules(), { seed: "wire", maxTicks: 300 });
    const captured: DecideInput[] = [];
    const spy = {
      descriptor: { name: "Spy", diet: "herbivore" as const, traits: {} },
      decide(i: DecideInput) {
        captured.push(structuredClone(i));
        return { output: { actions: [] } };
      },
    };
    world.addSpecies("spy", spy);
    world.addSpecies("other", new NativeController({ name: "O", diet: "carnivore", traits: {}, think: () => undefined }));
    world.run(150);
    expect(captured.length).toBeGreaterThan(100);
    for (const input of captured.filter((_, i) => i % 10 === 0)) {
      const wire = encodeBinary(input)!;
      expect(rt.decodeBinary(wire.header, wire.buffer)).toEqual(input);
    }
  });
});
