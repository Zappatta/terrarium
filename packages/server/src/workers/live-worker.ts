import { parentPort, workerData } from "node:worker_threads";
import { World, migration } from "@terrarium/engine";
import { SandboxController } from "@terrarium/sandbox";
import { encodeFrame } from "../frames.js";
import { rulesetModules, type EntrantSpec } from "../match.js";
import type { LiveCommand, LiveEvent, LiveSpeciesInfo, LiveWorkerData } from "./protocol.js";

const port = parentPort!;
const data = workerData as LiveWorkerData;
const send = (m: LiveEvent) => port.postMessage(m);

const modules = rulesetModules(data.ruleset);
if (data.migration) modules.push(migration(data.worldId));
const world = new World(modules, { ...data.config, seed: data.config.seed ?? data.worldId, maxTicks: Number.MAX_SAFE_INTEGER });

let tps = data.tps;
let paused = false;
let stopped = false;
let timer: NodeJS.Timeout | undefined;
const species: LiveSpeciesInfo[] = [];
const loading = new Map<string, Promise<void>>();

async function ensureSpecies(entrant: EntrantSpec, population: number): Promise<void> {
  if (world.hasSpecies(entrant.slot)) return;
  let pending = loading.get(entrant.slot);
  if (!pending) {
    pending = (async () => {
      const controller = await SandboxController.create({ code: entrant.code, codeHash: entrant.codeHash });
      if (stopped || world.hasSpecies(entrant.slot)) return controller.dispose();
      world.addSpecies(entrant.slot, controller, population);
      species.push({ slot: entrant.slot, codeHash: entrant.codeHash, name: controller.descriptor.name, diet: controller.descriptor.diet });
      send({ type: "species", species });
    })().finally(() => loading.delete(entrant.slot));
    loading.set(entrant.slot, pending);
  }
  return pending;
}

function edgePoint() {
  const { width, height } = world.config;
  const t = Math.random();
  switch (Math.floor(Math.random() * 4)) {
    case 0: return { x: t * width, y: 2 };
    case 1: return { x: t * width, y: height - 2 };
    case 2: return { x: 2, y: t * height };
    default: return { x: width - 2, y: t * height };
  }
}

// Live worlds run forever, so any population eventually hits zero by chance. Recolonising (as if
// from outside the tank) keeps them watchable. Never used in matches, which stay closed systems.
const extinctSince = new Map<string, number>();
function recolonize(): void {
  if (!data.recolonizeAfter) return;
  for (const s of world.allStats()) {
    if (s.population > 0) {
      extinctSince.delete(s.speciesId);
      continue;
    }
    const since = extinctSince.get(s.speciesId);
    if (since === undefined) {
      extinctSince.set(s.speciesId, world.tick);
      send({ type: "notice", tick: world.tick, message: `${s.name} died out here. Founders will arrive in ${data.recolonizeAfter} ticks.` });
    } else if (world.tick - since >= data.recolonizeAfter) {
      const founders = s.diet === "plant" ? 8 : 4;
      for (let i = 0; i < founders; i++) {
        world.spawnOrganism(s.speciesId, { x: Math.random() * world.config.width, y: Math.random() * world.config.height }, { energyFraction: 0.7 });
      }
      extinctSince.delete(s.speciesId);
      send({ type: "notice", tick: world.tick, message: `${founders} ${s.name} founders arrived.` });
    }
  }
}

function tick(): void {
  world.step();
  if (world.tick % 10 === 0) recolonize();
  send({ type: "frame", frame: encodeFrame(world) });
  const out = world.takeEmigrants();
  if (out.length) {
    send({
      type: "emigrants",
      migrants: out.map((migrant) => ({ codeHash: species.find((s) => s.slot === migrant.speciesId)!.codeHash, migrant })),
    });
  }
  if (world.tick % 10 === 0) sendStats();
}

function sendStats(): void {
  send({ type: "stats", tick: world.tick, stats: world.allStats(), plants: world.count("plant"), tps, paused });
}

function schedule(): void {
  clearTimeout(timer);
  if (stopped || paused) return;
  const started = Date.now();
  timer = setTimeout(() => {
    try {
      tick();
    } catch (e) {
      send({ type: "fatal", error: e instanceof Error ? e.message : String(e) });
      stopped = true;
      return;
    }
    schedule();
  }, Math.max(0, 1000 / tps - (Date.now() - started)));
}

port.on("message", async (cmd: LiveCommand) => {
  try {
    switch (cmd.type) {
      case "addSpecies":
        await ensureSpecies(cmd.entrant, cmd.population);
        break;
      case "immigrate": {
        await ensureSpecies(cmd.entrant, 0);
        world.immigrate(cmd.migrant, edgePoint());
        break;
      }
      case "control":
        if (cmd.action === "pause") paused = true;
        if (cmd.action === "resume") paused = false;
        if (cmd.action === "step" && paused) tick();
        sendStats();
        schedule();
        break;
      case "setTps":
        tps = Math.min(Math.max(cmd.tps, 0.5), 200);
        sendStats();
        schedule();
        break;
      case "stop":
        stopped = true;
        clearTimeout(timer);
        world.dispose();
        port.close();
        break;
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cmd.type === "addSpecies" || cmd.type === "immigrate") send({ type: "speciesError", codeHash: cmd.entrant.codeHash, error });
    else send({ type: "fatal", error });
  }
});

send({ type: "ready" });
send({ type: "species", species });
schedule();
