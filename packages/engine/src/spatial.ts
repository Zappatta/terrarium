import type { EntityId, Vec2 } from "@terrarium/sdk";

/** Uniform grid. Query results come back sorted by id so callers stay deterministic. */
export class SpatialHash {
  private cells = new Map<number, Set<EntityId>>();
  private where = new Map<EntityId, number>();
  private readonly cols: number;

  constructor(readonly width: number, readonly height: number, readonly cellSize: number) {
    this.cols = Math.ceil(width / cellSize) + 1;
  }

  private key(p: Vec2): number {
    const cx = Math.max(0, Math.floor(p.x / this.cellSize));
    const cy = Math.max(0, Math.floor(p.y / this.cellSize));
    return cy * this.cols + cx;
  }

  upsert(id: EntityId, p: Vec2): void {
    const k = this.key(p);
    const prev = this.where.get(id);
    if (prev === k) return;
    if (prev !== undefined) this.cells.get(prev)?.delete(id);
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = new Set()));
    cell.add(id);
    this.where.set(id, k);
  }

  remove(id: EntityId): void {
    const prev = this.where.get(id);
    if (prev === undefined) return;
    this.cells.get(prev)?.delete(id);
    this.where.delete(id);
  }

  /** Candidate ids whose cell overlaps the circle. Callers filter by exact distance. */
  near(p: Vec2, radius: number): EntityId[] {
    const minX = Math.max(0, Math.floor((p.x - radius) / this.cellSize));
    const maxX = Math.floor((p.x + radius) / this.cellSize);
    const minY = Math.max(0, Math.floor((p.y - radius) / this.cellSize));
    const maxY = Math.floor((p.y + radius) / this.cellSize);
    const out: EntityId[] = [];
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX && cx < this.cols; cx++) {
        const cell = this.cells.get(cy * this.cols + cx);
        if (cell) for (const id of cell) out.push(id);
      }
    }
    return out.sort((a, b) => a - b);
  }
}
