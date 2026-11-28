import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { jsonLine, writeSynced } from "./generation.mjs";

export async function publishServiceStatus(index, status) {
  const pending = path.join(index, ".SERVICE-" + randomUUID());
  try {
    await writeSynced(pending, jsonLine({ version: 1, ...status }));
    await rename(pending, path.join(index, "SERVICE.json"));
  } finally {
    await rm(pending, { force: true });
  }
}

function changedNotes(baseline, inventory) {
  if (!baseline) return null;
  let count = 0;
  for (const [name, stamp] of inventory) {
    if (!Object.hasOwn(baseline, name) || baseline[name] !== stamp) count++;
  }
  for (const name of Object.keys(baseline)) {
    if (!inventory.has(name)) count++;
  }
  return count;
}

export async function runIndexService({ index, active, scan, build, pollMs, debounceMs, signal }) {
  let lastInventory;
  let changeAt = 0;
  let failures = 0;
  let retryAt = 0;
  let lastError = null;
  const fail = (code) => {
    lastError = code;
    failures++;
    retryAt = performance.now() + Math.min(Math.max(pollMs, 1000) * 2 ** Math.min(failures - 1, 10), 300_000);
  };
  const report = (pendingChanges, observedAt) => publishServiceStatus(index, {
    generation: active?.manifest.generation ?? null,
    observedAt,
    validUntil: observedAt + Math.max(1000, 3 * pollMs),
    pendingChanges,
    lastError,
    retryAt: lastError ? Date.now() + Math.max(0, Math.ceil(retryAt - performance.now())) : null,
  });

  try {
    while (!signal.aborted) {
      let snapshot;
      try {
        snapshot = await scan(active);
      } catch {
        fail("scan_failed");
      }
      const observedAt = Date.now();
      const inventory = snapshot && new Map([...snapshot.files, ...snapshot.unsafePaths]);
      const baseline = active?.manifest.inventoryStamps;
      const pendingChanges = inventory ? changedNotes(baseline, inventory) : null;
      if (inventory && !isDeepStrictEqual(inventory, lastInventory)) {
        changeAt = performance.now();
        lastInventory = inventory;
      }
      if (pendingChanges === 0 && active?.manifest.vaultBinding === snapshot?.binding) {
        failures = 0;
        retryAt = 0;
        lastError = null;
      }
      await report(pendingChanges, observedAt);
      if (inventory && (pendingChanges !== 0 || active?.manifest.vaultBinding !== snapshot.binding) &&
          performance.now() >= Math.max(retryAt, changeAt + debounceMs) && !signal.aborted) {
        try {
          active = await build();
          failures = 0;
          retryAt = 0;
          lastError = null;
          // Observe against the new generation on the next scan. Edits can
          // arrive between the pre-publication check and pointer replacement.
          continue;
        } catch (error) {
          fail(error.code === "EMBEDDING_BUSY" ? "embedding_busy" :
            error.code === "EMBEDDING_FAILED" ? "embedding_failed" : "build_failed");
          await report(pendingChanges, observedAt);
        }
      }
      await delay(pollMs, undefined, { signal }).catch(error => {
        if (error.name !== "AbortError") throw error;
      });
    }
  } finally {
    if (signal.aborted) await report(null, Date.now());
  }
}
