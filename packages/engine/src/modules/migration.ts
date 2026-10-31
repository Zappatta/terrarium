import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";

export const MIGRATION = "migration";
export const migrationParams = moduleParams(MIGRATION, { edgeMargin: 5, energyCostFraction: 0.1 });

/**
 * Lets organisms leave through the world's edge to another world. Only for live worlds: the
 * destination is chosen by the host, so a world with this module is not reproducible on its own.
 */
export function migration(worldName: string): RuleModule {
  return {
    id: MIGRATION,
    requires: ["body"],
    actions: [
      {
        type: "migrate",
        handle(world, actor) {
          const p = migrationParams(world);
          const { x, y } = actor.pos;
          const { width, height } = world.config;
          const m = p.edgeMargin + actor.radius;
          if (x > m && y > m && x < width - m && y < height - m) return "must be at the world's edge";
          const energy = actor.c.energy!;
          energy.value -= energy.max * p.energyCostFraction;
          if (energy.value <= 0) return "too weak to migrate";
          world.emigrate(actor, worldName);
        },
      },
    ],
  };
}
