// Loads a TypeScript worker in development: register tsx, then import the entry passed in argv.
import { register } from "tsx/esm/api";

register();
await import(process.argv.at(-1));
