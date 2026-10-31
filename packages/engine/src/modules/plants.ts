import type { Vec2 } from "@terrarium/sdk";
import type { RuleModule } from "../types.js";
import type { World } from "../world.js";
import { moduleParams } from "../params.js";

export interface PlantComponent {
  growth: number;
  seedTimer: number;
}

declare module "../types.js" {
  interface Components {
    plant: PlantComponent;
  }
}

export const PLANTS = "plants";
export const plantParams = moduleParams(PLANTS, {
  initial: 250,
  max: 400,
  maxEnergy: 60,
  startEnergy: 20,
  growth: 0.15,
  radius: 4,
  seedInterval: 120,
  seedReadyFraction: 0.7,
  seedRange: 40,
  /** Seeding fails if this many plants are already within seedRange. */
  crowding: 4,
  spontaneousPerTick: 0.3,
});

function spawnPlant(world: World, pos: Vec2): void {
  const p = plantParams(world);
  world.spawn("plant", pos, p.radius, {
    energy: { value: p.startEnergy, max: p.maxEnergy },
    plant: { growth: p.growth, seedTimer: p.seedInterval },
  });
}

export const plants: RuleModule = {
  id: PLANTS,
  init(world) {
    const rng = world.rng.fork("plants:init");
    for (let i = 0; i < plantParams(world).initial; i++) {
      spawnPlant(world, { x: rng.range(0, world.config.width), y: rng.range(0, world.config.height) });
    }
  },
  systems: [
    {
      phase: "environment",
      run(world) {
        const p = plantParams(world);
        const rng = world.rng.fork(`plants:${world.tick}`);
        // Wild plants only; plant species are run by the flora module.
        const wild = world.all("plant").filter((e) => !e.c.species);
        let count = wild.length;
        for (const e of wild) {
          const energy = e.c.energy!;
          const plant = e.c.plant!;
          energy.value = Math.min(energy.max, energy.value + plant.growth);
          if (--plant.seedTimer > 0) continue;
          plant.seedTimer = p.seedInterval;
          if (count >= p.max || energy.value < energy.max * p.seedReadyFraction) continue;
          const angle = rng.range(0, Math.PI * 2);
          const r = rng.range(e.radius * 2, p.seedRange);
          const at = { x: e.pos.x + Math.cos(angle) * r, y: e.pos.y + Math.sin(angle) * r };
          if (world.near(at, p.seedRange, "plant").length >= p.crowding) continue;
          spawnPlant(world, at);
          count++;
        }
        let budget = p.spontaneousPerTick;
        while (count < p.max && budget > 0 && rng.next() < budget) {
          spawnPlant(world, { x: rng.range(0, world.config.width), y: rng.range(0, world.config.height) });
          count++;
          budget -= 1;
        }
      },
    },
  ],
  extendVisible(_world, _viewer, target, view) {
    if (target.kind === "plant") view.energy = target.c.energy!.value;
  },
  snapshot(e, out) {
    if (e.kind === "plant" && e.c.energy) out.energy = Math.round(e.c.energy.value);
  },
};
