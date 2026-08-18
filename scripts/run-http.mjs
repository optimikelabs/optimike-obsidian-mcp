#!/usr/bin/env node

process.env.MCP_TRANSPORT_TYPE = "http";
await import("../dist/index-v3.js");
