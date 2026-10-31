import type {
  Action,
  DecideInput,
  DecideOutput,
  Diet,
  EntityId,
  GameEvent,
  PlantAction,
  PlantSelfView,
  SelfView,
  SpeciesDescriptor,
  Traits,
  Vec2,
  VisibleEntity,
} from "@terrarium/sdk";
import type { World } from "./world.js";

/**
 * Component bag. Rule modules add their own components with declaration merging:
 *
 *   declare module "../types.js" { interface Components { energy: EnergyComponent } }
 *
 * Components must stay JSON-serialisable: hashing, snapshots and moving organisms between
 * worlds all rely on that.
 */
export interface Components {
  species: SpeciesComponent;
  energy: Pool;
  health: Pool;
}

export interface Pool {
  value: number;
  max: number;
}

export interface Entity {
  readonly id: EntityId;
  readonly kind: string;
  pos: Vec2;
  radius: number;
  alive: boolean;
  c: Partial<Components>;
}

export interface SpeciesComponent {
  speciesId: string;
  diet: Diet;
  traits: Traits;
  generation: number;
  parentId: EntityId | null;
}

export type Phase = "pre" | "physics" | "metabolism" | "environment" | "lifecycle" | "post";
export const PHASES: readonly Phase[] = ["pre", "physics", "metabolism", "environment", "lifecycle", "post"];

export interface System {
  phase: Phase;
  /** Lower runs first within a phase. Ties break by module order. */
  order?: number;
  run(world: World): void;
}

export interface TraitDef {
  name: string;
  /** Diets that may use this trait. Defaults to animals (herbivore, carnivore). */
  diets?: Diet[];
  min: number;
  max: number;
  default: number;
  /** Points per unit. Defaults to 1. */
  cost?: number;
  /** Energy per tick per unit to maintain. Defaults to the metabolism module's upkeepPerTraitPoint. */
  upkeep?: number;
}

export interface ActionHandler {
  type: string;
  /** Validate the untrusted action and apply it. Return a reason string on failure. */
  handle(world: World, actor: Entity, action: Action | PlantAction): string | void;
}

export type DeathCause = "starvation" | "killed" | "oldAge" | (string & {});

export interface SpawnOptions {
  parentId?: EntityId | null;
  generation?: number;
  /** Fraction of max energy to start with. */
  energyFraction?: number;
}

export interface RuleModule {
  id: string;
  requires?: string[];
  traits?: TraitDef[];
  actions?: ActionHandler[];
  systems?: System[];
  init?(world: World): void;
  /** Called for every new organism (animal or plant species member). Check e.kind. */
  onOrganismCreated?(world: World, e: Entity, opts: SpawnOptions): void;
  onDeath?(world: World, e: Entity, cause: DeathCause): void;
  /** Fill in the organism's self view. Plants receive a PlantSelfView; check e.kind. */
  extendSelf?(world: World, e: Entity, self: SelfView & PlantSelfView): void;
  /** Return false to hide target from viewer. All modules must agree for it to be visible. */
  canSee?(world: World, viewer: Entity, target: Entity, distance: number): boolean;
  extendVisible?(world: World, viewer: Entity, target: Entity, view: VisibleEntity): void;
  /** Extra per-entity fields for spectator snapshots. */
  snapshot?(e: Entity, out: Record<string, unknown>): void;
}

/** An organism in transit between worlds. Plain JSON. */
export interface Migrant {
  speciesId: string;
  radius: number;
  c: Partial<Components>;
  from: string;
}

export interface DecideResult {
  output?: DecideOutput;
  error?: string;
  /** The failure came from the host (e.g. wall clock), not the creature. The run is not reproducible. */
  hostFault?: boolean;
  fuelUsed?: number;
  logs?: string[];
}

/** A species brain. The engine never knows whether it is sandboxed user code or a native bot. */
export interface SpeciesController {
  readonly descriptor: SpeciesDescriptor;
  /** Called once when added to a world, with a seed for the species' deterministic randomness. */
  attach?(info: { speciesId: string; seed: string }): void;
  decide(input: DecideInput): DecideResult;
  dispose?(): void;
}

export interface SpeciesStats {
  speciesId: string;
  name: string;
  diet: Diet;
  population: number;
  peakPopulation: number;
  births: number;
  deaths: Record<string, number>;
  kills: number;
  /** Total energy held by living members right now. */
  biomass: number;
  /** Sum over ticks of biomass. */
  biomassIntegral: number;
  /** Deepest generation ever born (founders are generation 0). */
  maxGeneration: number;
  /** Ticks with at least one living member. */
  ticksAlive: number;
  extinctAt: number | null;
  emigrated: number;
  immigrated: number;
  faults: number;
  hostFaults: number;
  lastError: string | null;
  fuelUsed: number;
  logs: string[];
}

export type { GameEvent };
