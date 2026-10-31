import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";

export interface SensesComponent {
  sightRadius: number;
  camouflage: number;
}

declare module "../types.js" {
  interface Components {
    senses: SensesComponent;
  }
}

export const SENSES = "senses";
export const sensesParams = moduleParams(SENSES, {
  sightBase: 30,
  sightPerPoint: 10,
  /** Each camouflage point shrinks the distance at which non-kin can spot you by this fraction. */
  camouflagePerPoint: 0.07,
});

export const senses: RuleModule = {
  id: SENSES,
  traits: [
    { name: "sight", min: 0, max: 10, default: 3 },
    { name: "camouflage", min: 0, max: 10, default: 0 },
  ],
  onOrganismCreated(world, e) {
    if (e.kind !== "animal") return;
    const p = sensesParams(world);
    const t = e.c.species!.traits;
    e.c.senses = { sightRadius: p.sightBase + p.sightPerPoint * t.sight!, camouflage: t.camouflage! };
  },
  extendSelf(_world, e, self) {
    if (e.kind !== "animal") return;
    self.sightRadius = e.c.senses?.sightRadius ?? 0;
  },
  canSee(world, viewer, target, distance) {
    const camo = target.c.senses?.camouflage ?? 0;
    if (camo === 0 || target.c.species?.speciesId === viewer.c.species?.speciesId) return true;
    const sight = viewer.c.senses?.sightRadius ?? 0;
    return distance <= sight * Math.max(0.15, 1 - sensesParams(world).camouflagePerPoint * camo);
  },
};
