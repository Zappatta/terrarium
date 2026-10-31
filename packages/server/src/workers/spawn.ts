import { Worker } from "node:worker_threads";

/** Workers are TypeScript in dev; those go through a bootstrap that registers tsx first. */
export function spawnWorker(file: URL, workerData?: unknown): Worker {
  if (!file.pathname.endsWith(".ts")) return new Worker(file, { workerData });
  return new Worker(new URL("./bootstrap.mjs", import.meta.url), { workerData, argv: [file.href] });
}
