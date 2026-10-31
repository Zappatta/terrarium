import { defineSpecies, type Perception, type Action } from "@terrarium/sdk";

interface Shared {
  /** Plant species that hurt us, learned from experience and shared by the whole species. */
  avoid: Record<string, number>;
}

/** Herbivore: eat the nearest plant it has not learned to avoid, flee carnivores, breed when possible. */
export default defineSpecies<Shared, { wander?: { x: number; y: number } }>({
  name: "Grazer",
  diet: "herbivore",
  traits: { size: 3, speed: 5, sight: 6, camouflage: 2, defense: 2 },
  setup(ctx) {
    ctx.shared.avoid = {};
  },
  think(me: Perception, ctx): Action | void {
    const { self, visible, events } = me;
    const avoid = ctx.shared.avoid;
    for (const e of events) {
      if (e.type !== "pricked" && e.type !== "poisoned") continue;
      const plant = visible.find((v) => v.id === e.target);
      if (plant?.speciesId) avoid[plant.speciesId] = (avoid[plant.speciesId] ?? 0) + 1;
    }
    const threat = visible.find((v) => v.kind === "animal" && !v.kin && v.diet === "carnivore");
    if (threat && threat.distance < self.sightRadius * 0.6) {
      const dx = self.pos.x - threat.pos.x;
      const dy = self.pos.y - threat.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      return { type: "move", to: { x: self.pos.x + (dx / len) * 60, y: self.pos.y + (dy / len) * 60 } };
    }
    if (self.canReproduce) return { type: "reproduce" };

    const hungry = self.energy < self.maxEnergy * 0.25;
    const plant = visible.find(
      (v) => v.kind === "plant" && (v.energy ?? 0) > 5 && (hungry || !v.speciesId || (avoid[v.speciesId] ?? 0) < 3),
    );
    if (plant) {
      if (plant.distance <= self.radius + plant.radius + 2) return { type: "eat", target: plant.id };
      return { type: "move", to: plant.pos };
    }
    const mem = ctx.memory(self.id);
    if (!self.moving || !mem.wander) {
      mem.wander = { x: ctx.random() * ctx.world.width, y: ctx.random() * ctx.world.height };
      return { type: "move", to: mem.wander, speed: self.maxSpeed * 0.6 };
    }
  },
});
