import { describe, expect, it } from "vitest";
import { defineSpecies, definePlant, type PlantPerception, type SpeciesDefinition, type PlantDefinition } from "@terrarium/sdk";
import { NativeController, World, standardModules, type Entity } from "@terrarium/engine";

const NO_WILD = { plants: { initial: 0, spontaneousPerTick: 0 } };

function world(species: Record<string, SpeciesDefinition<any, any> | PlantDefinition<any, any>>, config = {}) {
  const w = new World(standardModules(), { seed: "flora", maxTicks: 2000, params: NO_WILD, ...config });
  for (const [id, def] of Object.entries(species)) w.addSpecies(id, new NativeController(def as never));
  return w;
}

const passive = (traits: Record<string, number>, name = "P") =>
  definePlant({ name, diet: "plant", traits, think: () => undefined });

/** An herbivore that only eats, standing still, so every bite lands on whatever plant is nearest. */
const eater = defineSpecies({
  name: "Eater",
  diet: "herbivore",
  traits: { size: 3, sight: 6 },
  think(me) {
    const p = me.visible.find((v) => v.kind === "plant");
    if (!p) return;
    return p.distance <= me.self.radius + p.radius + 2 ? { type: "eat", target: p.id } : { type: "move", to: p.pos };
  },
});

describe("plant species", () => {
  it("only accepts plant traits, and rejects plant traits on animals", () => {
    const w = new World(standardModules());
    expect(w.validateTraits({ name: "p", diet: "plant", traits: { size: 2, thorns: 4 } })).toMatchObject({ size: 2, thorns: 4, growth: 3 });
    expect(() => w.validateTraits({ name: "p", diet: "plant", traits: { speed: 3 } })).toThrow(/not available to plant/);
    expect(() => w.validateTraits({ name: "a", diet: "herbivore", traits: { thorns: 3 } })).toThrow(/not available to herbivore/);
  });

  it("spawns stationary plant organisms that cannot move, eat or attack", () => {
    const reasons: string[] = [];
    const restless = definePlant({
      name: "Restless",
      diet: "plant",
      traits: {},
      think(me: PlantPerception) {
        for (const e of me.events) if (e.type === "actionFailed") reasons.push(e.reason);
        const tries = [{ type: "move", to: { x: 0, y: 0 } }, { type: "eat", target: 1 }, { type: "attack", target: 1 }, { type: "reproduce" }];
        return tries[reasons.length % tries.length] as never;
      },
    });
    const w = world({ r: restless }, { plantThinkInterval: 1 });
    w.step();
    const start = { id: w.all("plant")[0]!.id, pos: { ...w.all("plant")[0]!.pos } };
    w.run(6);
    expect(w.all("plant").every((e) => e.c.species)).toBe(true);
    expect(reasons).toEqual(expect.arrayContaining(["plants cannot move", "plants cannot eat", "plants cannot attack", "plants reproduce with the seed action"]));
    expect(w.get(start.id)?.pos).toEqual(start.pos);
  });

  it("only asks plant species to decide every plantThinkInterval ticks", () => {
    let calls = 0;
    const counter = definePlant({ name: "C", diet: "plant", traits: {}, thinkAll: () => (calls++, []) });
    world({ c: counter }, { plantThinkInterval: 5 }).run(20);
    expect(calls).toBe(4);
  });

  it("throws seeds toward the target, no further than seedRange", () => {
    const sower = definePlant({
      name: "Sower",
      diet: "plant",
      traits: { seedRange: 2 },
      think: (me) => (me.self.canSeed ? { type: "seed", to: { x: me.self.pos.x + 1000, y: me.self.pos.y } } : undefined),
    });
    const w = world({ s: sower }, { initialPlantPopulation: 1, plantThinkInterval: 1 });
    w.step();
    const parent = w.all("plant")[0]!;
    parent.c.age!.ticks = 1000;
    parent.c.energy!.value = parent.c.energy!.max;
    w.run(2);
    const child = w.all("plant").find((e) => e.c.species!.parentId === parent.id)!;
    expect(child).toBeDefined();
    expect(child.pos.y).toBeCloseTo(parent.pos.y, 6);
    expect(child.pos.x - parent.pos.x).toBeCloseTo(15 + 9 * 2, 6);
    expect(child.c.species!.generation).toBe(1);
  });

  it("grows slower in the shade of neighbours", () => {
    const w = world({ p: passive({ size: 3 }) }, { initialPlantPopulation: 0 });
    w.step();
    const lone = w.spawnOrganism("p", { x: 100, y: 100 })!;
    const crowded = w.spawnOrganism("p", { x: 600, y: 600 })!;
    for (let i = 0; i < 4; i++) w.spawnOrganism("p", { x: 600 + Math.cos(i) * 8, y: 600 + Math.sin(i) * 8 });
    w.step();
    expect(lone.c.flora!.light).toBe(1);
    expect(crowded.c.flora!.light).toBeLessThan(0.5);
  });
});

describe("plant defences", () => {
  function graze(plantTraits: Record<string, number>, defend = 0) {
    const plant = definePlant({ name: "D", diet: "plant", traits: plantTraits, think: () => ({ type: "defend", level: defend }) });
    const w = world({ p: plant, e: eater }, { initialPlantPopulation: 0, initialPopulation: 0, plantThinkInterval: 1 });
    w.step();
    const target = w.spawnOrganism("p", { x: 400, y: 400 }, { energyFraction: 1 })!;
    const animal = w.spawnOrganism("e", { x: 405, y: 400 }, { energyFraction: 0.3 })!;
    const before = { energy: animal.c.energy!.value, health: animal.c.health!.value, plant: target.c.energy!.value };
    w.step();
    w.step();
    return { w, animal, target, before };
  }

  const gained = (r: ReturnType<typeof graze>) => r.animal.c.energy!.value - r.before.energy;
  const bitten = (r: ReturnType<typeof graze>) => r.before.plant - r.target.c.energy!.value;

  it("thorns hurt the eater", () => {
    const r = graze({ thorns: 8 });
    expect(r.animal.c.health!.value).toBeLessThan(r.before.health);
  });

  it("toxins cut what the eater gains, and active defence makes them worse", () => {
    const plain = gained(graze({}));
    const toxic = gained(graze({ toxin: 5 }));
    const alarmed = gained(graze({ toxin: 5 }, 1));
    expect(toxic).toBeLessThan(plain);
    expect(alarmed).toBeLessThan(toxic);
  });

  it("toughness shrinks bites", () => {
    expect(bitten(graze({ toughness: 8 }))).toBeLessThan(bitten(graze({})));
  });

  it("tells the plant it was grazed", () => {
    const seen: string[] = [];
    const plant = definePlant({ name: "Aware", diet: "plant", traits: {}, think(me) { for (const e of me.events) seen.push(e.type); } });
    const w = world({ p: plant, e: eater }, { initialPlantPopulation: 0, initialPopulation: 0, plantThinkInterval: 1 });
    w.step();
    w.spawnOrganism("p", { x: 400, y: 400 }, { energyFraction: 1 });
    w.spawnOrganism("e", { x: 405, y: 400 });
    w.run(3);
    expect(seen).toContain("grazed");
  });
});

describe("plant scoring hooks", () => {
  it("counts plant energy as species biomass", () => {
    const w = world({ p: passive({ size: 4 }) }, { initialPlantPopulation: 5 });
    w.run(10);
    const total = w.all("plant").reduce((a: number, e: Entity) => a + e.c.energy!.value, 0);
    expect(w.getStats("p").biomass).toBeCloseTo(total, 6);
  });
});
