import { describe, expect, it } from "vitest";
import { defineSpecies, type SpeciesDefinition } from "@terrarium/sdk";
import { NativeController, World, standardModules } from "@terrarium/engine";
import { FitnessTracker } from "@terrarium/server";

const forage = (breed: boolean, traits: Record<string, number>, name: string) =>
  defineSpecies({
    name,
    diet: "herbivore",
    traits,
    think(me, ctx) {
      if (breed && me.self.canReproduce) return { type: "reproduce" };
      const p = me.visible.find((v) => v.kind === "plant");
      if (p) return p.distance <= me.self.radius + p.radius + 2 ? { type: "eat", target: p.id } : { type: "move", to: p.pos };
      if (!me.self.moving) return { type: "move", to: { x: ctx.random() * 800, y: ctx.random() * 800 } };
    },
  });

function play(species: Record<string, SpeciesDefinition<any, any>>, maxTicks = 1500, seed = "fit") {
  const w = new World(standardModules(), { seed, maxTicks });
  for (const [id, def] of Object.entries(species)) w.addSpecies(id, new NativeController(def));
  const f = new FitnessTracker(w);
  while (!w.finished) {
    w.step();
    f.sample();
  }
  return (id: string) => f.score(id);
}

describe("fitness", () => {
  it("scores within 0-100 and exposes every component", () => {
    const score = play({ a: forage(true, { size: 2, speed: 4, sight: 5 }, "A") }, 600);
    const s = score("a");
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(Object.keys(s.breakdown).sort()).toEqual(["dominance", "finish", "lineage", "survival"]);
  });

  it("rewards breeding over hoarding a big body", () => {
    const score = play({
      breeder: forage(true, { size: 2, speed: 4, sight: 5 }, "Breeder"),
      hoarder: forage(false, { size: 8, speed: 4, sight: 5 }, "Hoarder"),
    });
    expect(score("hoarder").breakdown.lineage).toBe(0);
    expect(score("breeder").breakdown.lineage).toBeGreaterThan(0);
    expect(score("breeder").score).toBeGreaterThan(score("hoarder").score);
  });

  it("counts the scheduled match length, so burning out early is punished", () => {
    const lazy = defineSpecies({ name: "Lazy", diet: "herbivore", traits: { size: 1 }, think: () => undefined });
    const score = play({ lazy }, 3000);
    expect(score("lazy").breakdown.survival).toBeLessThan(0.5);
    expect(score("lazy").breakdown.finish).toBe(0);
  });

  it("measures dominance within a diet, so a lone carnivore is not diluted by herbivore biomass", () => {
    const stalker = defineSpecies({
      name: "Stalker",
      diet: "carnivore",
      traits: { size: 3, speed: 5, sight: 5, attack: 5 },
      think: (me) => ({ type: "move", to: me.self.pos }),
    });
    const score = play({ c: stalker, h: forage(true, { size: 2, speed: 4, sight: 5 }, "H") }, 300);
    expect(score("c").breakdown.dominance).toBeCloseTo(1, 5);
  });
});
