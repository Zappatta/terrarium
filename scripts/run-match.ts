import { readFileSync } from "node:fs";
import { NativeController, World, standardModules, type SpeciesController } from "@terrarium/engine";
import { SandboxController, compileCreature } from "@terrarium/sandbox";

const EXAMPLES = ["grazer", "herd", "hunter", "bramble", "foxglove"];
const seed = process.argv[2] ?? "match-1";
const maxTicks = Number(process.argv[3] ?? 3000);

async function run(mode: "sandbox" | "native") {
  const world = new World(standardModules(), { seed, maxTicks });
  for (const name of EXAMPLES) {
    const path = new URL(`../packages/sdk/examples/${name}.ts`, import.meta.url);
    let controller: SpeciesController;
    if (mode === "sandbox") {
      controller = await SandboxController.create(await compileCreature(readFileSync(path, "utf8"), `${name}.ts`));
    } else {
      controller = new NativeController((await import(path.href)).default);
    }
    world.addSpecies(name, controller);
  }
  const t0 = performance.now();
  world.run();
  const ms = performance.now() - t0;
  console.log(`\n[${mode}] ticks=${world.tick} ${ms.toFixed(0)}ms (${(ms / world.tick).toFixed(2)} ms/tick) hash=${world.hash()} valid=${world.valid}`);
  for (const s of world.allStats()) {
    console.log(
      `  ${s.name.padEnd(8)} pop=${String(s.population).padStart(3)} peak=${String(s.peakPopulation).padStart(3)} births=${String(s.births).padStart(4)} kills=${String(s.kills).padStart(4)} biomass=${Math.round(s.biomassIntegral)} extinctAt=${s.extinctAt} faults=${s.faults} fuel=${s.fuelUsed}${s.lastError ? ` err=${s.lastError}` : ""}`,
    );
  }
  world.dispose();
  return world.hash();
}

const a = await run("sandbox");
const b = await run("sandbox");
const c = await run("native");
console.log(`\nsandbox reproducible: ${a === b}; sandbox == native: ${a === c}`);
