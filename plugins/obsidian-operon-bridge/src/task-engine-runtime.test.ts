import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTaskEnginePlugin,
  SUPPORTED_TASK_ENGINE_PLUGIN_IDS,
} from "./task-engine-runtime";

test("prefers the only loaded compatible task engine", () => {
  const kairelys = { manifest: { name: "Kairélys" } };
  const resolved = resolveTaskEnginePlugin({ plugins: { kairelys } });
  assert.deepEqual(SUPPORTED_TASK_ENGINE_PLUGIN_IDS, ["kairelys", "operon"]);
  assert.equal(resolved?.id, "kairelys");
  assert.equal(resolved?.name, "Kairélys");
  assert.equal(resolved?.plugin, kairelys);
});

test("keeps official Operon compatibility", () => {
  const operon = { manifest: { name: "Operon" } };
  const resolved = resolveTaskEnginePlugin({ getPlugin: (id) =>
    id === "operon" ? operon : null });
  assert.equal(resolved?.id, "operon");
  assert.equal(resolved?.plugin, operon);
});

test("returns null when neither engine is loaded", () => {
  assert.equal(resolveTaskEnginePlugin({ plugins: {} }), null);
});

test("rejects ambiguous dual ownership", () => {
  assert.throws(
    () => resolveTaskEnginePlugin({
      plugins: {
        kairelys: { manifest: { name: "Kairélys" } },
        operon: { manifest: { name: "Operon" } },
      },
    }),
    /both loaded/u,
  );
});
