import type { Worker } from "node:worker_threads";
import { spawnWorker } from "./spawn.js";
import type { BatchJob, BatchOutput, BatchResponse } from "./protocol.js";

interface Pending {
  jobId: number;
  job: BatchJob;
  resolve(out: BatchOutput): void;
  reject(err: Error): void;
  onProgress?(tick: number): void;
}

interface Slot {
  worker: Worker;
  current: Pending | null;
}

/** Fixed-size pool of match workers with a FIFO queue. A crashed worker fails its job and is replaced. */
export class BatchPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private nextJobId = 1;
  private closed = false;

  constructor(readonly size: number) {
    for (let i = 0; i < size; i++) this.slots.push(this.makeSlot());
  }

  get queued(): number {
    return this.queue.length;
  }

  get busy(): number {
    return this.slots.filter((s) => s.current).length;
  }

  run(job: BatchJob, onProgress?: (tick: number) => void): Promise<BatchOutput> {
    if (this.closed) return Promise.reject(new Error("pool closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ jobId: this.nextJobId++, job, resolve, reject, onProgress });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) p.reject(new Error("pool closed"));
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }

  private makeSlot(): Slot {
    const slot: Slot = { worker: spawnWorker(new URL("./batch-worker.ts", import.meta.url)), current: null };
    slot.worker.on("message", (m: BatchResponse) => {
      const p = slot.current;
      if (!p || p.jobId !== m.jobId) return;
      if (m.type === "progress") return p.onProgress?.(m.tick);
      slot.current = null;
      if (m.type === "done") p.resolve(m.output);
      else p.reject(new Error(m.error));
      this.pump();
    });
    slot.worker.on("error", (err) => this.replace(slot, err instanceof Error ? err : new Error(String(err))));
    slot.worker.on("exit", (code) => {
      if (!this.closed) this.replace(slot, new Error(`worker exited with code ${code}`));
    });
    return slot;
  }

  private replace(slot: Slot, err: Error): void {
    const i = this.slots.indexOf(slot);
    if (i < 0 || this.closed) return;
    slot.current?.reject(err);
    slot.current = null;
    slot.worker.removeAllListeners();
    void slot.worker.terminate();
    this.slots[i] = this.makeSlot();
    this.pump();
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.current || this.queue.length === 0) continue;
      const p = this.queue.shift()!;
      slot.current = p;
      slot.worker.postMessage({ jobId: p.jobId, job: p.job });
    }
  }
}
