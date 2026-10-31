import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";

export const CORPSES = "corpses";
export const corpseParams = moduleParams(CORPSES, { energyPerSize: 25, decay: 0.15 });

export const corpses: RuleModule = {
  id: CORPSES,
  requires: ["body"],
  onDeath(world, e) {
    if (e.kind !== "animal") return;
    const size = e.c.species!.traits.size!;
    const value = corpseParams(world).energyPerSize * size + Math.max(0, e.c.energy?.value ?? 0);
    world.spawn("corpse", e.pos, e.radius, { energy: { value, max: value } });
  },
  systems: [
    {
      phase: "environment",
      run(world) {
        const decay = corpseParams(world).decay;
        for (const e of world.all("corpse")) {
          const energy = e.c.energy!;
          energy.value -= decay;
          if (energy.value < 1) world.kill(e, "decayed");
        }
      },
    },
  ],
  extendVisible(_world, _viewer, target, view) {
    if (target.kind === "corpse") view.energy = target.c.energy!.value;
  },
};
