import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";

export interface AgeComponent {
  ticks: number;
  max: number;
  matureAt: number;
}

declare module "../types.js" {
  interface Components {
    age: AgeComponent;
  }
}

export const METABOLISM = "metabolism";
export const metabolismParams = moduleParams(METABOLISM, {
  upkeepBase: 0.05,
  upkeepPerSize: 0.03,
  /** Default per-point upkeep for traits other than size, unless the trait sets its own. */
  upkeepPerTraitPoint: 0.004,
  moveCost: 0.004,
  healEnergyThreshold: 0.5,
  healRate: 0.05,
  healCost: 2,
  maxAgeBase: 2500,
  maxAgePerSize: 200,
  matureAt: 150,
});

export const metabolism: RuleModule = {
  id: METABOLISM,
  requires: ["body", "movement"],
  systems: [
    {
      phase: "metabolism",
      run(world) {
        const p = metabolismParams(world);
        for (const e of world.all("animal")) {
          const energy = e.c.energy!;
          const t = e.c.species!.traits;
          const size = t.size!;
          let traitUpkeep = 0;
          for (const k in t) {
            if (k !== "size") traitUpkeep += t[k]! * (world.traitDef(k)?.upkeep ?? p.upkeepPerTraitPoint);
          }
          const moved = e.c.motion?.moved ?? 0;
          energy.value -= p.upkeepBase + p.upkeepPerSize * size + traitUpkeep;
          energy.value -= p.moveCost * size * moved * moved;

          const health = e.c.health!;
          if (health.value < health.max && energy.value > energy.max * p.healEnergyThreshold) {
            const healed = Math.min(p.healRate * size, health.max - health.value);
            health.value += healed;
            energy.value -= healed * p.healCost;
          }

          const age = e.c.age!;
          age.ticks++;
          if (energy.value <= 0) {
            energy.value = 0;
            world.kill(e, "starvation");
          } else if (age.ticks > age.max) {
            world.kill(e, "oldAge");
          }
        }
      },
    },
  ],
  onOrganismCreated(world, e) {
    if (e.kind !== "animal") return;
    const p = metabolismParams(world);
    const size = e.c.species!.traits.size!;
    e.c.age = { ticks: 0, max: p.maxAgeBase + p.maxAgePerSize * size, matureAt: p.matureAt };
  },
  extendSelf(_world, e, self) {
    const age = e.c.age;
    if (!age) return;
    self.age = age.ticks;
    self.maxAge = age.max;
    self.mature = age.ticks >= age.matureAt;
  },
};
