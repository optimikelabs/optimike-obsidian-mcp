import assert from "node:assert/strict";
import {
  TOOL_PROFILE_IDS,
  TOOL_PROFILES,
  compileToolProfile,
  compileToolProfileNames,
  parseToolProfileId,
} from "../dist/mcp-server/toolProfiles.js";
import { TOOL_REGISTRATION_MODES } from "../dist/mcp-server/toolSurfaceRegistry.js";

const WITH_CACHE = ["vault-cache"];

const EXPECTED_COUNTS = {
  live: { standard: 19, authoring: 31, tasks: 31, full: 72 },
  "hybrid-live": { standard: 19, authoring: 31, tasks: 31, full: 72 },
  "hybrid-degraded": { standard: 6, authoring: 6, tasks: 31, full: 45 },
  "headless-readonly": { standard: 9, authoring: 9, tasks: 31, full: 48 },
  "headless-guarded": { standard: 12, authoring: 12, tasks: 31, full: 51 },
  "headless-filesystem": { standard: 12, authoring: 17, tasks: 31, full: 60 },
};

assert.deepEqual(TOOL_PROFILE_IDS, ["standard", "authoring", "tasks", "full"]);
for (const profile of TOOL_PROFILE_IDS) {
  assert.equal(TOOL_PROFILES[profile].id, profile);
  assert.ok(TOOL_PROFILES[profile].groups.length > 0);
}

assert.equal(parseToolProfileId("standard"), "standard");
assert.throws(() => parseToolProfileId("standrad"), /Unknown MCP tool profile/);
assert.throws(() => parseToolProfileId(""), /Unknown MCP tool profile/);

for (const registrationMode of TOOL_REGISTRATION_MODES) {
  for (const profile of TOOL_PROFILE_IDS) {
    const names = compileToolProfileNames({
      profile,
      registrationMode,
      availableStaticRequirements: WITH_CACHE,
    });
    assert.equal(
      names.length,
      EXPECTED_COUNTS[registrationMode][profile],
      `${profile}/${registrationMode} count drifted`,
    );
    assert.deepEqual(
      names,
      [...names].sort((left, right) => left.localeCompare(right)),
      `${profile}/${registrationMode} must be deterministically sorted`,
    );
    assert.equal(
      new Set(names).size,
      names.length,
      `${profile}/${registrationMode} must not contain duplicates`,
    );
  }
}

for (const profile of ["standard", "authoring", "tasks"]) {
  for (const registrationMode of TOOL_REGISTRATION_MODES) {
    const names = compileToolProfileNames({
      profile,
      registrationMode,
      availableStaticRequirements: WITH_CACHE,
    });
    assert.ok(
      names.includes("smart_semantic_search"),
      `${profile}/${registrationMode} lost canonical semantic search`,
    );
    assert.ok(
      !names.includes("smart_search") && !names.includes("smart-search"),
      `${profile}/${registrationMode} must hide semantic-search compatibility aliases`,
    );
    for (const hidden of [
      "obsidian_runtime_maintenance",
      "obsidian_admin_filesystem",
      "external_runtime_status",
      "external_read",
      "external_move_plan",
    ]) {
      assert.ok(
        !names.includes(hidden),
        `${profile}/${registrationMode} unexpectedly exposes ${hidden}`,
      );
    }
  }
}

for (const registrationMode of TOOL_REGISTRATION_MODES) {
  const full = compileToolProfileNames({
    profile: "full",
    registrationMode,
    availableStaticRequirements: WITH_CACHE,
  });
  assert.ok(full.includes("smart_semantic_search"));
  assert.ok(full.includes("smart_search"));
  assert.ok(full.includes("smart-search"));
}

for (const profile of TOOL_PROFILE_IDS) {
  for (const registrationMode of TOOL_REGISTRATION_MODES) {
    const entries = compileToolProfile({
      profile,
      registrationMode,
      availableStaticRequirements: WITH_CACHE,
    });
    const lifecycleFamilies = new Map();
    for (const entry of entries) {
      if (!entry.lifecycleRole) continue;
      const roles = lifecycleFamilies.get(entry.family) ?? [];
      roles.push(entry.lifecycleRole);
      lifecycleFamilies.set(entry.family, roles);
    }
    for (const [family, roles] of lifecycleFamilies) {
      assert.deepEqual(
        roles.sort(),
        ["apply", "plan", "recover", "status"],
        `${profile}/${registrationMode} exposes a partial ${family} lifecycle`,
      );
    }
  }
}

for (const profile of ["standard", "authoring"]) {
  const live = compileToolProfileNames({
    profile,
    registrationMode: "live",
    availableStaticRequirements: WITH_CACHE,
  });
  assert.ok(live.includes("obsidian_frontmatter_patch_plan"));
  assert.ok(
    !live.includes("obsidian_manage_frontmatter"),
    `${profile}/live must prefer the governed frontmatter family`,
  );

  const guarded = compileToolProfileNames({
    profile,
    registrationMode: "headless-guarded",
    availableStaticRequirements: WITH_CACHE,
  });
  assert.ok(
    guarded.includes("obsidian_manage_frontmatter"),
    `${profile}/headless-guarded must keep the direct frontmatter fallback`,
  );
  assert.ok(!guarded.includes("obsidian_frontmatter_patch_plan"));
}

const tasksLive = compileToolProfileNames({
  profile: "tasks",
  registrationMode: "live",
  availableStaticRequirements: WITH_CACHE,
});
for (const required of [
  "operon_list_tasks",
  "operon_query_tasks",
  "operon_create_task",
  "operon_update_task",
  "operon_transition_task",
  "operon_list_pending_recoveries",
  "operon_recover_mutation",
  "list_all_tasks",
  "query_tasks",
]) {
  assert.ok(tasksLive.includes(required), `tasks profile lost ${required}`);
}

const standardWithoutCache = compileToolProfileNames({
  profile: "standard",
  registrationMode: "live",
  availableStaticRequirements: [],
});
assert.ok(!standardWithoutCache.includes("obsidian_global_search"));
assert.equal(standardWithoutCache.length, 18);

const readonlyWithoutCache = compileToolProfileNames({
  profile: "standard",
  registrationMode: "headless-readonly",
  availableStaticRequirements: [],
});
for (const absent of [
  "obsidian_global_search",
  "bases_list",
  "bases_get_schema",
  "bases_query",
]) {
  assert.ok(!readonlyWithoutCache.includes(absent));
}
assert.equal(readonlyWithoutCache.length, 5);

console.log("PASS: standard, authoring, tasks and full profiles are deterministic, portable and SemVer-safe for semantic aliases");
