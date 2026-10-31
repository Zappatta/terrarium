import { mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { createApp } from "./http.js";
import { createServices } from "./services.js";

const dbPath = resolve(process.env.TERRARIUM_DB ?? "data/terrarium.db");
mkdirSync(dirname(dbPath), { recursive: true });
const workers = Number(process.env.TERRARIUM_WORKERS ?? Math.max(1, availableParallelism() - 1));

const services = await createServices({ dbPath, workers, token: process.env.TERRARIUM_TOKEN || undefined });
const resumed = services.runs.resume();
const app = await createApp(services);
const port = Number(process.env.PORT ?? 7341);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`terrarium listening on http://${host}:${port} (db ${dbPath}, ${workers} workers, ${resumed} runs resumed)`);

if (process.env.TERRARIUM_DEMO) {
  // Two linked worlds stocked with the builtin species, so there is something to watch immediately.
  const builtins = services.db.listCreatures({ builtin: true });
  for (const name of ["Meadow", "Badlands"]) {
    const w = services.live.create({ name, tps: 20 });
    for (const c of builtins) services.live.addSpecies(w.id, c.codeHash, 12);
  }
  console.log(`demo worlds running: open http://${host}:${port}/view`);
}

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await services.close();
    process.exit(0);
  });
}
