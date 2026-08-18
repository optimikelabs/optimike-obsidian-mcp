#!/usr/bin/env node

import { installHttpToolProfileBoundary } from "./mcp-server/toolSurface/httpBoundary.js";
import {
  configureDefaultToolSurfaceProfile,
  installToolSurfaceRuntime,
  resolveProfileFromCli,
} from "./mcp-server/toolSurface/runtime.js";

const resolved = resolveProfileFromCli(
  process.argv.slice(2),
  process.env.MCP_TOOL_PROFILE,
  "standard",
);
process.argv = [...process.argv.slice(0, 2), ...resolved.argv];
process.env.MCP_TOOL_PROFILE = resolved.profile;
configureDefaultToolSurfaceProfile(resolved.profile);
installToolSurfaceRuntime();
installHttpToolProfileBoundary();

await import("./index.js");
