import type { Vec2 } from "@terrarium/sdk";

export const dist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const dist = (a: Vec2, b: Vec2): number => Math.sqrt(dist2(a, b));
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const isFiniteVec = (v: unknown): v is Vec2 =>
  typeof v === "object" && v !== null && Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y);
