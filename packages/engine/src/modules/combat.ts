import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";
import { dist } from "../vec.js";

export const COMBAT = "combat";
export const combatParams = moduleParams(COMBAT, {
  reach: 2,
  damageBase: 2,
  damagePerAttack: 1.2,
  sizeFactorBase: 0.6,
  sizeFactorPerSize: 0.08,
  defenseFactor: 0.15,
  energyCost: 0.3,
});

export const combat: RuleModule = {
  id: COMBAT,
  requires: ["body"],
  traits: [
    { name: "attack", min: 0, max: 10, default: 0, upkeep: 0.015 },
    { name: "defense", min: 0, max: 10, default: 0 },
  ],
  actions: [
    {
      type: "attack",
      handle(world, actor, action) {
        if (action.type !== "attack") return;
        const p = combatParams(world);
        if (actor.kind !== "animal") return "plants cannot attack";
        const target = typeof action.target === "number" ? world.get(action.target) : undefined;
        if (!target || target.kind !== "animal" || world.isDying(target)) return "no such target";
        if (target === actor) return "cannot attack self";
        if (dist(actor.pos, target.pos) > actor.radius + target.radius + p.reach) return "out of reach";

        const at = actor.c.species!.traits;
        const dt = target.c.species!.traits;
        const damage =
          ((p.damageBase + p.damagePerAttack * at.attack!) * (p.sizeFactorBase + p.sizeFactorPerSize * at.size!)) /
          (1 + p.defenseFactor * dt.defense!);
        actor.c.energy!.value -= p.energyCost;
        const health = target.c.health!;
        health.value -= damage;
        world.emit(actor.id, { type: "hit", target: target.id, damage });
        world.emit(target.id, { type: "attacked", by: actor.id, damage });
        if (health.value <= 0) {
          world.kill(target, "killed");
          world.getStats(actor.c.species!.speciesId).kills++;
          world.emit(actor.id, { type: "killed", target: target.id });
        }
      },
    },
  ],
};
