import { open, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export type LocalBackendOptions = {
  serviceName: string;
  url: URL;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  healthcheckTimeoutMs?: number;
  pollIntervalMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkHealth(
  url: URL,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function acquireLock(
  lockPath: string,
  staleAfterMs: number,
): Promise<(() => Promise<void>) | null> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  try {
    const handle = await open(lockPath, "wx");
    return async () => {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: string }).code)
        : undefined;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const stats = await import("node:fs/promises").then(({ stat }) =>
      stat(lockPath),
    );
    if (Date.now() - stats.mtimeMs > staleAfterMs) {
      await rm(lockPath, { force: true }).catch(() => undefined);
      return acquireLock(lockPath, staleAfterMs);
    }
  } catch {
    return null;
  }

  return null;
}

async function waitForHealthy(
  url: URL,
  deadlineMs: number,
  healthcheckTimeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  while (Date.now() < deadlineMs) {
    const health = await checkHealth(url, healthcheckTimeoutMs);
    if (health.ok) return;
    await sleep(pollIntervalMs);
  }

  throw new Error(`Backend did not become healthy at ${url.toString()}.`);
}

export async function ensureLocalBackendRunning({
  serviceName,
  url,
  command,
  args,
  cwd,
  env,
  startupTimeoutMs = 15000,
  healthcheckTimeoutMs = 1000,
  pollIntervalMs = 400,
}: LocalBackendOptions): Promise<void> {
  const lockPath = path.join(
    os.tmpdir(),
    "optimike-mcp-runtime",
    `${serviceName}-${url.port || "default"}.lock`,
  );
  const deadlineMs = Date.now() + startupTimeoutMs;

  const initialHealth = await checkHealth(url, healthcheckTimeoutMs);
  if (initialHealth.ok) return;

  while (Date.now() < deadlineMs) {
    const releaseLock = await acquireLock(lockPath, startupTimeoutMs * 2);

    if (releaseLock) {
      try {
        const preSpawnHealth = await checkHealth(url, healthcheckTimeoutMs);
        if (!preSpawnHealth.ok) {
          const child = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
        }

        await waitForHealthy(
          url,
          deadlineMs,
          healthcheckTimeoutMs,
          pollIntervalMs,
        );
        return;
      } finally {
        await releaseLock();
      }
    }

    const health = await checkHealth(url, healthcheckTimeoutMs);
    if (health.ok) return;
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out while waiting for ${serviceName} backend at ${url.toString()}.`,
  );
}
