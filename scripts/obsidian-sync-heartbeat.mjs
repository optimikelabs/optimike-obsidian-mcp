import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { jsonLine, writeSynced } from "./semantic-index/generation.mjs";

async function main() {
  const { values } = parseArgs({ options: {
    vault: { type: "string" },
    heartbeat: { type: "string" },
    "ob-cli": { type: "string" },
    "timeout-seconds": { type: "string", default: "300" },
  } });
  if (![values.vault, values.heartbeat, values["ob-cli"]].every(value => value && path.isAbsolute(value))) {
    throw Error("Pass absolute paths with --vault, --heartbeat, and --ob-cli");
  }
  const timeout = Number(values["timeout-seconds"]);
  if (!/^\d+$/u.test(values["timeout-seconds"]) || timeout < 1 || timeout > 86_400) {
    throw Error("--timeout-seconds must be an integer from 1 to 86400");
  }
  const vault = await realpath(values.vault);
  const cli = await realpath(values["ob-cli"]);
  const directory = await realpath(path.dirname(values.heartbeat));
  const filename = path.join(directory, path.basename(values.heartbeat));
  const relative = path.relative(vault, filename);
  if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))) {
    throw Error("The heartbeat must be outside the vault");
  }

  let lastSuccessfulPull = null;
  try {
    const previous = JSON.parse(await readFile(filename, "utf8"));
    if (previous.version === 1) lastSuccessfulPull = previous.lastSuccessfulPull ?? null;
  } catch {
    // A missing or invalid prior receipt leaves freshness unknown.
  }
  async function publish(state, heartbeatAt) {
    const pending = path.join(directory, ".sync-heartbeat-" + randomUUID());
    try {
      await writeSynced(pending, jsonLine({ version: 1, heartbeatAt, state, lastSuccessfulPull }));
      await rename(pending, filename);
    } finally {
      await rm(pending, { force: true });
    }
  }
  const startedAt = new Date().toISOString();
  await publish("running", startedAt);
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let exitCode;
  try {
    const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(timeout * 1000)]);
    exitCode = await new Promise(resolve => {
      const child = spawn(process.execPath, [cli, "sync", "--path", vault], {
        stdio: "ignore", windowsHide: true, signal, killSignal: "SIGKILL",
      });
      let failed = false;
      child.on("error", () => { failed = true; });
      child.once("close", code => resolve(failed || signal.aborted ? null : code));
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  const completedAt = new Date().toISOString();
  if (exitCode === 0) lastSuccessfulPull = { startedAt, completedAt };
  await publish(exitCode === 0 ? "ok" : "error", completedAt);
  if (exitCode !== 0) throw Error("Obsidian Sync did not complete successfully");
}

main().catch(error => {
  console.error("Sync heartbeat:", error.code ?? error.message);
  process.exitCode = 1;
});
