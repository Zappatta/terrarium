import { definePlant, type PlantAction } from "@terrarium/sdk";

/** Thorny and tough. Seeds into the brightest gap it can sense, away from grazers. */
export default definePlant({
  name: "Bramble",
  diet: "plant",
  traits: { size: 3, growth: 4, seedRange: 4, thorns: 6, toughness: 3 },
  think(me, ctx): PlantAction | void {
    const { self, visible, events } = me;
    const grazed = events.some((e) => e.type === "grazed");
    const grazersNear = visible.some((v) => v.kind === "animal" && v.diet === "herbivore" && v.distance < 30);
    const wanted = grazed ? 1 : grazersNear ? 0.5 : 0;
    if (Math.abs(wanted - self.defense) > 0.1) return { type: "defend", level: wanted };

    if (self.canSeed) {
      // Try a few directions and throw the seed where the fewest plants and grazers are.
      let best = { x: self.pos.x, y: self.pos.y };
      let bestCrowd = Infinity;
      for (let i = 0; i < 6; i++) {
        const a = ctx.random() * Math.PI * 2;
        const to = { x: self.pos.x + Math.cos(a) * self.seedRange, y: self.pos.y + Math.sin(a) * self.seedRange };
        if (to.x < 0 || to.y < 0 || to.x > ctx.world.width || to.y > ctx.world.height) continue;
        let crowd = 0;
        for (const v of visible) {
          const d = Math.hypot(v.pos.x - to.x, v.pos.y - to.y);
          if (v.kind === "plant" && d < 15) crowd += 1;
          if (v.kind === "animal" && d < 30) crowd += 3;
        }
        if (crowd < bestCrowd) {
          bestCrowd = crowd;
          best = to;
        }
      }
      return { type: "seed", to: best };
    }
  },
});
