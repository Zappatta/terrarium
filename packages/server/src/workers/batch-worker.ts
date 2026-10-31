import { parentPort } from "node:worker_threads";
import { runMatch } from "../match.js";
import type { Frame } from "../frames.js";
import type { BatchRequest, BatchResponse } from "./protocol.js";

const port = parentPort!;
const send = (m: BatchResponse) => port.postMessage(m);

port.on("message", async ({ jobId, job }: BatchRequest) => {
  try {
    if (job.kind === "match") {
      const output = await runMatch(job.spec, { onProgress: (tick) => send({ jobId, type: "progress", tick }) });
      send({ jobId, type: "done", output });
    } else {
      const frames: Frame[] = [];
      const maxTicks = job.spec.world.maxTicks ?? Infinity;
      const runToEnd = job.to >= maxTicks;
      const r = await runMatch(
        { ...job.spec, timelineEvery: 0 },
        { frameEvery: job.every, frameFrom: job.from, frameTo: job.to, onFrame: (f) => frames.push(f), stopAfter: runToEnd ? undefined : job.to },
      );
      send({ jobId, type: "done", output: { frames, hash: r.hash, ticks: r.ticks, complete: r.ticks === r.maxTicks || runToEnd } });
    }
  } catch (e) {
    send({ jobId, type: "error", error: e instanceof Error ? e.message : String(e) });
  }
});
