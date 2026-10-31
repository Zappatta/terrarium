import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";

export const BODY = "body";
export const bodyParams = moduleParams(BODY, {
  radiusBase: 3,
  radiusPerSize: 1,
  energyBase: 40,
  energyPerSize: 60,
  healthBase: 20,
  healthPerSize: 15,
});

export const body: RuleModule = {
  id: BODY,
  traits: [{ name: "size", min: 1, max: 10, default: 2, diets: ["herbivore", "carnivore", "plant"] }],
  onOrganismCreated(world, e, opts) {
    if (e.kind !== "animal") return;
    const p = bodyParams(world);
    const size = e.c.species!.traits.size!;
    e.radius = p.radiusBase + p.radiusPerSize * size;
    const maxEnergy = p.energyBase + p.energyPerSize * size;
    const maxHealth = p.healthBase + p.healthPerSize * size;
    e.c.energy = { value: maxEnergy * (opts.energyFraction ?? 0.5), max: maxEnergy };
    e.c.health = { value: maxHealth, max: maxHealth };
  },
  extendSelf(_world, e, self) {
    if (e.kind !== "animal") return;
    self.energy = e.c.energy?.value ?? 0;
    self.maxEnergy = e.c.energy?.max ?? 0;
    self.health = e.c.health?.value ?? 0;
    self.maxHealth = e.c.health?.max ?? 0;
  },
  extendVisible(_world, viewer, target, view) {
    const sp = target.c.species;
    if (!sp || target.kind !== "animal") return;
    view.speciesId = sp.speciesId;
    view.kin = sp.speciesId === viewer.c.species?.speciesId;
    view.diet = sp.diet as "herbivore" | "carnivore";
    if (target.c.health) view.healthFraction = target.c.health.value / target.c.health.max;
  },
  snapshot(e, out) {
    if (e.c.energy) out.energy = Math.round(e.c.energy.value);
  },
};
