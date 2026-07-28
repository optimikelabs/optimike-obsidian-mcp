import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const { BackendVaultAdapter } = await import(
  "../dist/services/externalReferences/backendVaultAdapter.js"
);

const before = "# Pilot\n\nOld reference\n";
const after = "# Pilot\n\nNew reference\n";
const expectedHash = createHash("sha256")
  .update(before, "utf8")
  .digest("hex");
const resultingHash = createHash("sha256")
  .update(after, "utf8")
  .digest("hex");

function result(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

{
  const calls = [];
  const adapter = new BackendVaultAdapter(async (name, args) => {
    calls.push({ name, args });
    return result({
      success: true,
      replacementsApplied: 1,
      stats: { hash: resultingHash },
    });
  });

  await adapter.conditionalReplace(
    "Efforts/Projets/Pilot.md",
    before,
    after,
    expectedHash,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "obsidian_search_replace");
  assert.equal(calls[0].args.expectedHash, expectedHash);
  assert.equal("expectedSha256" in calls[0].args, false);
}

for (const payload of [
  {
    success: true,
    replacementsApplied: 0,
    stats: { hash: resultingHash },
  },
  {
    success: true,
    replacementsApplied: 1,
    stats: { hash: expectedHash },
  },
]) {
  const adapter = new BackendVaultAdapter(async () => result(payload));
  await assert.rejects(
    () =>
      adapter.conditionalReplace(
        "Efforts/Projets/Pilot.md",
        before,
        after,
        expectedHash,
      ),
    /conditional vault repair did not succeed/u,
  );
}

console.log(
  "Backend vault adapter CAS forwarding and repair proof tests passed.",
);
