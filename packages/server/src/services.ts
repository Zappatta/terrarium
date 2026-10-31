import { STANDARD_RULESET_VERSION } from "@terrarium/engine";
import { Db } from "./db.js";
import { LiveManager } from "./live.js";
import { Registry } from "./registry.js";
import { RunService } from "./runs.js";
import { BatchPool } from "./workers/pool.js";
import type { Services } from "./http.js";
import { Auth, googleVerifier, type GoogleVerifier } from "./auth.js";

export interface ServerOptions {
  dbPath: string;
  workers: number;
  maxLiveWorlds?: number;
  seedBuiltins?: boolean;
  googleClientId?: string;
  /** Override token verification (tests). Defaults to Google's published keys when googleClientId is set. */
  verifyGoogle?: GoogleVerifier;
  admins?: string[];
  devLogin?: boolean;
  /** Mark session cookies Secure. Turn on behind HTTPS. */
  secureCookies?: boolean;
}

export async function createServices(opts: ServerOptions): Promise<Services & { close(): Promise<void> }> {
  const db = new Db(opts.dbPath);
  const registry = new Registry(db, STANDARD_RULESET_VERSION);
  if (opts.seedBuiltins ?? true) await registry.seedBuiltins(new URL("../../sdk/examples/", import.meta.url));
  const pool = new BatchPool(opts.workers);
  const runs = new RunService(db, registry, pool);
  const live = new LiveManager(registry, db, opts.maxLiveWorlds);
  const auth = new Auth(db, {
    admins: opts.admins ?? [],
    googleClientId: opts.googleClientId,
    verifyGoogle: opts.verifyGoogle ?? (opts.googleClientId ? googleVerifier(opts.googleClientId) : undefined),
    devLogin: opts.devLogin,
  });
  return {
    auth,
    secureCookies: opts.secureCookies ?? false,
    db,
    registry,
    runs,
    live,
    pool,
    async close() {
      await live.closeAll();
      await pool.close();
      db.close();
    },
  };
}
