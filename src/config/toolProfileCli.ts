import { parseToolProfileId } from "../mcp-server/toolProfiles.js";

export function applyToolProfileCliOverride(
  argv: readonly string[] = process.argv.slice(2),
): void {
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tool-profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(
          "--tool-profile requires one of: standard, authoring, tasks, full.",
        );
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--tool-profile=")) {
      values.push(arg.slice("--tool-profile=".length));
    }
  }

  if (values.length === 0) return;
  if (values.length > 1) {
    throw new Error("--tool-profile may be provided only once.");
  }

  process.env.MCP_TOOL_PROFILE = parseToolProfileId(values[0]);
}

applyToolProfileCliOverride();
