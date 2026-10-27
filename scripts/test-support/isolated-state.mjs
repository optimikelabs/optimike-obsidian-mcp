// Side-effect import for tests and qualification scripts that start the real
// runtime. The durable journals default to a per-profile file under
// %LOCALAPPDATA% (or $XDG_STATE_HOME), one for every temporary vault or port a
// test uses, so unisolated runs leave thousands of orphan databases behind.
// Import this module FIRST: it points both variables at a private temporary
// directory that is removed on exit (set MCP_TEST_KEEP_STATE=1 to keep it).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const isolatedStateDirectory = mkdtempSync(
  path.join(os.tmpdir(), "optimike-mcp-test-state-"),
);
process.env.LOCALAPPDATA = isolatedStateDirectory;
process.env.XDG_STATE_HOME = isolatedStateDirectory;

/** For child processes started with an explicit `env` object. */
export const isolatedStateEnv = () => ({
  LOCALAPPDATA: isolatedStateDirectory,
  XDG_STATE_HOME: isolatedStateDirectory,
});

process.on("exit", () => {
  if (process.env.MCP_TEST_KEEP_STATE === "1") return;
  try {
    rmSync(isolatedStateDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // A child that still holds a database open on Windows: the OS temp cleanup will take it.
  }
});
