import { createHash } from "node:crypto";
import { build, type Plugin } from "esbuild";

export interface CompiledCreature {
  code: string;
  /** Identity of the creature. Everything that ranks or replays a creature keys on this. */
  codeHash: string;
}

export class CompileError extends Error {}

export const MAX_SOURCE_BYTES = 256 * 1024;
const SDK_SHIM = "export function defineSpecies(d) { return d; }\nexport function definePlant(d) { return d; }";

const sdkOnly: Plugin = {
  name: "terrarium-sdk-only",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return undefined;
      if (args.path === "@terrarium/sdk") return { path: "sdk", namespace: "terrarium-sdk" };
      return { errors: [{ text: `Import "${args.path}" is not allowed. Creatures are one file and may only import @terrarium/sdk.` }] };
    });
    b.onLoad({ filter: /.*/, namespace: "terrarium-sdk" }, () => ({ contents: SDK_SHIM, loader: "js" }));
  },
};

export async function compileCreature(source: string, filename = "creature.ts"): Promise<CompiledCreature> {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new CompileError(`Source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  try {
    const result = await build({
      stdin: { contents: source, loader: filename.endsWith(".js") ? "js" : "ts", sourcefile: filename, resolveDir: "/" },
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__creature",
      platform: "neutral",
      target: "es2022",
      legalComments: "none",
      logLevel: "silent",
      plugins: [sdkOnly],
    });
    const code = result.outputFiles[0]!.text;
    return { code, codeHash: createHash("sha256").update(code).digest("hex") };
  } catch (e) {
    const errors = (e as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> }).errors;
    if (errors?.length) {
      throw new CompileError(
        errors.map((x) => (x.location ? `${filename}:${x.location.line}:${x.location.column} ${x.text}` : x.text)).join("\n"),
      );
    }
    throw e;
  }
}
