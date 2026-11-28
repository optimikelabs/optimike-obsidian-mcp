import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { jsonLine, writeSynced } from "./generation.mjs";
import { readSource, sha256 } from "./vault.mjs";

async function atomicJson(index, name, value) {
  const pending = path.join(index, "." + name + "-" + randomUUID());
  try {
    await writeSynced(pending, jsonLine(value));
    await rename(pending, path.join(index, name));
  } finally {
    await rm(pending, { force: true });
  }
}

export async function pruneGenerations(index, current, keep, graceMs, now = Date.now()) {
  if (await readFile(path.join(index, "CURRENT"), "utf8") !== current + "\n") {
    throw Error("CURRENT changed outside the producer lease");
  }
  const directory = path.join(index, "generations");
  const filename = "RETIREMENTS.json";
  const previous = await readFile(path.join(index, filename), "utf8")
    .then(JSON.parse).catch(error => { if (error.code === "ENOENT") return {}; throw error; });
  const retired = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^g-[a-f0-9-]{36}$/u.test(entry.name) || entry.name === current) continue;
    const stat = await lstat(path.join(directory, entry.name));
    const recorded = previous[entry.name];
    retired.push({ id: entry.name, at: Number.isSafeInteger(recorded) && recorded <= now && recorded >= 0
      ? recorded : now, built: stat.mtimeMs });
  }
  retired.sort((a, b) => b.at - a.at || b.built - a.built || a.id.localeCompare(b.id));
  for (const [position, entry] of retired.entries()) {
    if (position >= keep && now - entry.at >= graceMs) {
      await rm(path.join(directory, entry.id), { recursive: true, force: true });
    }
  }
  const remaining = Object.fromEntries(retired.filter((entry, position) =>
    position < keep || now - entry.at < graceMs).map(entry => [entry.id, entry.at]));
  if (!isDeepStrictEqual(previous, remaining)) await atomicJson(index, filename, remaining);
}

async function changedNotes(vault, manifest, snapshot, observations, signal) {
  const baseline = manifest?.inventoryStamps;
  if (!baseline) return null;
  let count = 0;
  for (const [name, stamp] of snapshot.files) {
    signal.throwIfAborted();
    if (baseline[name] === stamp) continue;
    const previousHash = manifest.inventoryHashes?.[name] ?? manifest.sources[name]?.sha256;
    if (!previousHash) {
      count++;
      continue;
    }
    let observation = observations.get(name);
    if (observation?.stamp !== stamp) {
      observation = { stamp, hash: sha256(await readSource(vault, name, stamp)) };
      observations.set(name, observation);
    }
    if (observation.hash !== previousHash) count++;
  }
  for (const name of Object.keys(baseline)) {
    if (!snapshot.files.has(name) && (manifest.inventoryHashes?.[name] ?? manifest.sources[name])) count++;
  }
  return count;
}

const errorCodes = {
  EMBEDDING_BUSY: "embedding_busy",
  EMBEDDING_FAILED: "embedding_failed",
  DELETION_GUARD: "deletion_guard",
  SOURCE_DRIFT: "source_drift",
  ENOENT: "source_drift",
};

export async function runIndexService({
  index, vault, active, scan, build, allowDeletions, pollMs, debounceMs, keep, graceMs, controller,
}) {
  const { signal } = controller;
  let lastInventory;
  let firstPendingAt;
  let lastDrift = 0;
  let changeAt = 0;
  let failures = 0;
  let retryAt = 0;
  let lastError = null;
  let blockedInventory;
  let running;
  let outcome;
  let lastPrune = -Infinity;
  const observations = new Map();
  const fail = (code) => {
    lastError = code;
    if (code === "source_drift") {
      failures = 0;
      lastDrift = performance.now();
      retryAt = 0;
      return;
    }
    failures++;
    retryAt = performance.now() + Math.min(Math.max(pollMs, 1000) * 2 ** Math.min(failures - 1, 10), 300_000);
  };
  const report = (pendingChanges, observedAt, stopped = false) => atomicJson(index, "SERVICE.json", {
    version: 1,
    generation: active?.manifest.generation ?? null,
    observedAt,
    validUntil: observedAt + (stopped ? 0 : Math.max(1000, 3 * pollMs)),
    pendingChanges,
    lastError,
    retryAt: retryAt > performance.now() ? Date.now() + Math.ceil(retryAt - performance.now()) : null,
  });

  try {
    while (!signal.aborted) {
      if (outcome) {
        if (outcome.publication) {
          active = outcome.publication;
          failures = 0;
          retryAt = 0;
          lastError = null;
          blockedInventory = undefined;
          observations.clear();
          lastPrune = -Infinity;
          firstPendingAt = undefined;
        } else {
          const code = errorCodes[outcome.error?.code] ?? "build_failed";
          fail(code);
          if (code === "deletion_guard") blockedInventory = outcome.inventory;
        }
        outcome = undefined;
        running = undefined;
      }
      if (!running && active && performance.now() - lastPrune >= Math.max(1000, Math.min(60_000, graceMs))) {
        await pruneGenerations(index, active.manifest.generation, keep, graceMs);
        lastPrune = performance.now();
      }
      let snapshot;
      let pendingChanges = null;
      try {
        snapshot = await scan(active);
        for (const name of observations.keys()) {
          if (!snapshot.files.has(name)) observations.delete(name);
        }
        pendingChanges = await changedNotes(vault, active?.manifest, snapshot, observations, signal);
      } catch (error) {
        if (signal.aborted) break;
        snapshot = undefined;
        fail(error.code === "SOURCE_DRIFT" || error.code === "ENOENT" ? "source_drift" : "scan_failed");
      }
      const observedAt = Date.now();
      const inventory = snapshot?.files;
      const needsBuild = inventory && (pendingChanges !== 0 || active?.manifest.vaultBinding !== snapshot.binding);
      if (needsBuild) firstPendingAt ??= performance.now();
      else if (inventory) firstPendingAt = undefined;
      if (inventory && !isDeepStrictEqual(inventory, lastInventory)) {
        changeAt = performance.now();
        lastInventory = inventory;
        if (blockedInventory && !isDeepStrictEqual(inventory, blockedInventory)) {
          blockedInventory = undefined;
          retryAt = 0;
        }
      }
      if (!running && pendingChanges === 0 && active?.manifest.vaultBinding === snapshot?.binding) {
        failures = 0;
        retryAt = 0;
        lastError = null;
      }
      await report(pendingChanges, observedAt);
      if (!running && needsBuild && !signal.aborted) {
        const authorized = blockedInventory && await allowDeletions(active);
        const debouncedAt = Math.min(changeAt + debounceMs, firstPendingAt + Math.max(pollMs, 2 * debounceMs));
        if ((!blockedInventory || authorized) &&
            performance.now() >= Math.max(authorized ? 0 : retryAt, lastDrift + debounceMs, debouncedAt)) {
          running = build(signal).then(publication => { outcome = { publication }; },
            error => { outcome = { error, inventory }; });
        }
      }
      await delay(pollMs, undefined, { signal }).catch(error => {
        if (error.name !== "AbortError") throw error;
      });
    }
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    if (running) await running;
    if (signal.aborted) {
      active = outcome?.publication ?? active;
      await report(null, Date.now(), true);
    }
  }
}
