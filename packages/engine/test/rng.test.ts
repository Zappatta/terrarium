import { describe, expect, it } from "vitest";
import { Rng, SpatialHash } from "@terrarium/engine";

describe("Rng", () => {
  it("is reproducible per seed", () => {
    const a = new Rng("x");
    const b = new Rng("x");
    expect(Array.from({ length: 50 }, () => a.next())).toEqual(Array.from({ length: 50 }, () => b.next()));
  });

  it("differs across seeds and forks", () => {
    expect(new Rng("x").next()).not.toBe(new Rng("y").next());
    const root = new Rng("x");
    expect(root.fork("a").next()).not.toBe(root.fork("b").next());
  });

  it("stays in [0, 1)", () => {
    const r = new Rng("bounds");
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});

describe("SpatialHash", () => {
  it("finds the same entities as a brute-force scan", () => {
    const rng = new Rng("spatial");
    const grid = new SpatialHash(500, 500, 32);
    const points = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, x: rng.range(0, 500), y: rng.range(0, 500) }));
    for (const p of points) grid.upsert(p.id, p);
    for (const p of points.slice(0, 100)) grid.upsert(p.id, { x: p.x = rng.range(0, 500), y: p.y = rng.range(0, 500) });
    for (const p of points.slice(100, 120)) grid.remove(p.id);
    const live = points.filter((p) => p.id <= 100 || p.id > 120);

    for (let q = 0; q < 50; q++) {
      const c = { x: rng.range(0, 500), y: rng.range(0, 500) };
      const r = rng.range(5, 80);
      const expected = live.filter((p) => Math.hypot(p.x - c.x, p.y - c.y) <= r).map((p) => p.id);
      const got = new Set(grid.near(c, r));
      for (const id of expected) expect(got.has(id)).toBe(true);
    }
  });
});
