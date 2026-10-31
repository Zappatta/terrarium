import type { DecideInput, DecideOutput, SpeciesDescriptor } from "@terrarium/sdk";
import { SPECIES_RUNTIME_SOURCE } from "@terrarium/sdk";
import { Rng, type DecideResult, type SpeciesController } from "@terrarium/engine";
import {
  newQuickJSWASMModule,
  RELEASE_SYNC,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import type { CompiledCreature } from "./compile.js";
import { BOOT_SOURCE, PRELUDE_SOURCE } from "./prelude.js";
import { encodeBinary, encodeWire } from "./wire.js";
import { createRequire } from "node:module";

/** Fuel counts depend on the exact QuickJS build, so match records carry this. */
export const QUICKJS_VERSION: string = createRequire(import.meta.url)("quickjs-emscripten/package.json").version;

/**
 * Fuel is counted in QuickJS interrupt-handler calls, which fire after a fixed amount of interpreter
 * work (roughly 5k simple loop iterations per unit). The count is identical on every run, unlike
 * wall-clock limits, so out-of-fuel outcomes replay exactly.
 */
export interface SandboxLimits {
  memoryBytes: number;
  stackBytes: number;
  loadFuel: number;
  fuelBase: number;
  fuelPerOrganism: number;
  fuelMax: number;
  /** Extra fuel on the first decide call, which also runs setup(). */
  setupFuel: number;
  maxOutputBytes: number;
  maxLogLinesPerTick: number;
  maxLogLineLength: number;
  /** Safety net only. Hitting it is a host fault and invalidates the match, as it is not reproducible. */
  wallClockMs: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  loadFuel: 200,
  fuelBase: 40,
  fuelPerOrganism: 4,
  fuelMax: 1000,
  setupFuel: 200,
  maxOutputBytes: 256 * 1024,
  maxLogLinesPerTick: 20,
  maxLogLineLength: 300,
  wallClockMs: 2000,
};

let sharedModule: Promise<QuickJSWASMModule> | undefined;

export interface SandboxOptions {
  limits?: Partial<SandboxLimits>;
  /**
   * "module": a separate WebAssembly instance per species, so a QuickJS escape still cannot reach
   * another species' memory. "runtime": share one instance (cheaper, for trusted batch testing).
   */
  isolation?: "module" | "runtime";
}

export class SandboxController implements SpeciesController {
  private fuel = 0;
  private fuelLimit = 0;
  private deadline = 0;
  private wallClockHit = false;
  private logs: string[] = [];
  private calls = 0;
  private disposed = false;

  private constructor(
    readonly descriptor: SpeciesDescriptor,
    readonly codeHash: string,
    private readonly limits: SandboxLimits,
    private readonly runtime: QuickJSRuntime,
    private readonly ctx: QuickJSContext,
    private readonly decideFn: QuickJSHandle,
    private readonly decideBinaryFn: QuickJSHandle,
  ) {}

  static async create(creature: CompiledCreature, options: SandboxOptions = {}): Promise<SandboxController> {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const module =
      options.isolation === "runtime"
        ? await (sharedModule ??= newQuickJSWASMModule(RELEASE_SYNC))
        : await newQuickJSWASMModule(RELEASE_SYNC);

    const runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const ctx = runtime.newContext();

    // The interrupt handler reads state from whichever controller is bound below.
    const state = { self: undefined as SandboxController | undefined, loadFuel: 0 };
    runtime.setInterruptHandler(() => {
      const c = state.self;
      if (!c) return ++state.loadFuel > limits.loadFuel;
      c.fuel++;
      if (Date.now() > c.deadline) {
        c.wallClockHit = true;
        return true;
      }
      return c.fuel > c.fuelLimit;
    });

    const logBuffer: string[] = [];
    const hostLog = ctx.newFunction("__hostLog", (msg) => {
      const target = state.self ? state.self.logs : logBuffer;
      if (target.length < limits.maxLogLinesPerTick) target.push(ctx.getString(msg).slice(0, limits.maxLogLineLength));
    });
    ctx.setProp(ctx.global, "__hostLog", hostLog);
    hostLog.dispose();

    const fail = (stage: string, err: QuickJSHandle): Error => {
      const dumped = ctx.dump(err);
      err.dispose();
      ctx.dispose();
      runtime.dispose();
      const msg = typeof dumped === "object" && dumped ? (dumped.message ?? JSON.stringify(dumped)) : String(dumped);
      return new Error(`Creature failed to load (${stage}): ${msg}`);
    };

    for (const [stage, src] of [
      ["prelude", PRELUDE_SOURCE],
      ["runtime", SPECIES_RUNTIME_SOURCE],
      ["creature", creature.code],
      ["boot", BOOT_SOURCE],
    ] as const) {
      const r = ctx.evalCode(src, `${stage}.js`);
      if (r.error) throw fail(stage, r.error);
      r.value.dispose();
    }

    const describe = ctx.evalCode("__describeJSON()");
    if (describe.error) throw fail("describe", describe.error);
    const descriptor = JSON.parse(ctx.getString(describe.value)) as SpeciesDescriptor;
    describe.value.dispose();

    const decideFn = ctx.getProp(ctx.global, "__decideJSON");
    const decideBinaryFn = ctx.getProp(ctx.global, "__decideBinary");
    const controller = new SandboxController(descriptor, creature.codeHash, limits, runtime, ctx, decideFn, decideBinaryFn);
    state.self = controller;
    controller.logs.push(...logBuffer);
    return controller;
  }

  attach(info: { speciesId: string; seed: string }): void {
    const args = Rng.brainWords(info.seed).join(",");
    this.withFuel(this.limits.setupFuel, () => {
      const r = this.ctx.evalCode(`__seedRandom(${args})`);
      if (r.error) r.error.dispose();
      else r.value.dispose();
    });
  }

  private withFuel<T>(limit: number, fn: () => T): T {
    this.fuel = 0;
    this.fuelLimit = limit;
    this.wallClockHit = false;
    this.deadline = Date.now() + this.limits.wallClockMs;
    return fn();
  }

  decide(input: DecideInput): DecideResult {
    if (this.disposed) return { error: "sandbox disposed" };
    const l = this.limits;
    const limit =
      Math.min(l.fuelMax, l.fuelBase + l.fuelPerOrganism * input.organisms.length) + (this.calls++ === 0 ? l.setupFuel : 0);

    return this.withFuel(limit, () => {
      const binary = encodeBinary(input);
      let r;
      if (binary) {
        const header = this.ctx.newString(binary.header);
        const buffer = this.ctx.newArrayBuffer(binary.buffer);
        r = this.ctx.callFunction(this.decideBinaryFn, this.ctx.undefined, header, buffer);
        header.dispose();
        buffer.dispose();
      } else {
        const arg = this.ctx.newString(JSON.stringify(encodeWire(input)));
        r = this.ctx.callFunction(this.decideFn, this.ctx.undefined, arg);
        arg.dispose();
      }
      const logs = this.logs.splice(0);
      const fuelUsed = this.fuel;

      if (r.error) {
        const err = this.ctx.dump(r.error);
        r.error.dispose();
        if (this.wallClockHit) return { error: "wall clock limit exceeded", hostFault: true, fuelUsed, logs };
        const message = typeof err === "object" && err ? String(err.message ?? JSON.stringify(err)) : String(err);
        return { error: message === "interrupted" ? `out of fuel (limit ${limit})` : message, fuelUsed, logs };
      }
      const json = this.ctx.typeof(r.value) === "string" ? this.ctx.getString(r.value) : "";
      r.value.dispose();
      if (json.length > l.maxOutputBytes) return { error: `output exceeds ${l.maxOutputBytes} bytes`, fuelUsed, logs };
      try {
        return { output: JSON.parse(json) as DecideOutput, fuelUsed, logs };
      } catch {
        return { error: "output was not valid JSON", fuelUsed, logs };
      }
    });
  }

  memoryUsage(): number {
    const h = this.runtime.computeMemoryUsage();
    const usage = this.ctx.dump(h) as { memory_used_size?: number };
    h.dispose();
    return usage.memory_used_size ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.decideFn.dispose();
    this.decideBinaryFn.dispose();
    this.ctx.dispose();
    this.runtime.dispose();
  }
}
