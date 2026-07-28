#!/usr/bin/env node

process.env.MCP_LOG_LEVEL ??= "debug";
process.env.MCP_TRANSPORT_TYPE = "http";

await import("../dist/index.js");
