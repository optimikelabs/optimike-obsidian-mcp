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
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(pending, path.join(index, name));
        break;
      } catch (error) {
        if (attempt >= 3 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        await delay(10 * 2 ** attempt);
      }
    }
  } finally {
    await rm(pending, { force: true });
  }
}

const generationName = /^g-[a-f0-9-]{36}$/u;
const retirementBackupName = /^RETIREMENTS\.json\.corrupt-(?:(\d+)-)?[a-f0-9-]{36}$/u;
const retirementBackupLimit = 3;
const removalBlocked = error => ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(error.code);

async function trimRetirementBackups(index, keep) {
  const backups = [];
  for (const entry of await readdir(index, { withFileTypes: true })) {
    const name = retirementBackupName.exec(entry.name);
    if (!entry.isFile() || !name) continue;
    const filename = path.join(index, entry.name);
    const at = name[1] ? Number(name[1]) : (await lstat(filename)).mtimeMs;
    backups.push({ filename, at });
  }
  backups.sort((a, b) => b.at - a.at || a.filename.localeCompare(b.filename));
  let blocked = false;
  for (const { filename } of backups.slice(keep)) {
    try {
      await rm(filename, { force: true });
    } catch (error) {
      if (!removalBlocked(error)) throw error;
      blocked = true;
    }
  }
  return blocked;
}

export function createVectorCache(limit = 64 * 1024 * 1024) {
  const entries = new Map();
  let bytes = 0;
  const size = vector => 128 + (vector?.length ?? 0);
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const vector = entries.get(key);
      entries.delete(key);
      entries.set(key, vector);
      return vector;
    },
    set(key, vector) {
      if (entries.has(key)) bytes -= size(entries.get(key));
      entries.delete(key);
      entries.set(key, vector);
      bytes += size(vector);
      while (bytes > limit) {
        const oldest = entries.keys().next().value;
        bytes -= size(entries.get(oldest));
        entries.delete(oldest);
      }
    },
  };
}

export async function pruneGenerations(index, current, keep, graceMs, maxGenerations, now = Date.now()) {
  const pointer = await readFile(path.join(index, "CURRENT"), "utf8")
    .catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (pointer !== (current ? current + "\n" : null)) {
    throw Error("CURRENT changed outside the producer lease");
  }
  const directory = path.join(index, "generations");
  const filename = "RETIREMENTS.json";
  const statePath = path.join(index, filename);
  const recoveryBlocked = { room: false, rebuilt: false, warning: "retirements_recovery_blocked" };
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (removalBlocked(error)) return recoveryBlocked;
    if (error.code !== "ENOENT") throw error;
  }
  let previous = {};
  let corrupt = false;
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          Object.entries(parsed).some(([id, at]) => !generationName.test(id) || !Number.isSafeInteger(at) || at < 0)) {
        throw new Error("Invalid retirement metadata");
      }
      previous = parsed;
    } catch {
      corrupt = true;
    }
  }
  let backupBlocked;
  try {
    backupBlocked = await trimRetirementBackups(index, retirementBackupLimit - Number(corrupt));
    if (corrupt) {
      if (backupBlocked) return recoveryBlocked;
      await rename(statePath, statePath + ".corrupt-" + now + "-" + randomUUID());
    }
  } catch {
    return recoveryBlocked;
  }
  const retired = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !generationName.test(entry.name) || entry.name === current) continue;
    const stat = await lstat(path.join(directory, entry.name));
    const recorded = previous[entry.name];
    retired.push({ id: entry.name, at: Number.isSafeInteger(recorded) && recorded <= now && recorded >= 0
      ? recorded : now, built: stat.mtimeMs });
  }
  retired.sort((a, b) => b.at - a.at || b.built - a.built || a.id.localeCompare(b.id));
  const remaining = {};
  const retiredLimit = maxGenerations - Number(Boolean(current));
  let generationBlocked = false;
  for (const [position, entry] of retired.entries()) {
    if (position >= retiredLimit || (position >= keep && now - entry.at >= graceMs)) {
      try {
        await rm(path.join(directory, entry.id), { recursive: true, force: true });
        continue;
      } catch (error) {
        if (!removalBlocked(error)) throw error;
        generationBlocked = true;
      }
    }
    remaining[entry.id] = entry.at;
  }
  if (corrupt || !isDeepStrictEqual(previous, remaining)) {
    try {
      await atomicJson(index, filename, remaining);
    } catch (error) {
      if (!removalBlocked(error)) throw error;
      return recoveryBlocked;
    }
  }
  const warning = generationBlocked ? "generation_prune_blocked" :
    backupBlocked ? recoveryBlocked.warning : null;
  return { room: Object.keys(remaining).length < retiredLimit, rebuilt: corrupt, warning };
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
      try {
        observation = { stamp, hash: sha256(await readSource(vault, name, stamp)) };
      } catch (error) {
        if (!["SOURCE_DRIFT", "ENOENT"].includes(error.code)) throw error;
        count++;
        continue;
      }
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
  index, vault, active, scan, build, allowDeletions, pollMs, debounceMs, keep, graceMs, maxGenerations, controller,
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
  let room = !active;
  let retirementsRebuilt = false;
  let pruneWarning = null;
  let reportedFailure = false;
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
  async function report(pendingChanges, observedAt, stopped = false) {
    try {
      await atomicJson(index, "SERVICE.json", {
        version: 1,
        generation: active?.manifest.generation ?? null,
        observedAt,
        validUntil: observedAt + (stopped ? 0 : Math.max(1000, 3 * pollMs)),
        pendingChanges,
        lastError,
        maintenanceWarning: pruneWarning ?? (retirementsRebuilt ? "retirements_rebuilt" : null),
        retryAt: retryAt > performance.now() ? Date.now() + Math.ceil(retryAt - performance.now()) : null,
      });
      reportedFailure = false;
    } catch {
      if (!reportedFailure) console.error("Semantic index service: status publication failed; will retry");
      reportedFailure = true;
    }
  }

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
      const pruneInterval = room && !pruneWarning ? Math.max(1000, Math.min(60_000, graceMs)) : Math.min(pollMs, graceMs);
      if (!running && performance.now() - lastPrune >= pruneInterval) {
        const result = await pruneGenerations(index, active?.manifest.generation ?? null, keep, graceMs, maxGenerations);
        room = result.room;
        retirementsRebuilt ||= result.rebuilt;
        pruneWarning = result.warning;
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
      if (!running && room && needsBuild && !signal.aborted) {
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
