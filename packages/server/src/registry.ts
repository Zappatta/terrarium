import { readdirSync, readFileSync } from "node:fs";
import { World } from "@terrarium/engine";
import { CompileError, SandboxController, compileCreature } from "@terrarium/sandbox";
import { now, type CreatureRecord, type CreatureWithCode, type Db } from "./db.js";
import { UserError } from "./errors.js";
import { rulesetModules, type EntrantSpec } from "./match.js";
import type { User } from "./auth.js";

export interface SubmitRequest {
  source: string;
  filename?: string;
  /** The uploader. Null only for builtin species. */
  owner: User | null;
  description?: string;
  builtin?: boolean;
}

export class Registry {
  constructor(private readonly db: Db, private readonly ruleset: string) {}

  /** Compile, load in a sandbox, validate traits against the ruleset, then store. Idempotent per code hash. */
  async submit(req: SubmitRequest): Promise<{ creature: CreatureRecord; created: boolean }> {
    let compiled;
    try {
      compiled = await compileCreature(req.source, req.filename ?? "creature.ts");
    } catch (e) {
      if (e instanceof CompileError) throw new UserError(`Compile error:\n${e.message}`);
      throw e;
    }
    const existing = this.db.getCreature(compiled.codeHash);
    if (existing) return { creature: strip(existing), created: false };

    let controller: SandboxController;
    try {
      controller = await SandboxController.create(compiled, { isolation: "runtime" });
    } catch (e) {
      throw new UserError(e instanceof Error ? e.message : String(e));
    }
    try {
      const traits = new World(rulesetModules(this.ruleset)).validateTraits(controller.descriptor);
      const ownerId = req.owner?.id ?? null;
      const record: CreatureWithCode = {
        codeHash: compiled.codeHash,
        name: controller.descriptor.name,
        diet: controller.descriptor.diet,
        traits,
        ownerId,
        version: this.db.nextVersion(ownerId, controller.descriptor.name),
        author: req.owner?.name ?? (req.builtin ? "builtin" : null),
        description: req.description ?? null,
        builtin: req.builtin ?? false,
        source: req.source,
        code: compiled.code,
        createdAt: now(),
      };
      this.db.insertCreature(record);
      return { creature: strip(record), created: true };
    } catch (e) {
      throw new UserError(`Invalid species: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      controller.dispose();
    }
  }

  resolve(ref: string): CreatureWithCode {
    const c = this.db.resolveCreature(ref);
    if (!c) throw new UserError(`Unknown creature "${ref}"`, 404);
    return c;
  }

  /** Owners and admins may use a creature as their own; builtin species are open to everyone. */
  canUse(c: CreatureWithCode, user: User): boolean {
    return c.builtin || c.ownerId === user.id || user.isAdmin;
  }

  canReadSource(c: CreatureWithCode, user: User | null): boolean {
    return c.builtin || (!!user && (c.ownerId === user.id || user.isAdmin));
  }

  entrant(c: CreatureWithCode, slot: string, ranked: boolean): EntrantSpec {
    return { slot, codeHash: c.codeHash, code: c.code, name: c.name, ranked };
  }

  async seedBuiltins(dir: URL): Promise<CreatureRecord[]> {
    const out: CreatureRecord[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
      const source = readFileSync(new URL(file, dir), "utf8");
      const { creature } = await this.submit({ source, filename: file, owner: null, builtin: true });
      out.push(creature);
    }
    this.db.setBuiltins(out.map((c) => c.codeHash));
    return out.map((c) => ({ ...c, builtin: true }));
  }
}

function strip({ source: _s, code: _c, ...rest }: CreatureWithCode): CreatureRecord {
  return rest;
}
