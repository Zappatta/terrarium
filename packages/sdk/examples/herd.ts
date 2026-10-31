import { defineSpecies, type Action, type EntityId, type Vec2 } from "@terrarium/sdk";

interface Shared {
  /** Plants claimed this tick, so herd members spread out instead of piling on one plant. */
  claims: Map<EntityId, EntityId>;
  danger: Vec2 | null;
  dangerTick: number;
}

/** Hive-mind herbivore: uses thinkAll to share threat sightings and divide food between members. */
export default defineSpecies<Shared>({
  name: "Herd",
  diet: "herbivore",
  traits: { size: 4, speed: 4, sight: 5, defense: 4 },
  setup(ctx) {
    ctx.shared.claims = new Map();
    ctx.shared.danger = null;
    ctx.shared.dangerTick = -1;
  },
  thinkAll(organisms, ctx) {
    const s = ctx.shared;
    s.claims.clear();
    for (const o of organisms) {
      const t = o.visible.find((v) => v.kind === "animal" && !v.kin && v.diet === "carnivore");
      if (t) {
        s.danger = t.pos;
        s.dangerTick = ctx.world.tick;
      }
    }
    if (ctx.world.tick - s.dangerTick > 40) s.danger = null;

    const out: Array<[EntityId, Action]> = [];
    for (const { self, visible } of organisms) {
      if (s.danger && Math.hypot(self.pos.x - s.danger.x, self.pos.y - s.danger.y) < 120) {
        const dx = self.pos.x - s.danger.x;
        const dy = self.pos.y - s.danger.y;
        const len = Math.hypot(dx, dy) || 1;
        out.push([self.id, { type: "move", to: { x: self.pos.x + (dx / len) * 80, y: self.pos.y + (dy / len) * 80 } }]);
        continue;
      }
      if (self.canReproduce) {
        out.push([self.id, { type: "reproduce" }]);
        continue;
      }
      const plant = visible.find((v) => v.kind === "plant" && (v.energy ?? 0) > 5 && !s.claims.has(v.id));
      if (plant) {
        s.claims.set(plant.id, self.id);
        const inReach = plant.distance <= self.radius + plant.radius + 2;
        out.push([self.id, inReach ? { type: "eat", target: plant.id } : { type: "move", to: plant.pos }]);
      } else if (!self.moving) {
        out.push([self.id, { type: "move", to: { x: ctx.random() * ctx.world.width, y: ctx.random() * ctx.world.height } }]);
      }
    }
    return out;
  },
});
