import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { jsonLine, writeSynced } from "./generation.mjs";

const leaseMs = 30_000;

async function linuxProcess(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], start: fields[19] };
}

async function windowsProcessStart(pid) {
  const { stdout } = await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Id " + pid + " -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')",
  ], { windowsHide: true, timeout: 5000 });
  const started = stdout.trim();
  if (!Number.isFinite(Date.parse(started))) throw Error("Cannot verify the producer PID start time");
  return started;
}

async function ownerGone(owner, bootId) {
  if (bootId && /^[a-f0-9-]{36}$/u.test(owner.bootId) && bootId !== owner.bootId) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error.code === "ESRCH";
  }
  try {
    if (process.platform === "linux") {
      const current = await linuxProcess(owner.pid);
      return current.state === "Z" || (/^\d+$/u.test(owner.processStart) && owner.processStart !== current.start);
    }
    if (process.platform === "win32") {
      const started = await windowsProcessStart(owner.pid);
      if (typeof owner.processStart === "string" && Number.isFinite(Date.parse(owner.processStart))) {
        return started !== owner.processStart;
      }
      // If even the replacement process started before the prior lease
      // acquisition (for example after a clock correction), refuse takeover.
      return Date.parse(started) > Date.parse(owner.startedAt) + 2000;
    }
  } catch {
    // A live, unverifiable PID is not evidence of an abandoned lease.
  }
  return false;
}

async function readOwner(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.size > 512) return { stat };
  let owner;
  try {
    const value = JSON.parse(await readFile(filename, "utf8"));
    if (Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff &&
        typeof value.startedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.startedAt)) {
      owner = value;
    }
  } catch {
    // Incomplete legacy receipts still fence reuse.
  }
  return { stat, owner };
}

export async function withProducerLease(index, controller, work) {
  const filename = path.join(index, ".producer.lock");
  const guardFile = path.join(index, ".producer-lock.sqlite");
  const guardStat = await lstat(guardFile).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (guardStat && !guardStat.isFile()) throw Error("Producer lock database must be a regular file");
  // Keep the kernel-backed lock as long as the producer is alive. It
  // serializes stale receipt replacement and releases on a forced exit.
  const guard = new DatabaseSync(guardFile);
  const busy = async () => {
    const owner = await readOwner(filename).then(value => value.owner).catch(() => undefined);
    return Error("Index already has a producer lock" +
      (owner ? ` (PID ${owner.pid}, started ${owner.startedAt})` : ""));
  };
  let acquired = false;
  try {
    try {
      guard.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if ((error.errcode & 0xff) === 5) throw await busy();
      throw error;
    }
    const bootId = process.platform === "linux"
      ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim() : "";
    const processStart = process.platform === "linux"
      ? (await linuxProcess(process.pid).catch(() => undefined))?.start
      : process.platform === "win32" ? await windowsProcessStart(process.pid).catch(() => undefined) : undefined;
    const body = jsonLine({ pid: process.pid, startedAt: new Date().toISOString(), bootId, processStart });
    const pending = filename + "." + randomUUID();
    try {
      await writeSynced(pending, body);
      try {
        // Link a complete receipt exclusively so legacy producers still
        // cannot acquire the filename between the database lock and receipt.
        await link(pending, filename);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const { stat, owner } = await readOwner(filename);
        if (!owner || Date.now() - stat.mtimeMs < leaseMs || !await ownerGone(owner, bootId)) throw await busy();
        await rename(pending, filename);
      }
      acquired = true;
    } finally {
      await rm(pending, { force: true });
    }
    let update;
    let heartbeatError;
    const timer = setInterval(() => {
      if (!update) {
        const now = new Date();
        update = utimes(filename, now, now).catch(error => {
          heartbeatError = error;
          controller.abort(error);
        }).finally(() => { update = undefined; });
      }
    }, leaseMs / 3);
    timer.unref();
    try {
      const result = await work();
      if (heartbeatError) throw heartbeatError;
      return result;
    } finally {
      clearInterval(timer);
      await update;
    }
  } finally {
    try {
      if (acquired) await rm(filename);
    } finally {
      guard.close();
    }
  }
}
