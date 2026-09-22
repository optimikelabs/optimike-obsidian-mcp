import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExternalRootsService } from "../dist/services/externalRootsService.js";

const root = await mkdtemp(path.join(os.tmpdir(), "optimike-skills-source-"));
const outside = await mkdtemp(path.join(os.tmpdir(), "optimike-skills-outside-"));
const content = "---\nname: sample\ndescription: Sample fixture\n---\nRead only.\n";
let checks = 0;
const source = (overrides = {}) => ExternalRootsService.fromConfig({ version: 1, roots: [{
  id: "test.skills", path: root, capabilities: ["visible", "readable"],
  limits: { maxListEntries: 2048 }, ...overrides,
}] });
const reject = async (work, label) => { await assert.rejects(work, undefined, label); checks++; };
try {
  await mkdir(path.join(root, "sample", "references"), { recursive: true });
  await mkdir(path.join(root, "sample", "assets"));
  await writeFile(path.join(root, "sample", "SKILL.md"), content);
  await writeFile(path.join(root, "sample", "references", "éclairage #1.md"), "\ufeffReference\r\n");
  const binary = Buffer.from([0, 255, 128, 42]);
  await writeFile(path.join(root, "sample", "assets", "sample.bin"), binary);
  const svc = source();
  const snapshot = await svc.readSkillDirectorySnapshot("test.skills", "sample");
  assert.deepEqual(snapshot.files.map(f => f.path), ["SKILL.md", "assets/sample.bin", "references/éclairage #1.md"]);
  assert.equal(snapshot.path, "sample");
  assert.deepEqual(snapshot.files[1].bytes, binary);
  for (const f of snapshot.files) assert.deepEqual(f.bytes, await readFile(path.join(root, "sample", f.path)));
  checks++;
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "../escape"), "traversal");
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", root), "absolute");
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", ""), "whole-root publication");
  await reject(() => svc.readSkillDirectorySnapshot("unknown", "sample"), "unknown root");
  await reject(() => source({ capabilities: ["visible"] }).readSkillDirectorySnapshot("test.skills", "sample"), "no read permission");
  await reject(() => source({ capabilities: ["readable"] }).readSkillDirectorySnapshot("test.skills", "sample"), "no visibility");
  await reject(() => source({ include: ["**/*.md"] }).readSkillDirectorySnapshot("test.skills", "sample"), "incomplete include must not truncate manifest");
  await reject(() => source({ exclude: ["**/sample.bin"] }).readSkillDirectorySnapshot("test.skills", "sample"), "excluded file must reject whole skill");
  await reject(() => source({ limits: { maxDepth: 0 } }).readSkillDirectorySnapshot("test.skills", "sample"), "depth must not truncate manifest");
  await reject(() => source({ limits: { maxListEntries: 2 } }).readSkillDirectorySnapshot("test.skills", "sample"), "entry limit");
  await reject(() => source({ limits: { maxFileBytes: 4 } }).readSkillDirectorySnapshot("test.skills", "sample"), "file limit");

  for (const name of [".env", ".npmrc", "private.key", "credentials.json", "secrets.yaml"]) {
    const p = path.join(root, "sample", name);
    await writeFile(p, "SECRET_SENTINEL_NOT_PUBLISHED");
    await reject(() => svc.readSkillDirectorySnapshot("test.skills", "sample"), `sensitive member ${name}`);
    await rm(p);
  }
  // Rich skills remain complete; code is passive content, never executed.
  const attributes = path.join(root, "sample", ".gitattributes");
  const python = path.join(root, "sample", "support.py");
  const json = path.join(root, "sample", "support.json");
  await writeFile(attributes, "*.md text eol=lf\r\n");
  await writeFile(python, `raise RuntimeError("MUST_NEVER_EXECUTE")\n`);
  await writeFile(json, '{"passive":true}\n');
  const richSource = source({ include: ["**", "sample/.gitattributes"] });
  const rich = await richSource.readSkillDirectorySnapshot("test.skills", "sample");
  assert.deepEqual(rich.files.find(f => f.path === ".gitattributes").bytes, await readFile(attributes));
  assert.ok(rich.files.some(f => f.path === "support.py"));
  assert.ok(rich.files.some(f => f.path === "support.json")); checks++;
  await reject(() => source({ include: ["**/*.md"] }).readSkillDirectorySnapshot("test.skills", "sample"), "root include still governs rich skills");
  await reject(() => source({ exclude: ["**/.gitattributes"] }).readSkillDirectorySnapshot("test.skills", "sample"), "root exclude still governs attributes");
  await reject(() => source({ capabilities: ["visible"] }).readSkillDirectorySnapshot("test.skills", "sample"), "attributes do not grant readable capability");
  await rm(attributes);
  await mkdir(attributes);
  await reject(() => richSource.readSkillDirectorySnapshot("test.skills", "sample"), "attributes directory is not allowed");
  await rm(attributes, { recursive: true });
  for (const name of [".git", ".gitattributes.bak", ".GITATTRIBUTES", ".gitconfig", "node_modules"]) {
    const member = path.join(root, "sample", name);
    // node_modules remains subject to the default root exclusion.
    await mkdir(member);
    await reject(() => svc.readSkillDirectorySnapshot("test.skills", "sample"), `forbidden directory ${name}`);
    await rm(member, { recursive: true });
  }
  await rm(python); await rm(json);

  const linked = path.join(root, "sample", "linked");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "sample"), "outgoing directory symlink/junction");
  await rm(linked, { recursive: true });
  await symlink(path.join(root, "sample", "references"), linked, process.platform === "win32" ? "junction" : "dir");
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "sample"), "internal directory link is also forbidden");
  await rm(linked, { recursive: true });
  await writeFile(path.join(outside, "private.txt"), "OUTSIDE_SENTINEL");
  await link(path.join(outside, "private.txt"), path.join(root, "sample", "hard-link.txt"));
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "sample"), "hard-linked content");
  await rm(path.join(root, "sample", "hard-link.txt"));

  // Inject real filesystem drift between reads, without a product test hook.
  const original = svc.readOpenedFile.bind(svc);
  let injected = false;
  svc.readOpenedFile = async (...args) => {
    const bytes = await original(...args);
    if (!injected) { injected = true; await writeFile(path.join(root, "sample", "new.md"), "concurrent add"); }
    return bytes;
  };
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "sample"), "added file changes complete manifest");
  svc.readOpenedFile = original;
  await rm(path.join(root, "sample", "new.md"));
  let reads = 0;
  svc.readOpenedFile = async (...args) => {
    const bytes = await original(...args);
    if (++reads === 2) await writeFile(path.join(root, "sample", "SKILL.md"), content + "changed after its own read\n");
    return bytes;
  };
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "sample"), "earlier file drift is detected by final scan");
  svc.readOpenedFile = original;
  await writeFile(path.join(root, "sample", "SKILL.md"), content);
  assert.equal((await svc.readSkillDirectorySnapshot("test.skills", "sample")).files.length, 3); checks++;

  await mkdir(path.join(root, "too-many"));
  for (let i = 0; i < 513; i++) await writeFile(path.join(root, "too-many", `${i}.txt`), "");
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "too-many"), "512-file bound");
  await mkdir(path.join(root, "too-large"));
  await writeFile(path.join(root, "too-large", "a.bin"), Buffer.alloc(9 * 1024 * 1024));
  await writeFile(path.join(root, "too-large", "b.bin"), Buffer.alloc(8 * 1024 * 1024));
  await reject(() => svc.readSkillDirectorySnapshot("test.skills", "too-large"), "16 MiB aggregate bound");
  console.log(`PASS: ${checks} complete skill-source snapshot and negative security checks`);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
