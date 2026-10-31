import { NativeController, World, standardModules } from "@terrarium/engine";
import grazer from "../packages/sdk/examples/grazer.js";
import hunter from "../packages/sdk/examples/hunter.js";
import herd from "../packages/sdk/examples/herd.js";
import bramble from "../packages/sdk/examples/bramble.js";
import foxglove from "../packages/sdk/examples/foxglove.js";

const seed = process.argv[2] ?? "balance-1";
const world = new World(standardModules(), { seed, maxTicks: Number(process.argv[3] ?? 4000) });
for (const [id, def] of Object.entries({ grazer, herd, hunter, bramble, foxglove })) {
  world.addSpecies(id, new NativeController(def as never));
}
const t0 = performance.now();
while (!world.finished) {
  world.step();
  if (world.tick % 500 === 0) {
    const wild = world.all("plant").filter((e) => !e.c.species).length;
    const pops = world.allStats().map((s) => `${s.name}=${s.population}`).join(" ");
    console.log(`t=${world.tick} wild=${wild} corpses=${world.count("corpse")} ${pops}`);
  }
}
const ms = performance.now() - t0;
for (const s of world.allStats()) {
  console.log(s.name.padEnd(9), JSON.stringify({ peak: s.peakPopulation, births: s.births, gen: s.maxGeneration, deaths: s.deaths, kills: s.kills, extinctAt: s.extinctAt, faults: s.faults, err: s.lastError }));
}
console.log(`ticks=${world.tick} ms=${ms.toFixed(0)} (${(ms / world.tick).toFixed(2)} ms/tick) hash=${world.hash()}`);
