/**
 * Evaluated before creature code. Removes every source of non-determinism the creature could reach
 * and routes console output to the host log buffer.
 */
export const PRELUDE_SOURCE = String.raw`
(function () {
  var a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = 1;
  function sfc32() {
    var t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t / 4294967296;
  }
  var random = function random() { return sfc32(); };
  Object.defineProperty(globalThis, "__seedRandom", {
    value: function (s0, s1, s2, s3) { a = s0 >>> 0; b = s1 >>> 0; c = s2 >>> 0; d = s3 >>> 0; for (var i = 0; i < 12; i++) sfc32(); },
    configurable: true
  });
  Object.defineProperty(Math, "random", { value: random, writable: false, configurable: false });

  delete globalThis.Date;
  delete globalThis.WeakRef;
  delete globalThis.FinalizationRegistry;
  delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics;

  var hostLog = globalThis.__hostLog;
  delete globalThis.__hostLog;
  function fmt(v) {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  var log = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
    hostLog(parts.join(" "));
  };
  Object.defineProperty(globalThis, "__log", { value: log, configurable: true });
  globalThis.console = { log: log, info: log, warn: log, error: log, debug: log };
})();
`;

export const BOOT_SOURCE = String.raw`
(function () {
  var mod = globalThis.__creature;
  var def = mod && (mod.default || mod);
  var rt = __createSpeciesRuntime(def, Math.random, __log);
  Object.defineProperty(globalThis, "__describeJSON", { value: function () { return JSON.stringify(rt.describe()); } });
  Object.defineProperty(globalThis, "__decideJSON", {
    value: function (s) { return JSON.stringify(rt.decide(JSON.parse(s))); }
  });
  Object.defineProperty(globalThis, "__decideBinary", {
    value: function (header, buffer) { return JSON.stringify(rt.decide(rt.decodeBinary(header, buffer))); }
  });
})();
`;
