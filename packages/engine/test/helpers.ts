import { defineSpecies, type SpeciesDefinition } from "@terrarium/sdk";
import { NativeController, World, standardModules, type RuleModule, type WorldConfig } from "@terrarium/engine";

export const wanderer = defineSpecies({
  name: "Wanderer",
  diet: "herbivore",
  traits: { size: 2, speed: 4, sight: 4 },
  think(me, ctx) {
    const plant = me.visible.find((v) => v.kind === "plant");
    if (me.self.canReproduce) return { type: "reproduce" };
    if (plant && plant.distance <= me.self.radius + plant.radius + 2) return { type: "eat", target: plant.id };
    if (plant) return { type: "move", to: plant.pos };
    if (!me.self.moving) return { type: "move", to: { x: ctx.random() * 800, y: ctx.random() * 800 } };
  },
});

export function makeWorld(
  species: Record<string, SpeciesDefinition<any, any>>,
  config: Partial<WorldConfig> = {},
  modules: RuleModule[] = standardModules(),
): World {
  const world = new World(modules, { seed: "test", maxTicks: 500, ...config });
  for (const [id, def] of Object.entries(species)) world.addSpecies(id, new NativeController(def));
  return world;
}
