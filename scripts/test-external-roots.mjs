import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ExternalRootError,
  ExternalRootsService,
} from "../dist/services/externalRootsService.js";
import { registerExternalRootsTools } from "../dist/mcp-server/tools/externalRootsTools/index.js";

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-roots-"),
);
const rootPath = path.join(sandbox, "root");
const outsidePath = path.join(sandbox, "outside");

async function expectCode(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ExternalRootError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

try {
  await mkdir(path.join(rootPath, "docs"), { recursive: true });
  await mkdir(path.join(rootPath, "blocking.txt"), { recursive: true });
  await mkdir(path.join(rootPath, "secret"), { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await writeFile(path.join(rootPath, "hello.txt"), "Bonjour ÉLYSIA", "utf8");
  await writeFile(path.join(rootPath, "empty.txt"), "", "utf8");
  const longSourceName = `${"a".repeat(230)}.txt`;
  await writeFile(path.join(rootPath, longSourceName), "long name", "utf8");
  await writeFile(path.join(rootPath, "LICENSE"), "private license", "utf8");
  await writeFile(
    path.join(rootPath, "docs", "note.md"),
    "# Note\nContenu",
    "utf8",
  );
  await writeFile(
    path.join(rootPath, "secret", "hidden.txt"),
    "secret",
    "utf8",
  );
  await writeFile(path.join(outsidePath, "outside.txt"), "outside", "utf8");

  let linkCreated = false;
  try {
    await symlink(outsidePath, path.join(rootPath, "escape-link"), "junction");
    linkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
  }

  const service = ExternalRootsService.fromConfig({
    version: 1,
    roots: [
      {
        id: "pilot.docs",
        path: rootPath,
        capabilities: ["visible", "readable", "handoff"],
        include: ["**/*.txt", "**/*.md"],
        exclude: ["secret/**"],
        limits: {
          maxDepth: 3,
          maxFileBytes: 1024,
          maxListEntries: 20,
          maxTextChars: 100,
        },
      },
    ],
  });

  const roots = await service.listRoots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, "pilot.docs");
  assert.equal(roots[0].available, true);
  assert.equal(JSON.stringify(roots).includes(rootPath), false);

  const listing = await service.list("pilot.docs", "", 2);
  assert.equal(listing.truncated, false);
  assert.ok(listing.entries.some((entry) => entry.path === "hello.txt"));
  assert.ok(listing.entries.some((entry) => entry.path === "docs/note.md"));
  assert.equal(
    listing.entries.some((entry) => entry.path.includes("hidden.txt")),
    false,
  );
  if (linkCreated) {
    assert.ok(
      listing.entries.some(
        (entry) => entry.path === "escape-link" && entry.type === "link",
      ),
    );
  }

  const read = await service.readText("pilot.docs", "hello.txt");
  assert.equal(read.text, "Bonjour ÉLYSIA");
  assert.equal(
    read.sha256,
    createHash("sha256").update(Buffer.from("Bonjour ÉLYSIA")).digest("hex"),
  );
  assert.equal("localPath" in read, false);

  const metadata = await service.getStat("pilot.docs", "hello.txt", true);
  assert.equal(metadata.type, "file");
  assert.equal(metadata.sha256, read.sha256);
  assert.equal("localPath" in metadata, false);

  const handoff = await service.handoff("pilot.docs", "hello.txt", true);
  assert.equal(path.isAbsolute(handoff.localPath), true);
  assert.notEqual(handoff.localPath, path.join(rootPath, "hello.txt"));
  assert.equal(await readFile(handoff.localPath, "utf8"), "Bonjour ÉLYSIA");
  assert.equal(handoff.sha256, read.sha256);
  const longNameHandoff = await service.handoff(
    "pilot.docs",
    longSourceName,
    false,
  );
  assert.match(path.basename(longNameHandoff.localPath), /^[0-9a-f-]{36}\.txt$/);
  assert.equal(await readFile(longNameHandoff.localPath, "utf8"), "long name");

  for (let index = 0; index < 16; index += 1) {
    await service.handoff("pilot.docs", "hello.txt", false);
  }
  await assert.rejects(() => access(handoff.localPath));
  const retainedCopies = (
    await readdir(path.dirname(handoff.localPath))
  ).filter((name) => name !== ".owner.json");
  assert.equal(retainedCopies.length, 16);
  await service.pruneHandoffDirectory(
    path.dirname(handoff.localPath),
    0,
    false,
  );
  const retainedAfterSweep = (await readdir(path.dirname(handoff.localPath)))
    .filter((name) => name !== ".owner.json")
    .sort();
  assert.deepEqual(retainedAfterSweep, retainedCopies.sort());
  const emptyHandoff = await service.handoff("pilot.docs", "empty.txt", false);
  assert.equal((await readFile(emptyHandoff.localPath)).length, 0);
  const retainedAfterEmptyHandoff = (
    await readdir(path.dirname(emptyHandoff.localPath))
  ).filter((name) => name !== ".owner.json");
  assert.equal(retainedAfterEmptyHandoff.length, 16);

  const abandonedHandoffDirectory = await mkdtemp(
    path.join(os.tmpdir(), "optimike-external-handoff-"),
  );
  const abandonedOwner = path.join(abandonedHandoffDirectory, ".owner.json");
  await writeFile(abandonedOwner, JSON.stringify({ pid: process.pid }), "utf8");
  const staleHeartbeat = new Date(Date.now() - 21 * 60 * 1000);
  await utimes(abandonedOwner, staleHeartbeat, staleHeartbeat);
  await writeFile(
    path.join(abandonedHandoffDirectory, "sensitive.txt"),
    "stale",
    "utf8",
  );
  const scavengingService = ExternalRootsService.fromConfig({
    version: 1,
    roots: [
      {
        id: "scavenger",
        path: rootPath,
        capabilities: ["visible", "readable", "handoff"],
        include: ["**/*.txt"],
        limits: { maxFileBytes: 1024 },
      },
    ],
  });
  await scavengingService.listRoots();
  await assert.rejects(() => access(abandonedHandoffDirectory));

  const handlers = new Map();
  const annotations = new Map();
  const fakeServer = {
    tool(name, _description, _schema, toolAnnotations, handler) {
      annotations.set(name, toolAnnotations);
      handlers.set(name, handler);
    },
  };
  await registerExternalRootsTools(fakeServer, service, false);
  assert.equal(handlers.size, 6);
  assert.ok(
    [...annotations.values()].every(
      (value) => value.readOnlyHint === true && value.destructiveHint === false,
    ),
  );
  const deniedHttpHandoff = await handlers.get("external_handoff")({
    rootId: "pilot.docs",
    relativePath: "hello.txt",
    includeHash: true,
  });
  assert.equal(deniedHttpHandoff.isError, true);
  assert.equal(
    JSON.parse(deniedHttpHandoff.content[0].text).error,
    "capability_denied",
  );

  await expectCode(
    () => service.readText("pilot.docs", "../outside/outside.txt"),
    "path_invalid",
  );
  await expectCode(
    () => service.readText("pilot.docs", path.join(rootPath, "hello.txt")),
    "path_invalid",
  );
  await expectCode(
    () => service.readText("pilot.docs", "secret/hidden.txt"),
    "path_not_allowed",
  );
  await expectCode(
    () => service.getStat("pilot.docs", "LICENSE", true),
    "path_not_allowed",
  );
  await expectCode(
    () => service.handoff("pilot.docs", "LICENSE", true),
    "path_not_allowed",
  );
  await expectCode(
    () => service.readText("pilot.docs", "blocking.txt"),
    "not_a_file",
  );
  if (linkCreated) {
    await expectCode(
      () => service.readText("pilot.docs", "escape-link/outside.txt"),
      "path_link_unsupported",
    );
  }

  const originalResolvePath = service.resolvePath.bind(service);
  let resolveCount = 0;
  service.resolvePath = async (...args) => {
    resolveCount += 1;
    if (resolveCount === 2) {
      return path.join(outsidePath, "outside.txt");
    }
    return originalResolvePath(...args);
  };
  try {
    await expectCode(
      () => service.readText("pilot.docs", "hello.txt"),
      "non_verifiable",
    );
  } finally {
    service.resolvePath = originalResolvePath;
  }

  const limitedService = ExternalRootsService.fromConfig({
    version: 1,
    roots: [
      {
        id: "limited",
        path: rootPath,
        capabilities: ["visible"],
        include: ["**"],
        limits: { maxFileBytes: 4 },
      },
    ],
  });
  await expectCode(
    () => limitedService.readText("limited", "hello.txt"),
    "capability_denied",
  );
  await expectCode(
    () => limitedService.handoff("limited", "hello.txt"),
    "capability_denied",
  );

  const sizeLimitedService = ExternalRootsService.fromConfig({
    version: 1,
    roots: [
      {
        id: "size-limited",
        path: rootPath,
        capabilities: ["visible", "readable"],
        include: ["**"],
        limits: { maxFileBytes: 4 },
      },
    ],
  });
  await expectCode(
    () => sizeLimitedService.readText("size-limited", "hello.txt"),
    "too_large",
  );

  assert.throws(
    () =>
      ExternalRootsService.fromConfig({
        version: 1,
        roots: [
          { id: "duplicate", path: rootPath, capabilities: ["visible"] },
          { id: "duplicate", path: rootPath, capabilities: ["visible"] },
        ],
      }),
    (error) =>
      error instanceof ExternalRootError &&
      error.code === "configuration_invalid",
  );
  assert.throws(
    () =>
      ExternalRootsService.fromConfig({
        version: 1,
        roots: [
          {
            id: "unsafe-handoff",
            path: rootPath,
            capabilities: ["visible", "handoff"],
          },
        ],
      }),
    (error) =>
      error instanceof ExternalRootError &&
      error.code === "configuration_invalid",
  );
  assert.throws(
    () =>
      ExternalRootsService.fromConfig({
        version: 1,
        roots: [
          {
            id: "typo",
            path: rootPath,
            capabilities: ["visible"],
            maxFileBytes: 100,
          },
        ],
      }),
    (error) =>
      error instanceof ExternalRootError &&
      error.code === "configuration_invalid",
  );

  const redactionHandlers = new Map();
  await registerExternalRootsTools(
    {
      tool(name, _description, _schema, _annotations, handler) {
        redactionHandlers.set(name, handler);
      },
    },
    {
      async listRoots() {
        throw new Error(`native failure at ${rootPath}`);
      },
    },
    false,
  );
  const redacted = await redactionHandlers.get("external_roots_list")();
  const redactedPayload = JSON.parse(redacted.content[0].text);
  assert.equal(redacted.isError, true);
  assert.equal(redactedPayload.error, "non_verifiable");
  assert.equal(
    redactedPayload.message,
    "The external path could not be verified.",
  );
  assert.equal(JSON.stringify(redacted).includes(rootPath), false);

  console.log(
    `PASS: external roots confinement, strict allowlists, handle identity, redaction, limits, bounded handoff copies, stale-directory scavenging and explicit local handoff${linkCreated ? ", including junction rejection" : ""}`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
