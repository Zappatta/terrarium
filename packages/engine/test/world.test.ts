import { describe, expect, it } from "vitest";
import { defineSpecies } from "@terrarium/sdk";
import { NativeController, World, standardModules } from "@terrarium/engine";
import { makeWorld, wanderer } from "./helpers.js";

describe("trait validation", () => {
  const world = new World(standardModules(), { traitBudget: 30 });
  const base = { name: "x", diet: "herbivore" as const };

  it("fills defaults and accepts a legal build", () => {
    expect(world.validateTraits({ ...base, traits: { size: 3 } })).toMatchObject({ size: 3, speed: 3, sight: 3 });
  });

  it.each([
    [{ wings: 3 }, /Unknown trait/],
    [{ size: 0 }, /size must be/],
    [{ size: 2.5 }, /size must be/],
    [{ size: 10, speed: 10, sight: 10, attack: 10 }, /budget/],
  ])("rejects %j", (traits, error) => {
    expect(() => world.validateTraits({ ...base, traits })).toThrow(error);
  });

  it("rejects an invalid diet", () => {
    expect(() => world.validateTraits({ name: "x", diet: "omnivore" as never, traits: {} })).toThrow(/diet/);
  });
});

describe("determinism", () => {
  it("produces identical state for the same seed", () => {
    const run = () => {
      const w = makeWorld({ a: wanderer, b: wanderer }, { seed: "det" });
      w.run(400);
      return w.hash();
    };
    expect(run()).toBe(run());
  });

  it("produces different state for different seeds", () => {
    const run = (seed: string) => {
      const w = makeWorld({ a: wanderer }, { seed });
      w.run(100);
      return w.hash();
    };
    expect(run("s1")).not.toBe(run("s2"));
  });
});

describe("untrusted output", () => {
  it("ignores actions aimed at other species' organisms and malformed entries", () => {
    let victimIds: number[] = [];
    const puppeteer = defineSpecies({
      name: "Puppeteer",
      diet: "herbivore",
      traits: {},
      thinkAll: () =>
        [
          ...victimIds.map((id) => [id, { type: "move", to: { x: 0, y: 0 } }]),
          "garbage",
          [null, null],
          [1, { type: 42 }],
        ] as never,
    });
    const victim = defineSpecies({
      name: "Victim",
      diet: "herbivore",
      traits: {},
      think(me) {
        victimIds.push(me.self.id);
      },
    });
    const w = makeWorld({ a: puppeteer, b: victim });
    w.step();
    w.step();
    const victims = w.all("animal").filter((e) => e.c.species!.speciesId === "b");
    expect(victims.every((e) => e.c.motion!.target === null)).toBe(true);
  });

  it("reports unknown actions back to the organism", () => {
    const events: string[] = [];
    const confused = defineSpecies({
      name: "Confused",
      diet: "herbivore",
      traits: {},
      think(me) {
        for (const e of me.events) if (e.type === "actionFailed") events.push(e.reason);
        return { type: "fly" } as never;
      },
    });
    const w = makeWorld({ a: confused });
    w.run(3);
    expect(events.some((r) => r.includes("unknown action"))).toBe(true);
  });

  it("counts a throwing brain as a fault without stopping the world", () => {
    const broken = defineSpecies({
      name: "Broken",
      diet: "herbivore",
      traits: {},
      thinkAll() {
        throw new Error("boom");
      },
    });
    const w = makeWorld({ a: broken, b: wanderer });
    w.run(10);
    expect(w.getStats("a")).toMatchObject({ faults: 10, lastError: "boom" });
    expect(w.getStats("b").faults).toBe(0);
  });
});

describe("ecology", () => {
  it("starves organisms that never eat", () => {
    const lazy = defineSpecies({ name: "Lazy", diet: "herbivore", traits: { size: 1 }, think: () => undefined });
    const w = makeWorld({ a: lazy }, { maxTicks: 5000 });
    w.run();
    const s = w.getStats("a");
    expect(s.population).toBe(0);
    expect(s.deaths.starvation).toBe(10);
    expect(w.finished).toBe(true);
  });

  it("lets a foraging species reproduce", () => {
    const w = makeWorld({ a: wanderer }, { maxTicks: 1500 });
    w.run();
    expect(w.getStats("a").births).toBeGreaterThan(10);
  });

  it("turns kills into corpses that carnivores can eat", () => {
    const hunter = defineSpecies({
      name: "Hunter",
      diet: "carnivore",
      traits: { size: 5, speed: 8, sight: 8, attack: 9 },
      think(me) {
        const corpse = me.visible.find((v) => v.kind === "corpse");
        if (corpse) {
          return corpse.distance <= me.self.radius + corpse.radius + 2
            ? { type: "eat", target: corpse.id }
            : { type: "move", to: corpse.pos };
        }
        const prey = me.visible.find((v) => v.kind === "animal" && !v.kin);
        if (prey) {
          return prey.distance <= me.self.radius + prey.radius + 2
            ? { type: "attack", target: prey.id }
            : { type: "move", to: prey.pos };
        }
        if (!me.self.moving) return { type: "move", to: { x: 400, y: 400 } };
      },
    });
    const sitter = defineSpecies({ name: "Sitter", diet: "herbivore", traits: { size: 1 }, think: () => undefined });
    const w = makeWorld({ h: hunter, s: sitter }, { maxTicks: 600, width: 200, height: 200 });
    let ate = 0;
    while (!w.finished) {
      w.step();
      for (const e of w.all("animal")) if (e.c.species!.speciesId === "h") ate = Math.max(ate, e.c.energy!.value);
    }
    expect(w.getStats("h").kills).toBeGreaterThan(0);
    expect(w.getStats("s").deaths.killed).toBeGreaterThan(0);
  });
});

describe("module system", () => {
  it("rejects missing dependencies", () => {
    const [, ...withoutBody] = standardModules();
    expect(() => new World(withoutBody)).toThrow(/requires missing module body/);
  });

  it("accepts a new mechanic as a plug-in module", () => {
    // A burrowing mechanic: a new trait, component, action and visibility rule, no engine changes.
    const burrowing = {
      id: "burrowing",
      requires: ["senses"],
      traits: [{ name: "digging", min: 0, max: 5, default: 0 }],
      actions: [
        {
          type: "burrow" as const,
          handle(_w: World, actor: { c: Record<string, unknown> & { species?: { traits: Record<string, number> } } }) {
            if (!actor.c.species!.traits.digging) return "cannot dig";
            actor.c.burrowed = true;
          },
        },
      ],
      canSee: (_w: World, _viewer: unknown, target: { c: Record<string, unknown> }) => !target.c.burrowed,
    };
    const mole = defineSpecies({
      name: "Mole",
      diet: "herbivore",
      traits: { digging: 2 },
      think: () => ({ type: "burrow" }) as never,
    });
    const seen: number[] = [];
    const watcher = defineSpecies({
      name: "Watcher",
      diet: "herbivore",
      traits: { sight: 10 },
      think(me) {
        seen.push(me.visible.filter((v) => v.kind === "animal" && !v.kin).length);
      },
    });
    const w = new World([...standardModules(), burrowing as never], { seed: "mole", width: 100, height: 100, params: { plants: { initial: 0, spontaneousPerTick: 0 } } });
    w.addSpecies("mole", new NativeController(mole));
    w.addSpecies("watcher", new NativeController(watcher));
    w.run(3);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(0);
  });
});

describe("shared worlds", () => {
  it("spawns a species that joins after the world started", () => {
    const w = makeWorld({ a: wanderer });
    w.run(20);
    w.addSpecies("late", new NativeController(wanderer), 4);
    expect(w.getStats("late").population).toBe(4);
    w.run(5);
    expect(w.getStats("late").faults).toBe(0);
  });

  it("moves an organism between worlds without counting a death", () => {
    const a = makeWorld({ s: wanderer });
    const b = makeWorld({});
    b.addSpecies("s", new NativeController(wanderer), 0);
    a.run(1);
    b.run(1);
    const e = a.all("animal")[0]!;
    const energy = e.c.energy!.value;
    a.emigrate(e, "a");
    const [m] = a.takeEmigrants();
    const arrived = b.immigrate(m!, { x: 1, y: 1 })!;
    expect(arrived.c.energy!.value).toBe(energy);
    expect(a.getStats("s")).toMatchObject({ population: 9, emigrated: 1, deaths: {} });
    expect(b.getStats("s")).toMatchObject({ population: 1, immigrated: 1 });
    expect(a.count("corpse")).toBe(0);
  });
});

describe("removing a species", () => {
  it("removes its members without corpses and keeps the world running", () => {
    const w = makeWorld({ a: wanderer, b: wanderer });
    w.run(20);
    w.removeSpecies("a");
    expect(w.speciesIds()).toEqual(["b"]);
    expect(w.all("animal").every((e) => e.c.species!.speciesId === "b")).toBe(true);
    expect(w.count("corpse")).toBe(0);
    w.run(20);
    expect(w.getStats("b").faults).toBe(0);
  });
});
