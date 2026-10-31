import type { DecideInput, VisibleEntity } from "@terrarium/sdk";

/**
 * Host -> sandbox transfer. JSON parsing inside QuickJS runs at roughly 30 MB/s, so the bulk of
 * each tick (self views and visible entities) goes over as a Float64Array instead, laid out by a
 * schema inferred from the data. A small JSON header carries the schema, strings and events.
 *
 * Field types: n = number, b = boolean, s = string (index into header.strings), v = {x, y}.
 * NaN marks null (self views) or an absent field (entities).
 */
type FieldType = "n" | "b" | "s" | "v";
type Schema = Array<[string, FieldType]>;

export interface BinaryWire {
  header: string;
  buffer: ArrayBuffer;
}

function inferSchema(objects: Array<Record<string, unknown>>): Schema | null {
  const types = new Map<string, FieldType>();
  for (const obj of objects) {
    for (const key in obj) {
      const v = obj[key];
      if (v === null || v === undefined) {
        if (!types.has(key)) types.set(key, "n");
        continue;
      }
      let t: FieldType;
      if (typeof v === "number") t = "n";
      else if (typeof v === "boolean") t = "b";
      else if (typeof v === "string") t = "s";
      else if (typeof v === "object" && Object.keys(v).length === 2 && "x" in v && "y" in v) t = "v";
      else return null;
      const prev = types.get(key);
      if (prev && prev !== t && !(prev === "n" && isNullOnly(objects, key))) return null;
      types.set(key, t);
    }
  }
  return [...types];
}

function isNullOnly(objects: Array<Record<string, unknown>>, key: string): boolean {
  return objects.every((o) => o[key] === null || o[key] === undefined || typeof o[key] !== "number");
}

const width = (s: Schema) => s.reduce((n, [, t]) => n + (t === "v" ? 2 : 1), 0);

/** Returns null when the data has a shape the binary format does not cover; callers fall back to JSON. */
export function encodeBinary(input: DecideInput): BinaryWire | null {
  const entityIndex = new Map<number, number>();
  const entities: Array<Record<string, unknown>> = [];
  let pairs = 0;
  for (const o of input.organisms) {
    pairs += o.visible.length;
    for (const v of o.visible) {
      if (entityIndex.has(v.id)) continue;
      entityIndex.set(v.id, entities.length);
      const { distance: _d, ...rest } = v;
      entities.push(rest);
    }
  }
  const selves = input.organisms.map((o) => o.self as unknown as Record<string, unknown>);
  const selfSchema = inferSchema(selves);
  const entTypes = inferSchema(entities);
  if (!selfSchema || !entTypes) return null;
  const typeOf = new Map(entTypes);

  // Entities come in a few fixed shapes (wild plant, species plant, animal, corpse). Each shape gets
  // its own schema, so the sandbox can build every entity with one object literal.
  const shapes: Schema[] = [];
  const shapeIndex = new Map<string, number>();
  const entityShape = entities.map((e) => {
    const keys = Object.keys(e).filter((k) => e[k] !== undefined && e[k] !== null);
    const id = keys.join(",");
    let i = shapeIndex.get(id);
    if (i === undefined) {
      shapeIndex.set(id, (i = shapes.length));
      shapes.push(keys.map((k) => [k, typeOf.get(k)!]));
    }
    return i;
  });

  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const str = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) stringIndex.set(s, (i = strings.push(s) - 1));
    return i;
  };

  let entFloats = 0;
  for (const i of entityShape) entFloats += 1 + width(shapes[i]!);
  // Layout: [entity offsets][entities: shape, fields...][organisms: self fields, count, (index, distance)*]
  const f = new Float64Array(entities.length + entFloats + selves.length * (width(selfSchema) + 1) + pairs * 2);
  let o = entities.length;
  const write = (obj: Record<string, unknown>, schema: Schema) => {
    for (const [key, t] of schema) {
      const v = obj[key];
      if (t === "v") {
        const p = v as { x: number; y: number } | null | undefined;
        f[o++] = p ? p.x : NaN;
        f[o++] = p ? p.y : NaN;
      } else if (v === null || v === undefined) f[o++] = NaN;
      else if (t === "n") f[o++] = v as number;
      else if (t === "b") f[o++] = v ? 1 : 0;
      else f[o++] = str(v as string);
    }
  };
  entities.forEach((e, i) => {
    f[i] = o;
    f[o++] = entityShape[i]!;
    write(e, shapes[entityShape[i]!]!);
  });
  const orgStart = o;
  const events: Record<number, unknown> = {};
  input.organisms.forEach((org, i) => {
    write(selves[i]!, selfSchema);
    f[o++] = org.visible.length;
    for (const v of org.visible) {
      f[o++] = entityIndex.get(v.id)!;
      f[o++] = v.distance;
    }
    if (org.events.length) events[i] = org.events;
  });

  const header = JSON.stringify({ world: input.world, died: input.died, strings, self: selfSchema, shapes, orgStart, n: selves.length, events });
  return { header, buffer: f.buffer };
}

/** JSON variant of the same idea, used when the binary format cannot represent the data. */
export function encodeWire(input: DecideInput): unknown {
  const entities = new Map<number, Omit<VisibleEntity, "distance">>();
  const organisms = input.organisms.map((o) => ({
    self: o.self,
    events: o.events,
    v: o.visible.map((v) => {
      if (!entities.has(v.id)) {
        const { distance: _d, ...rest } = v;
        entities.set(v.id, rest);
      }
      return [v.id, v.distance];
    }),
  }));
  return { world: input.world, died: input.died, entities: [...entities.values()], organisms };
}
