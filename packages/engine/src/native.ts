import { SPECIES_RUNTIME_SOURCE } from "@terrarium/sdk";
import type { DecideInput, DecideOutput, SpeciesDefinition, SpeciesDescriptor } from "@terrarium/sdk";
import { Rng } from "./rng.js";
import type { DecideResult, SpeciesController } from "./types.js";

interface SpeciesRuntime {
  describe(): SpeciesDescriptor;
  decide(input: DecideInput): DecideOutput;
}

type RuntimeFactory = (def: unknown, random: () => number, log: (...a: unknown[]) => void) => SpeciesRuntime;
const createRuntime = new Function(`${SPECIES_RUNTIME_SOURCE}; return __createSpeciesRuntime;`)() as RuntimeFactory;

/**
 * Runs a species definition directly in the host. Trusted code only (built-in bots, tests):
 * there is no sandbox and no fuel limit.
 */
export class NativeController implements SpeciesController {
  readonly descriptor: SpeciesDescriptor;
  private readonly runtime: SpeciesRuntime;
  private rng: Rng;
  private logs: string[] = [];

  constructor(def: SpeciesDefinition<any, any>, seed = "native") {
    this.rng = new Rng(seed);
    this.runtime = createRuntime(
      def,
      () => this.rng.next(),
      (...args) => this.logs.push(args.map(String).join(" ")),
    );
    this.descriptor = this.runtime.describe();
  }

  attach(info: { speciesId: string; seed: string }): void {
    this.rng = new Rng(info.seed, Rng.brainWords(info.seed));
  }

  decide(input: DecideInput): DecideResult {
    try {
      const output = this.runtime.decide(input);
      return { output, logs: this.logs.splice(0) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), logs: this.logs.splice(0) };
    }
  }
}
