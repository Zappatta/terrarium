import { STANDARD_RULESET_VERSION } from "@terrarium/engine";
import { Db } from "./db.js";
import { LiveManager } from "./live.js";
import { Registry } from "./registry.js";
import { RunService } from "./runs.js";
import { BatchPool } from "./workers/pool.js";
import type { Services } from "./http.js";

export interface ServerOptions {
  dbPath: string;
  workers: number;
  maxLiveWorlds?: number;
  token?: string;
  seedBuiltins?: boolean;
}

export async function createServices(opts: ServerOptions): Promise<Services & { close(): Promise<void> }> {
  const db = new Db(opts.dbPath);
  const registry = new Registry(db, STANDARD_RULESET_VERSION);
  if (opts.seedBuiltins ?? true) await registry.seedBuiltins(new URL("../../sdk/examples/", import.meta.url));
  const pool = new BatchPool(opts.workers);
  const runs = new RunService(db, registry, pool);
  const live = new LiveManager(registry, opts.maxLiveWorlds);
  return {
    db,
    registry,
    runs,
    live,
    pool,
    token: opts.token,
    async close() {
      await live.closeAll();
      await pool.close();
      db.close();
    },
  };
}
