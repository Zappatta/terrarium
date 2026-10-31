import type { Diet } from "@terrarium/sdk";
import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";
import { dist } from "../vec.js";
import { plantDefence } from "./flora.js";

export const FEEDING = "feeding";
export const feedingParams = moduleParams(FEEDING, {
  reach: 2,
  plantBiteBase: 3,
  plantBitePerSize: 1,
  meatBiteBase: 4,
  meatBitePerSize: 1.5,
  /** Fraction of eaten meat that becomes energy. Below 1 keeps predators rarer than prey. */
  meatEfficiency: 0.8,
});

const FOOD_BY_DIET: Record<Diet, string | undefined> = { herbivore: "plant", carnivore: "corpse", plant: undefined };

export const feeding: RuleModule = {
  id: FEEDING,
  requires: ["body", "plants", "corpses"],
  actions: [
    {
      type: "eat",
      handle(world, actor, action) {
        if (action.type !== "eat") return;
        const p = feedingParams(world);
        const sp = actor.c.species!;
        const food = FOOD_BY_DIET[sp.diet];
        if (!food) return "plants cannot eat";
        const target = typeof action.target === "number" ? world.get(action.target) : undefined;
        if (!target || world.isDying(target)) return "no such target";
        if (target.kind !== food) return `a ${sp.diet} cannot eat a ${target.kind}`;
        if (dist(actor.pos, target.pos) > actor.radius + target.radius + p.reach) return "out of reach";

        const energy = actor.c.energy!;
        const meal = target.c.energy!;
        const size = sp.traits.size!;
        const defence = target.kind === "plant" ? plantDefence(world, target) : undefined;
        let bite =
          sp.diet === "herbivore" ? p.plantBiteBase + p.plantBitePerSize * size : p.meatBiteBase + p.meatBitePerSize * size;
        if (defence) bite *= defence.biteFactor;
        const efficiency = sp.diet === "carnivore" ? p.meatEfficiency : 1;
        const amount = Math.min(bite, meal.value, (energy.max - energy.value) / efficiency);
        if (amount <= 0) return "full";
        meal.value -= amount;
        if (meal.value < 1) world.kill(target, "eaten");

        let gained = sp.diet === "carnivore" ? amount * p.meatEfficiency : amount;
        if (defence && defence.toxinFactor > 0) {
          gained = amount * (1 - defence.toxinFactor);
          if (gained < amount) world.emit(actor.id, { type: "poisoned", target: target.id, amount: amount - gained });
        }
        energy.value = Math.min(energy.max, energy.value + gained);
        world.emit(actor.id, { type: "ate", target: target.id, amount: gained });
        if (target.c.species) world.emit(target.id, { type: "grazed", by: actor.id, amount });

        if (defence && defence.thornDamage > 0) {
          const health = actor.c.health!;
          health.value -= defence.thornDamage;
          world.emit(actor.id, { type: "pricked", target: target.id, damage: defence.thornDamage });
          if (health.value <= 0) world.kill(actor, "thorns");
        }
        if (energy.value <= 0) {
          energy.value = 0;
          world.kill(actor, "poisoned");
        }
      },
    },
  ],
};
