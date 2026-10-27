import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Contract of scripts/supervise-backend.ps1, driven against a fake backend:
// it restarts a missing backend, leaves a healthy one alone, never touches a
// process that holds the port, stops after its restart budget, removes empty
// process logs, and carries no machine-specific path or secret.

const scriptPath = path.resolve("scripts", "supervise-backend.ps1");
const shell = ["pwsh", "powershell"].find(
  (candidate) =>
    spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], {
      stdio: "ignore",
    }).status === 0,
);
if (!shell) {
  assert.ok(!process.env.CI, "PowerShell is required in CI");
  console.log("SKIP backend supervisor: PowerShell is not available.");
  process.exit(0);
}

const source = readFileSync(scriptPath, "utf8");
assert.doesNotMatch(
  source,
  /[A-Za-z]:\\|\/home\/|\/Users\/|micka|OPTIMIKE_|OBSIDIAN_API_KEY|BEARER|SECRET/u,
  "the versioned script carries no machine-specific path or secret",
);
assert.doesNotMatch(source, /Register-ScheduledTask|schtasks|New-Service/iu);

const work = mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
const fakeBackend = path.join(work, "fake-backend.mjs");
writeFileSync(
  fakeBackend,
  `import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
const [port, markerDir] = process.argv.slice(2);
writeFileSync(path.join(markerDir, "started-" + process.pid), "");
http.createServer((request, response) => {
  response.statusCode = request.url === "/healthz" ? 200 : 404;
  response.end("ok");
}).listen(Number(port), "127.0.0.1");
`,
);

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const spawned = [];
function supervise(port, options = {}) {
  const state = path.join(work, `state-${port}`);
  const markers = path.join(work, `markers-${port}`);
  mkdirSync(markers, { recursive: true });
  const args = [
    "-NoProfile",
    "-File",
    scriptPath,
    "-WorkingDirectory",
    work,
    "-NodePath",
    process.execPath,
    "-LaunchArguments",
    `"${fakeBackend}" ${port} "${markers}"`,
    "-Port",
    String(port),
    "-StateDirectory",
    state,
    "-Once",
    "-FailureThreshold",
    String(options.threshold ?? 1),
    "-StartupGraceSeconds",
    "20",
    "-HealthTimeoutSeconds",
    "1",
    ...(options.extra ?? []),
  ];
  const result = spawnSync(shell, args, { encoding: "utf8", timeout: 60_000 });
  return {
    status: result.status,
    stderr: result.stderr,
    state,
    markers,
    starts: () =>
      readdirSync(markers).filter((name) => name.startsWith("started-")),
    log: () =>
      existsSync(path.join(state, "supervisor.log"))
        ? readFileSync(path.join(state, "supervisor.log"), "utf8")
        : "",
  };
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return response.status === 200;
  } catch {
    return false;
  }
}

function stopStartedBackends(run) {
  for (const marker of run.starts()) {
    const pid = Number(marker.slice("started-".length));
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

try {
  // 1. A backend that is not running is started and answers /healthz.
  {
    const port = await freePort();
    const run = supervise(port);
    assert.equal(run.status, 0, run.stderr + run.log());
    assert.equal(run.starts().length, 1, "one start");
    assert.ok(await healthy(port), "backend answers after the start");
    assert.match(run.log(), /starting backend/u);
    assert.match(run.log(), /backend healthy after start/u);
    // 2. A healthy backend is left alone (no second start).
    const again = supervise(port);
    assert.equal(again.status, 0);
    assert.equal(again.starts().length, 1, "healthy backend is not restarted");
    assert.doesNotMatch(
      again.log().split("backend healthy after start")[1] ?? "",
      /starting backend/u,
    );
    stopStartedBackends(run);
    console.log(
      "PASS supervisor: restarts a missing backend, leaves a healthy one alone.",
    );
  }

  // 3. A single failed probe does not restart (threshold 2); the second does.
  {
    const port = await freePort();
    const first = supervise(port, { threshold: 2 });
    assert.equal(first.status, 0);
    assert.equal(
      first.starts().length,
      0,
      "one failure is below the threshold",
    );
    const second = supervise(port, { threshold: 2 });
    assert.equal(second.status, 0, second.stderr + second.log());
    assert.equal(
      second.starts().length,
      1,
      "second consecutive failure starts it",
    );
    stopStartedBackends(second);
    console.log("PASS supervisor: restart needs consecutive failures.");
  }

  // 4. A process that holds the port but fails /healthz is never touched.
  {
    const port = await freePort();
    const intruder = http.createServer((request, response) => {
      response.statusCode = 500;
      response.end("down");
    });
    await new Promise((resolve) => intruder.listen(port, "127.0.0.1", resolve));
    const run = supervise(port);
    assert.equal(run.status, 2, run.stderr + run.log());
    assert.equal(run.starts().length, 0);
    assert.match(run.log(), /not touching it/u);
    assert.ok(intruder.listening, "the unhealthy process is still running");
    await new Promise((resolve) => intruder.close(resolve));
    console.log(
      "PASS supervisor: never kills or shadows a process that owns the port.",
    );
  }

  // 5. The restart budget stops a crash loop.
  {
    const port = await freePort();
    const state = path.join(work, `state-${port}`);
    mkdirSync(state, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      path.join(state, "state.json"),
      JSON.stringify({
        failures: 0,
        restarts: [now - 60, now - 120, now - 180],
        lastStart: now - 60,
        down: true,
      }),
    );
    const run = supervise(port, { extra: ["-MaxRestartsPerHour", "3"] });
    assert.equal(run.status, 3, run.stderr + run.log());
    assert.equal(run.starts().length, 0);
    assert.match(run.log(), /restart budget exhausted/u);
    console.log("PASS supervisor: stops restarting after the hourly budget.");
  }

  // 6. Empty logs of old launches are removed; non-empty ones are kept.
  {
    const port = await freePort();
    const state = path.join(work, `state-${port}`);
    mkdirSync(state, { recursive: true });
    const empty = path.join(state, "backend-20200101-000000.stdout.log");
    const kept = path.join(state, "backend-20200101-000000.stderr.log");
    writeFileSync(empty, "");
    writeFileSync(kept, "crash trace");
    const old = new Date(Date.now() - 3600_000);
    for (const file of [empty, kept]) {
      const { utimesSync } = await import("node:fs");
      utimesSync(file, old, old);
    }
    const run = supervise(port, { extra: ["-DryRun"] });
    assert.equal(run.status, 0, run.stderr + run.log());
    assert.ok(!existsSync(empty), "empty process log removed");
    assert.ok(existsSync(kept), "non-empty process log kept");
    assert.equal(run.starts().length, 0, "dry run starts nothing");
    console.log(
      "PASS supervisor: no empty process logs left behind; dry run starts nothing.",
    );
  }
  console.log("Backend supervisor contract passed.");
} finally {
  for (const child of spawned) child.kill();
  rmSync(work, { recursive: true, force: true });
}
