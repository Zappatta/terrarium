import type { World } from "@terrarium/engine";

export const KIND_CODES: Record<string, number> = { plant: 0, animal: 1, corpse: 2 };

/**
 * Compact spectator frame. Each entity is [id, kind, x, y, radius, speciesSlot | "", energy].
 * Coordinates are rounded to 0.1, which is plenty for drawing.
 */
export interface Frame {
  tick: number;
  e: Array<[number, number, number, number, number, string, number]>;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function encodeFrame(world: World): Frame {
  return {
    tick: world.tick,
    e: world.all().map((x) => [
      x.id,
      KIND_CODES[x.kind] ?? 9,
      r1(x.pos.x),
      r1(x.pos.y),
      r1(x.radius),
      x.c.species?.speciesId ?? "",
      Math.round(x.c.energy?.value ?? 0),
    ]),
  };
}
