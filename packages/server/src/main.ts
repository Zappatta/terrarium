import { mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { createApp } from "./http.js";
import { createServices } from "./services.js";

const dbPath = resolve(process.env.TERRARIUM_DB ?? "data/terrarium.db");
mkdirSync(dirname(dbPath), { recursive: true });
const workers = Number(process.env.TERRARIUM_WORKERS ?? Math.max(1, availableParallelism() - 1));

const host = process.env.HOST ?? "127.0.0.1";
const devLogin = process.env.TERRARIUM_DEV_LOGIN === "1";
if (devLogin && host !== "127.0.0.1" && host !== "localhost") {
  throw new Error("TERRARIUM_DEV_LOGIN lets anyone sign in as anyone; it only runs on 127.0.0.1");
}
const services = await createServices({
  dbPath,
  workers,
  googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
  admins: (process.env.TERRARIUM_ADMINS ?? "").split(","),
  devLogin,
  secureCookies: process.env.TERRARIUM_SECURE_COOKIES === "1",
});
const resumed = services.runs.resume();
const app = await createApp(services);
const port = Number(process.env.PORT ?? 7341);
await app.listen({ port, host });
console.log(`terrarium listening on http://${host}:${port} (db ${dbPath}, ${workers} workers, ${resumed} runs resumed)`);

const restored = services.live.restoreAll();
if (restored) console.log(`${restored} saved live world(s) restored`);
if (process.env.TERRARIUM_DEMO && services.live.savedCount() === 0) {
  // First run: two linked worlds stocked with the builtin species, so there is something to watch.
  const species = services.db.listCreatures({ builtin: true }).map((c) => ({ creature: c.codeHash, population: 12 }));
  for (const name of ["Meadow", "Badlands"]) services.live.create({ name, tps: 20, species });
  console.log(`demo worlds created: open http://${host}:${port}/view`);
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
