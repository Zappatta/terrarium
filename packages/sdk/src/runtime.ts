/**
 * Plain ES5-ish JS that adapts a SpeciesDefinition to the host protocol. It is shipped as a string so
 * the sandbox and the native controller run byte-identical code.
 */
export const SPECIES_RUNTIME_SOURCE = String.raw`
function __createSpeciesRuntime(def, random, log) {
  if (!def || typeof def !== "object") throw new Error("creature module must export a species definition as default");
  var memories = new Map();
  var ctx = {
    world: null,
    shared: {},
    memory: function (id) {
      var m = memories.get(id);
      if (!m) { m = {}; memories.set(id, m); }
      return m;
    },
    random: random,
    log: log
  };
  var setupDone = false;
  function fmt(err) { return err && err.message ? String(err.message) : String(err); }
  // The host may send each visible entity once per tick in "entities" and only [id, distance]
  // pairs per organism. Rebuild the plain per-organism lists creature code expects.
  function expandWire(w) {
    var byId = new Map();
    for (var i = 0; i < w.entities.length; i++) byId.set(w.entities[i].id, w.entities[i]);
    var organisms = new Array(w.organisms.length);
    for (var j = 0; j < w.organisms.length; j++) {
      var o = w.organisms[j];
      var vis = new Array(o.v.length);
      for (var k = 0; k < o.v.length; k++) {
        var src = byId.get(o.v[k][0]);
        var v = {};
        for (var key in src) v[key] = src[key];
        v.distance = o.v[k][1];
        if (src.pos) v.pos = { x: src.pos.x, y: src.pos.y };
        vis[k] = v;
      }
      organisms[j] = { self: o.self, visible: vis, events: o.events };
    }
    return { world: w.world, organisms: organisms, died: w.died };
  }
  // Binary transfer: a JSON header plus a Float64Array laid out by the header's schemas. Readers
  // are generated per schema and build each object with a single literal: QuickJS resolves literal
  // property names at compile time and gives the object its final shape at once, which is several
  // times faster than adding properties one by one through runtime key strings.
  var readers = {};
  function lit(k) { return JSON.stringify(k); }
  function reader(schema, nullable, withDistance) {
    var key = (nullable ? "n" : "s") + (withDistance ? "d" : "") + JSON.stringify(schema);
    var r = readers[key];
    if (r) return r;
    var parts = [], i = 0;
    for (var n = 0; n < schema.length; n++) {
      var k = lit(schema[n][0]), t = schema[n][1], at = "f[a + " + i + "]";
      if (t === "v") {
        var obj = "{ x: " + at + ", y: f[a + " + (i + 1) + "] }";
        parts.push(k + ": " + (nullable ? "(" + at + " === " + at + " ? " + obj + " : null)" : obj));
        i += 2;
      } else {
        var val = t === "n" ? at : t === "b" ? at + " === 1" : "S[" + at + "]";
        parts.push(k + ": " + (nullable ? "(" + at + " === " + at + " ? " + val + " : null)" : val));
        i += 1;
      }
    }
    if (withDistance) parts.push("distance: d");
    r = { width: i, read: new Function("f", "a", "S", "d", "return { " + parts.join(", ") + " };") };
    readers[key] = r;
    return r;
  }
  function decodeBinary(headerJson, buffer) {
    var h = JSON.parse(headerJson);
    var f = new Float64Array(buffer);
    var S = h.strings;
    var shapes = new Array(h.shapes.length);
    for (var s = 0; s < shapes.length; s++) shapes[s] = reader(h.shapes[s], false, true).read;
    var self = reader(h.self, true, false), readSelf = self.read, selfWidth = self.width;
    var o = h.orgStart;
    var organisms = new Array(h.n);
    for (var j = 0; j < h.n; j++) {
      var me = readSelf(f, o, S);
      o += selfWidth;
      var count = f[o++];
      var vis = new Array(count);
      for (var k = 0; k < count; k++) {
        var at = f[f[o]];
        vis[k] = shapes[f[at]](f, at + 1, S, f[o + 1]);
        o += 2;
      }
      organisms[j] = { self: me, visible: vis, events: h.events[j] || [] };
    }
    return { world: h.world, organisms: organisms, died: h.died };
  }
  return {
    decodeBinary: decodeBinary,
    describe: function () {
      var traits = {};
      var src = def.traits || {};
      for (var k in src) traits[k] = src[k];
      return { name: String(def.name || "unnamed").slice(0, 64), diet: def.diet, traits: traits };
    },
    decide: function (input) {
      if (input.entities) input = expandWire(input);
      ctx.world = input.world;
      if (!setupDone) { setupDone = true; if (typeof def.setup === "function") def.setup(ctx); }
      for (var i = 0; i < input.died.length; i++) {
        var id = input.died[i];
        if (typeof def.onDeath === "function") {
          try { def.onDeath(id, ctx); } catch (e) { log("onDeath error: " + fmt(e)); }
        }
        memories.delete(id);
      }
      var actions = [];
      if (typeof def.thinkAll === "function") {
        actions = def.thinkAll(input.organisms, ctx) || [];
      } else if (typeof def.think === "function") {
        for (var j = 0; j < input.organisms.length; j++) {
          var p = input.organisms[j];
          try {
            var a = def.think(p, ctx);
            if (a) actions.push([p.self.id, a]);
          } catch (e) {
            log("think error for " + p.self.id + ": " + fmt(e));
          }
        }
      }
      return { actions: actions };
    }
  };
}
`;
