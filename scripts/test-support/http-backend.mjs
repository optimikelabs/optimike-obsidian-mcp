import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { isolatedStateEnv } from "./isolated-state.mjs";

const host = "127.0.0.1";
const diagnosticLimit = 8192;

async function unusedPort() {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function startHttpTestBackend(env, {
  cwd,
  inheritedEnv = process.env,
  onStdout,
  onStderr,
} = {}) {
  const port = await unusedPort();
  const baseUrl = `http://${host}:${port}`;
  const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd,
    env: {
      ...inheritedEnv,
      ...env,
      ...isolatedStateEnv(),
      NODE_ENV: "test",
      MCP_TRANSPORT_TYPE: "http",
      MCP_HTTP_HOST: host,
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_PORT_RETRIES: "0",
      MCP_LOG_LEVEL: env.MCP_LOG_LEVEL ?? "info",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-diagnosticLimit);
    onStdout?.(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-diagnosticLimit);
    onStderr?.(chunk);
  });

  let phase = "spawning the child process";
  child.once("spawn", () => {
    phase = "loading the server entry point";
  });
  const listening = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      reject(new Error(`HTTP MCP exited before listening (code ${code}, signal ${signal}).`));
    });
    child.on("message", (message) => {
      if (message?.httpStartup === "initializing") {
        phase = "initializing services and binding the HTTP listener";
      }
      if (message?.httpStartup === "listening") resolve();
    });
  });
  // The child may fail before the caller awaits readiness.
  void listening.catch(() => {});

  return {
    child,
    async ready() {
      const deadline = AbortSignal.timeout(30_000);
      const timedOut = new Promise((_, reject) => {
        deadline.addEventListener("abort", () => reject(deadline.reason), {
          once: true,
        });
      });
      try {
        await Promise.race([listening, timedOut]);
        phase = "checking /healthz after the child confirmed it is listening";
        const response = await fetch(`${baseUrl}/healthz`, { signal: deadline });
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`/healthz returned HTTP ${response.status}.`);
        phase = "ready";
        return baseUrl;
      } catch (error) {
        if (deadline.aborted) {
          throw new Error(`Timed out waiting for HTTP MCP startup while ${phase}.`, { cause: error });
        }
        throw error;
      }
    },
    diagnostics() {
      let log = "";
      try {
        log = readFileSync(path.join(env.LOGS_DIR, "combined.log"), "utf8").slice(-diagnosticLimit);
      } catch {
        // The child may not have reached logger initialization yet.
      }
      return `HTTP MCP phase: ${phase}\nstdout:\n${stdout}\nstderr:\n${stderr}\ncombined.log (tail):\n${log}`;
    },
    async stop() {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await closed;
    },
  };
}
