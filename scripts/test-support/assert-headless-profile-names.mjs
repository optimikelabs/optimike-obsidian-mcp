import assert from "node:assert/strict";
import { compileToolProfileNames } from "../../dist/mcp-server/toolProfiles.js";

// Compare the real transport catalog with the canonical profile projection.
// Exact names retain missing/extra/duplicate detection without stale counts.
export function assertHeadlessProfileNames(names, profile) {
  const expected = compileToolProfileNames({
    profile,
    registrationMode: "headless-readonly",
    availableStaticRequirements: ["vault-cache"],
  });
  assert.deepEqual(
    [...names].sort((left, right) => left.localeCompare(right)),
    expected,
    `${profile} must expose its exact headless catalog`,
  );
  for (const name of ["operon_set_pinned", "operon_update_tasks"]) {
    assert.equal(
      names.includes(name),
      profile === "full" || profile === "operational",
      `${profile}: ${name} exposure`,
    );
  }
}
