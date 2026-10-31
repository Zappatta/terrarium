import type { Entity, RuleModule } from "../types.js";
import type { World } from "../world.js";
import { moduleParams } from "../params.js";
import { dist, isFiniteVec } from "../vec.js";

export interface FloraComponent {
  /** Sustained defence level 0-1 chosen by the species. */
  defense: number;
  /** Fraction of full sunlight received last tick. */
  light: number;
  seedCooldown: number;
}

declare module "../types.js" {
  interface Components {
    flora: FloraComponent;
  }
}

export const FLORA = "flora";
export const floraParams = moduleParams(FLORA, {
  radiusBase: 2,
  radiusPerSize: 0.8,
  energyBase: 20,
  energyPerSize: 25,
  growthBase: 0.04,
  growthPerPoint: 0.032,
  upkeepBase: 0.01,
  upkeepPerSize: 0.012,
  /** Upkeep per point of thorns, toxin or toughness: defences are never free. */
  upkeepPerDefencePoint: 0.004,
  /** Extra cost per tick per defence point at defend level 1. */
  activeDefenceCost: 0.01,
  /** Neighbouring plants within this many of their own radii cast shade. */
  shadeReach: 6,
  shadePerNeighbour: 0.4,
  matureAt: 100,
  maxAgeBase: 1200,
  maxAgePerSize: 100,
  seedRangeBase: 15,
  seedRangePerPoint: 9,
  seedCostFraction: 0.45,
  seedChildEnergyFraction: 0.3,
  seedCooldown: 60,
  minSeedEnergyFraction: 0.5,
  senseRadius: 45,
  thornDamagePerPoint: 0.6,
  /** Each toxin point removes this fraction of what the eater gains (can go negative). */
  toxinPerPoint: 0.12,
  /** Each toughness point shrinks bites by this factor. */
  toughnessPerPoint: 0.12,
});

const PLANT = ["plant"] as const;

/** How a plant's defences affect one bite. Wild plants have none. */
export function plantDefence(world: World, plant: Entity) {
  const sp = plant.c.species;
  if (!sp || !plant.c.flora) return undefined;
  const p = floraParams(world);
  const boost = 1 + plant.c.flora.defense;
  const t = sp.traits;
  return {
    biteFactor: 1 / (1 + p.toughnessPerPoint * (t.toughness ?? 0) * boost),
    toxinFactor: p.toxinPerPoint * (t.toxin ?? 0) * boost,
    thornDamage: p.thornDamagePerPoint * (t.thorns ?? 0) * boost,
  };
}

function seedRange(world: World, e: Entity): number {
  const p = floraParams(world);
  return p.seedRangeBase + p.seedRangePerPoint * (e.c.species!.traits.seedRange ?? 0);
}

function canSeed(world: World, e: Entity): boolean {
  const p = floraParams(world);
  const energy = e.c.energy!;
  return e.c.age!.ticks >= e.c.age!.matureAt && e.c.flora!.seedCooldown === 0 && energy.value >= energy.max * p.minSeedEnergyFraction;
}

/**
 * Programmable plants: species with diet "plant". They photosynthesise (less in the shade of
 * neighbours), throw seeds, and trade energy for thorns, toxins and toughness.
 */
export const flora: RuleModule = {
  id: FLORA,
  requires: ["body", "plants"],
  traits: [
    { name: "growth", min: 0, max: 10, default: 3, diets: [...PLANT] },
    { name: "seedRange", min: 0, max: 10, default: 3, diets: [...PLANT] },
    { name: "thorns", min: 0, max: 10, default: 0, diets: [...PLANT] },
    { name: "toxin", min: 0, max: 10, default: 0, diets: [...PLANT] },
    { name: "toughness", min: 0, max: 10, default: 0, diets: [...PLANT] },
  ],
  actions: [
    {
      type: "seed",
      handle(world, actor, action) {
        if (action.type !== "seed") return;
        if (actor.kind !== "plant" || !actor.c.flora) return "only plants seed";
        const to: unknown = action.to;
        if (!isFiniteVec(to)) return "invalid target";
        if (!canSeed(world, actor)) return "not ready to seed";
        const p = floraParams(world);
        const sp = actor.c.species!;
        if (world.getStats(sp.speciesId).population >= world.populationCap(sp.speciesId)) return "population cap reached";
        const d = dist(actor.pos, to);
        const range = seedRange(world, actor);
        const minD = actor.radius * 1.5;
        const k = d < 1e-9 ? 0 : Math.min(Math.max(d, minD), range) / d;
        const at = d < 1e-9 ? { x: actor.pos.x + minD, y: actor.pos.y } : { x: actor.pos.x + (to.x - actor.pos.x) * k, y: actor.pos.y + (to.y - actor.pos.y) * k };
        const energy = actor.c.energy!;
        energy.value -= energy.max * p.seedCostFraction;
        actor.c.flora.seedCooldown = p.seedCooldown;
        const child = world.spawnOrganism(sp.speciesId, at, {
          parentId: actor.id,
          generation: sp.generation + 1,
          energyFraction: p.seedChildEnergyFraction,
        });
        if (child) world.emit(actor.id, { type: "seeded", childId: child.id });
      },
    },
    {
      type: "defend",
      handle(_world, actor, action) {
        if (action.type !== "defend") return;
        if (actor.kind !== "plant" || !actor.c.flora) return "only plants defend";
        const level = Number(action.level);
        if (!Number.isFinite(level)) return "invalid level";
        actor.c.flora.defense = Math.min(1, Math.max(0, level));
      },
    },
  ],
  systems: [
    {
      phase: "environment",
      order: 10,
      run(world) {
        const p = floraParams(world);
        for (const e of world.all("plant")) {
          const f = e.c.flora;
          if (!f) continue;
          const t = e.c.species!.traits;
          let shade = 0;
          for (const n of world.near(e.pos, e.radius * p.shadeReach, "plant")) {
            if (n !== e && n.radius >= e.radius * 0.8) shade += p.shadePerNeighbour * Math.min(2, n.radius / e.radius);
          }
          f.light = 1 / (1 + shade);
          const defencePoints = (t.thorns ?? 0) + (t.toxin ?? 0) + (t.toughness ?? 0);
          const energy = e.c.energy!;
          energy.value +=
            (p.growthBase + p.growthPerPoint * (t.growth ?? 0)) * f.light -
            (p.upkeepBase + p.upkeepPerSize * t.size! + p.upkeepPerDefencePoint * defencePoints) -
            p.activeDefenceCost * defencePoints * f.defense;
          energy.value = Math.min(energy.value, energy.max);
          if (f.seedCooldown > 0) f.seedCooldown--;
          const age = e.c.age!;
          age.ticks++;
          if (energy.value <= 0) {
            energy.value = 0;
            world.kill(e, "starvation");
          } else if (age.ticks > age.max) {
            world.kill(e, "oldAge");
          }
        }
      },
    },
  ],
  onOrganismCreated(world, e, opts) {
    if (e.kind !== "plant") return;
    const p = floraParams(world);
    const size = e.c.species!.traits.size!;
    e.radius = p.radiusBase + p.radiusPerSize * size;
    const max = p.energyBase + p.energyPerSize * size;
    e.c.energy = { value: max * (opts.energyFraction ?? 0.5), max };
    e.c.age = { ticks: 0, max: p.maxAgeBase + p.maxAgePerSize * size, matureAt: p.matureAt };
    e.c.senses = { sightRadius: p.senseRadius, camouflage: 0 };
    e.c.flora = { defense: 0, light: 1, seedCooldown: 0 };
  },
  extendSelf(world, e, self) {
    if (e.kind !== "plant" || !e.c.flora) return;
    self.energy = e.c.energy!.value;
    self.maxEnergy = e.c.energy!.max;
    self.sightRadius = e.c.senses!.sightRadius;
    self.canSeed = canSeed(world, e);
    self.seedRange = seedRange(world, e);
    self.defense = e.c.flora.defense;
    self.light = e.c.flora.light;
  },
  extendVisible(_world, viewer, target, view) {
    const sp = target.c.species;
    if (target.kind !== "plant" || !sp) return;
    view.speciesId = sp.speciesId;
    view.kin = sp.speciesId === viewer.c.species?.speciesId;
    view.thorns = sp.traits.thorns ?? 0;
  },
};
