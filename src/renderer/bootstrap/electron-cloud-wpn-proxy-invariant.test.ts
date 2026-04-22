/**
 * Regression: Electron `contextBridge` exposes methods as non-configurable properties.
 * `new Proxy(bridged, { get })` must not return a different function for those keys (invariant violation).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("non-configurable bridged method + substitute get trap throws (old cloud pattern)", () => {
  const bridged: Record<string, unknown> = {};
  Object.defineProperty(bridged, "wpnListAllNotesWithContext", {
    value: () => ({ notes: [] }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
  const webApi = {
    wpnListAllNotesWithContext: () => ({ notes: [{ id: "from-web" }] }),
  };
  const bad = new Proxy(bridged, {
    get(t, prop, r) {
      if (prop === "wpnListAllNotesWithContext") {
        const v = Reflect.get(webApi, prop, webApi) as (...a: unknown[]) => unknown;
        return v.bind(webApi);
      }
      return Reflect.get(t, prop, r);
    },
  });
  assert.throws(() => {
    void (bad as { wpnListAllNotesWithContext: () => unknown }).wpnListAllNotesWithContext();
  }, TypeError);
});

test("null-prototype shell target + Reflect.get(webApi) does not throw", () => {
  const bridged: Record<string, unknown> = {};
  Object.defineProperty(bridged, "wpnListAllNotesWithContext", {
    value: () => ({ notes: [] }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
  const webApi = {
    wpnListAllNotesWithContext: () => ({ notes: [{ id: "from-web" }] }),
  };
  const shell = Object.create(null);
  const good = new Proxy(shell, {
    get(_t, prop, r) {
      if (prop === "wpnListAllNotesWithContext") {
        return Reflect.get(webApi, prop, webApi);
      }
      return Reflect.get(bridged, prop, r);
    },
    has(_t, prop) {
      if (prop === "wpnListAllNotesWithContext") {
        return Reflect.has(webApi, prop);
      }
      return Reflect.has(bridged, prop);
    },
  });
  const out = (good as { wpnListAllNotesWithContext: () => { notes: { id: string }[] } }).wpnListAllNotesWithContext();
  assert.strictEqual(out.notes[0]?.id, "from-web");
});
