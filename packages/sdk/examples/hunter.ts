import { defineSpecies, type Action, type Perception } from "@terrarium/sdk";

/** Carnivore: eat corpses, otherwise chase and kill the weakest visible non-kin animal. */
export default defineSpecies<{}, { prey?: number; wander?: { x: number; y: number } }>({
  name: "Hunter",
  diet: "carnivore",
  traits: { size: 4, speed: 6, sight: 6, attack: 6, defense: 1 },
  think(me: Perception, ctx): Action | void {
    const { self, visible } = me;
    const mem = ctx.memory(self.id);
    const reach = (r: number) => self.radius + r + 2;

    const corpse = visible.find((v) => v.kind === "corpse");
    if (corpse && self.energy < self.maxEnergy * 0.95) {
      if (corpse.distance <= reach(corpse.radius)) return { type: "eat", target: corpse.id };
      return { type: "move", to: corpse.pos };
    }
    if (self.canReproduce) return { type: "reproduce" };

    const prey = visible
      .filter((v) => v.kind === "animal" && !v.kin)
      .sort((a, b) => (a.healthFraction ?? 1) - (b.healthFraction ?? 1) || a.distance - b.distance)[0];
    // Hunt only when hungry: killing on a full stomach wastes prey and starves us later.
    if (prey && self.energy > self.maxEnergy * 0.15 && self.energy < self.maxEnergy * 0.7) {
      mem.prey = prey.id;
      if (prey.distance <= reach(prey.radius)) return { type: "attack", target: prey.id };
      return { type: "move", to: prey.pos };
    }
    if (!self.moving) {
      mem.wander = { x: ctx.random() * ctx.world.width, y: ctx.random() * ctx.world.height };
      return { type: "move", to: mem.wander, speed: self.maxSpeed * 0.5 };
    }
  },
});
