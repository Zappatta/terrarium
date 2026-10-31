/** 32-bit FNV-1a, also used for state hashing. */
export function fnv1a(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** sfc32: small, fast, and identical on every JS engine because it only uses 32-bit integer ops. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly seed: string, words?: [number, number, number, number]) {
    const mix = splitmix32(fnv1a(seed));
    [this.a, this.b, this.c, this.d] = words ?? [mix(), mix(), mix(), mix()];
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  /** The four seed words a creature's Math.random is initialised with. Shared by sandbox and native runs. */
  static brainWords(seed: string): [number, number, number, number] {
    const r = new Rng(seed);
    return [r.nextU32(), r.nextU32(), r.nextU32(), r.nextU32()];
  }

  /** Independent stream derived from this seed, so adding a consumer never shifts other streams. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}
