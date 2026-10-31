import type { World } from "./world.js";

/** Typed, per-world cached params for a module, with overrides from WorldConfig.params. */
export function moduleParams<T extends Record<string, number>>(moduleId: string, defaults: T): (world: World) => T {
  const cache = new WeakMap<World, T>();
  return (world) => {
    let p = cache.get(world);
    if (!p) cache.set(world, (p = world.params(moduleId, defaults)));
    return p;
  };
}
