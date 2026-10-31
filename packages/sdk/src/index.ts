export type EntityId = number;
export type AnimalDiet = "herbivore" | "carnivore";
export type Diet = AnimalDiet | "plant";

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Trait points a species spends at design time. The ruleset decides which traits exist,
 * their bounds and the total point budget; unknown traits are rejected at load time.
 */
export type Traits = Record<string, number>;

export interface SpeciesDescriptor {
  name: string;
  diet: Diet;
  traits: Traits;
}

/** What an animal knows about itself. */
export interface SelfView {
  id: EntityId;
  pos: Vec2;
  radius: number;
  energy: number;
  maxEnergy: number;
  health: number;
  maxHealth: number;
  age: number;
  maxAge: number;
  mature: boolean;
  canReproduce: boolean;
  gestating: boolean;
  moving: boolean;
  target: Vec2 | null;
  maxSpeed: number;
  sightRadius: number;
  generation: number;
  parentId: EntityId | null;
}

/** What a plant knows about itself. Plants cannot move; they grow, seed and defend. */
export interface PlantSelfView {
  id: EntityId;
  pos: Vec2;
  radius: number;
  energy: number;
  maxEnergy: number;
  age: number;
  maxAge: number;
  mature: boolean;
  canSeed: boolean;
  /** How far seeds can be thrown. */
  seedRange: number;
  /** Current defence level (0-1) set with the "defend" action. */
  defense: number;
  /** Fraction of full sunlight reaching this plant last tick (bigger neighbours shade it). */
  light: number;
  /** How far the plant can sense its surroundings. */
  sightRadius: number;
  generation: number;
  parentId: EntityId | null;
}

export type VisibleKind = "plant" | "animal" | "corpse";

export interface VisibleEntity {
  id: EntityId;
  kind: VisibleKind;
  pos: Vec2;
  radius: number;
  distance: number;
  /** Present for plants and corpses. */
  energy?: number;
  /** Present for animals and for plants that belong to a species (wild plants have none). */
  speciesId?: string;
  kin?: boolean;
  /** Present for animals. */
  diet?: AnimalDiet;
  healthFraction?: number;
  /** Present for plant species: thorns are visible. Toxins and toughness are not; learn them by eating. */
  thorns?: number;
}

export type GameEvent =
  | { type: "born"; parentId: EntityId | null }
  | { type: "attacked"; by: EntityId; damage: number }
  | { type: "ate"; target: EntityId; amount: number }
  | { type: "hit"; target: EntityId; damage: number }
  | { type: "killed"; target: EntityId }
  | { type: "gaveBirth"; childId: EntityId }
  | { type: "arrived" }
  /** This organism just arrived from another world. Its old memory stayed behind. */
  | { type: "immigrated"; from: string }
  | { type: "actionFailed"; action: string; reason: string }
  /** Animal: the plant you ate had thorns. */
  | { type: "pricked"; target: EntityId; damage: number }
  /** Animal: the plant you ate was toxic; you lost this much energy. */
  | { type: "poisoned"; target: EntityId; amount: number }
  /** Plant: something ate part of you. */
  | { type: "grazed"; by: EntityId; amount: number }
  /** Plant: a seedling sprouted. */
  | { type: "seeded"; childId: EntityId };

export interface Perception {
  self: SelfView;
  visible: VisibleEntity[];
  events: GameEvent[];
}

export interface PlantPerception {
  self: PlantSelfView;
  visible: VisibleEntity[];
  events: GameEvent[];
}

export type Action =
  | { type: "move"; to: Vec2; speed?: number }
  | { type: "stop" }
  | { type: "eat"; target: EntityId }
  | { type: "attack"; target: EntityId }
  | { type: "reproduce" }
  /** Leave this world through its edge. Only in worlds with the migration rule (never ranked matches). */
  | { type: "migrate" }
  | { type: "idle" };

export type PlantAction =
  /** Throw a seed toward a point. It lands at most seedRange away. Costs energy; needs maturity. */
  | { type: "seed"; to: Vec2 }
  /** Hold defences at a level from 0 to 1. Multiplies thorns, toxin and toughness, but costs energy every tick. */
  | { type: "defend"; level: number }
  | { type: "idle" };

export interface WorldInfo {
  tick: number;
  width: number;
  height: number;
  speciesId: string;
  /** Rule modules active in this world, e.g. to check for "migration". */
  rules: string[];
  /** Plant species are asked to decide only every this many ticks. */
  plantThinkInterval: number;
}

/** Host -> species, once per tick. */
export interface DecideInput {
  world: WorldInfo;
  /** Animals get Perception; plant species get PlantPerception. */
  organisms: Array<Perception | PlantPerception>;
  died: EntityId[];
}

/** Species -> host. A missing entry means "keep doing what you were doing". */
export interface DecideOutput {
  actions: Array<[EntityId, Action | PlantAction]>;
}

export interface SpeciesContext<Shared = Record<string, unknown>, Memory = Record<string, unknown>> {
  world: WorldInfo;
  /** Species-wide state. Every organism of the species shares it (hive mind is allowed). */
  shared: Shared;
  /** Per-organism scratch state, discarded on death. */
  memory(id: EntityId): Memory;
  /** Deterministic, seeded per species per world. Math.random is the same generator. */
  random(): number;
  log(...args: unknown[]): void;
}

export interface SpeciesDefinition<Shared = Record<string, unknown>, Memory = Record<string, unknown>>
  extends SpeciesDescriptor {
  diet: AnimalDiet;
  setup?(ctx: SpeciesContext<Shared, Memory>): void;
  /** Per-organism brain. Ignored when thinkAll is defined. */
  think?(me: Perception, ctx: SpeciesContext<Shared, Memory>): Action | void;
  /** Whole-species brain, for coordinated strategies. */
  thinkAll?(organisms: Perception[], ctx: SpeciesContext<Shared, Memory>): Array<[EntityId, Action]>;
  onDeath?(id: EntityId, ctx: SpeciesContext<Shared, Memory>): void;
}

/**
 * A plant species. Plants are called less often than animals (every few ticks, see WorldInfo) and
 * cannot move; their choices are where to seed and how hard to defend.
 */
export interface PlantDefinition<Shared = Record<string, unknown>, Memory = Record<string, unknown>> {
  name: string;
  diet: "plant";
  traits: Traits;
  setup?(ctx: SpeciesContext<Shared, Memory>): void;
  think?(me: PlantPerception, ctx: SpeciesContext<Shared, Memory>): PlantAction | void;
  thinkAll?(organisms: PlantPerception[], ctx: SpeciesContext<Shared, Memory>): Array<[EntityId, PlantAction]>;
  onDeath?(id: EntityId, ctx: SpeciesContext<Shared, Memory>): void;
}

export function definePlant<Shared = Record<string, unknown>, Memory = Record<string, unknown>>(
  def: PlantDefinition<Shared, Memory>,
): PlantDefinition<Shared, Memory> {
  return def;
}

export function defineSpecies<Shared = Record<string, unknown>, Memory = Record<string, unknown>>(
  def: SpeciesDefinition<Shared, Memory>,
): SpeciesDefinition<Shared, Memory> {
  return def;
}
export * from "./runtime.js";
