import { definePlant, type EntityId, type PlantAction, type Vec2 } from "@terrarium/sdk";

interface Shared {
  /** Where members were grazed recently. Every member hears it: the species is one organism. */
  alarms: Array<{ at: Vec2; tick: number }>;
}

/** Toxic and cheap to grow. When any member is grazed, nearby members raise their defences. */
export default definePlant<Shared>({
  name: "Foxglove",
  diet: "plant",
  traits: { size: 2, growth: 5, seedRange: 6, toxin: 7 },
  setup(ctx) {
    ctx.shared.alarms = [];
  },
  thinkAll(plants, ctx) {
    const s = ctx.shared;
    const now = ctx.world.tick;
    for (const p of plants) if (p.events.some((e) => e.type === "grazed")) s.alarms.push({ at: p.self.pos, tick: now });
    s.alarms = s.alarms.filter((a) => now - a.tick < 60);

    const out: Array<[EntityId, PlantAction]> = [];
    for (const { self } of plants) {
      const alarmed = s.alarms.some((a) => Math.hypot(a.at.x - self.pos.x, a.at.y - self.pos.y) < 80);
      const level = alarmed ? 1 : 0;
      if (level !== self.defense) {
        out.push([self.id, { type: "defend", level }]);
        continue;
      }
      if (self.canSeed && self.light > 0.5) {
        const a = ctx.random() * Math.PI * 2;
        out.push([self.id, { type: "seed", to: { x: self.pos.x + Math.cos(a) * self.seedRange, y: self.pos.y + Math.sin(a) * self.seedRange } }]);
      }
    }
    return out;
  },
});
