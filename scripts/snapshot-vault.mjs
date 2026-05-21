#!/usr/bin/env node

import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const source =
  process.env.HEADLESS_SERVER_VAULT ??
  process.env.OBSIDIAN_VAULT ??
  process.argv[2];
const destinationRoot =
  process.env.HEADLESS_SNAPSHOT_DIR ?? path.resolve(".tmp", "vault-snapshots");

if (!source) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: "Set HEADLESS_SERVER_VAULT/OBSIDIAN_VAULT or pass a vault path.",
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.join(destinationRoot, `snapshot-${stamp}`);

await mkdir(destinationRoot, { recursive: true });
await cp(source, destination, {
  recursive: true,
  force: false,
  errorOnExist: true,
  filter: (filePath) => {
    const normalized = filePath.replace(/\\/g, "/");
    return (
      !normalized.includes("/.git/") && !normalized.includes("/node_modules/")
    );
  },
});
await writeFile(
  path.join(destination, "SNAPSHOT-METADATA.json"),
  `${JSON.stringify({ source, destination, createdAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({ ok: true, source, destination }, null, 2));
