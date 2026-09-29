import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimike-asset-policy-"));
const {
  inspectAssetPolicy,
  inspectObsidianAttachmentFolder,
} = await import("../dist/services/assets/assetPolicyDiscovery.js");

try {
  fs.mkdirSync(path.join(root, ".obsidian"));
  fs.mkdirSync(path.join(root, "X", "Images"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".obsidian", "app.json"),
    JSON.stringify({ attachmentFolderPath: "X/Images" }),
  );

  const matching = inspectAssetPolicy({
    vaultRoot: root,
    configuredFolder: "X/Images",
    quality: 75,
    enabled: true,
    externalRootsConfigured: true,
    chatgptFileIngressEnabled: false,
  });
  assert.equal(matching.destination.folder, "X/Images");
  assert.equal(matching.destination.exists, true);
  assert.equal(matching.destination.matchesObsidian, true);
  assert.equal(matching.destination.suggestedFolder, "X/Images");
  assert.deepEqual(matching.destination.obsidianAttachment, {
    kind: "fixed",
    folder: "X/Images",
    exists: true,
  });
  assert.equal(matching.conversion.quality, 75);
  assert.equal(matching.conversion.resize, false);
  assert.equal(matching.ingress.externalRoot, true);
  assert.equal(matching.ingress.chatgptFileParam, false);
  assert.equal(matching.noteInsertion, "separate_governed_operation");

  fs.writeFileSync(
    path.join(root, ".obsidian", "app.json"),
    JSON.stringify({ attachmentFolderPath: "Media" }),
  );
  fs.mkdirSync(path.join(root, "Media"));
  const different = inspectAssetPolicy({
    vaultRoot: root,
    configuredFolder: "X/Images",
    quality: 80,
    enabled: true,
    externalRootsConfigured: false,
    chatgptFileIngressEnabled: true,
  });
  assert.equal(different.destination.matchesObsidian, false);
  assert.equal(different.destination.suggestedFolder, "Media");
  assert.equal(different.ingress.externalRoot, false);
  assert.equal(different.ingress.chatgptFileParam, true);
  assert.equal(different.ingress.modelBase64Accepted, false);
  assert.equal(different.ingress.arbitraryUrlAccepted, false);

  fs.writeFileSync(
    path.join(root, ".obsidian", "app.json"),
    JSON.stringify({ attachmentFolderPath: "./assets" }),
  );
  assert.deepEqual(inspectObsidianAttachmentFolder(root), {
    kind: "note_relative",
  });

  fs.writeFileSync(
    path.join(root, ".obsidian", "app.json"),
    JSON.stringify({ attachmentFolderPath: "/" }),
  );
  assert.deepEqual(inspectObsidianAttachmentFolder(root), {
    kind: "vault_root",
  });

  fs.rmSync(path.join(root, ".obsidian", "app.json"));
  assert.deepEqual(inspectObsidianAttachmentFolder(root), {
    kind: "unavailable",
  });
  const absent = inspectAssetPolicy({
    vaultRoot: root,
    configuredFolder: undefined,
    quality: 75,
    enabled: false,
    externalRootsConfigured: false,
    chatgptFileIngressEnabled: false,
  });
  assert.equal(absent.destination.folder, null);
  assert.equal(absent.destination.exists, false);
  assert.equal(absent.destination.createsDirectory, false);

  console.log(
    "PASS: asset policy exposes configured destination, Obsidian attachment relationship, conversion and ingress without mutation",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
