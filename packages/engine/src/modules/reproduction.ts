import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";

export interface ReproductionComponent {
  gestationLeft: number;
  cooldown: number;
}

declare module "../types.js" {
  interface Components {
    reproduction: ReproductionComponent;
  }
}

export const REPRODUCTION = "reproduction";
export const reproductionParams = moduleParams(REPRODUCTION, {
  minEnergyFraction: 0.6,
  /** Fraction of the parent's max energy spent on the child. */
  costFraction: 0.45,
  childEnergyFraction: 0.35,
  gestation: 30,
  cooldown: 100,
});

export const reproduction: RuleModule = {
  id: REPRODUCTION,
  requires: ["body", "metabolism"],
  actions: [
    {
      type: "reproduce",
      handle(world, actor) {
        const p = reproductionParams(world);
        const r = actor.c.reproduction;
        if (!r) return "plants reproduce with the seed action";
        const energy = actor.c.energy!;
        const age = actor.c.age!;
        if (age.ticks < age.matureAt) return "not mature";
        if (r.gestationLeft > 0) return "already gestating";
        if (r.cooldown > 0) return "recovering from last birth";
        if (energy.value < energy.max * p.minEnergyFraction) return "not enough energy";
        const stats = world.getStats(actor.c.species!.speciesId);
        if (stats.population >= world.populationCap(actor.c.species!.speciesId)) return "population cap reached";
        energy.value -= energy.max * p.costFraction;
        r.gestationLeft = p.gestation;
      },
    },
  ],
  systems: [
    {
      phase: "lifecycle",
      run(world) {
        const p = reproductionParams(world);
        const rng = world.rng.fork(`births:${world.tick}`);
        for (const e of world.all("animal")) {
          const r = e.c.reproduction!;
          if (r.cooldown > 0) r.cooldown--;
          if (r.gestationLeft <= 0 || --r.gestationLeft > 0 || world.isDying(e)) continue;
          const angle = rng.range(0, Math.PI * 2);
          const offset = e.radius * 2.5;
          const sp = e.c.species!;
          const child = world.spawnOrganism(
            sp.speciesId,
            { x: e.pos.x + Math.cos(angle) * offset, y: e.pos.y + Math.sin(angle) * offset },
            { parentId: e.id, generation: sp.generation + 1, energyFraction: p.childEnergyFraction },
          );
          r.cooldown = p.cooldown;
          if (child) world.emit(e.id, { type: "gaveBirth", childId: child.id });
        }
      },
    },
  ],
  onOrganismCreated(_world, e) {
    if (e.kind !== "animal") return;
    e.c.reproduction = { gestationLeft: 0, cooldown: 0 };
  },
  extendSelf(world, e, self) {
    const p = reproductionParams(world);
    const r = e.c.reproduction;
    if (!r) return;
    const energy = e.c.energy!;
    self.gestating = r.gestationLeft > 0;
    self.canReproduce =
      self.mature && r.gestationLeft === 0 && r.cooldown === 0 && energy.value >= energy.max * p.minEnergyFraction;
  },
};
