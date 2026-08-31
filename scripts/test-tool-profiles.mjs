import assert from "node:assert/strict";
import {
  TOOL_PROFILE_IDS,
  TOOL_PROFILES,
  compileToolProfile,
  compileToolProfileNames,
  parseToolProfileId,
  selectAvailableToolProfileNames,
} from "../dist/mcp-server/toolProfiles.js";
import { TOOL_REGISTRATION_MODES } from "../dist/mcp-server/toolSurfaceRegistry.js";

const WITH_CACHE = ["vault-cache"];

const EXPECTED_COUNTS = {
  live: { standard: 22, authoring: 33, tasks: 34, full: 77 },
  "hybrid-live": { standard: 22, authoring: 33, tasks: 34, full: 77 },
  "hybrid-degraded": { standard: 6, authoring: 6, tasks: 14, full: 45 },
  "headless-readonly": { standard: 9, authoring: 9, tasks: 14, full: 48 },
  "headless-guarded": { standard: 12, authoring: 12, tasks: 14, full: 51 },
  "headless-filesystem": { standard: 12, authoring: 16, tasks: 14, full: 60 },
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
      `${profile}/${registrationMode} must not contain removed semantic-search aliases`,
    );
    assert.ok(
      !names.includes("bases_upsert_config"),
      `${profile}/${registrationMode} must keep whole-Base config replacement full-only`,
    );
    if (registrationMode === "live" || registrationMode === "hybrid-live") {
      assert.ok(
        names.includes("obsidian_list_pending_operations"),
        `${profile}/${registrationMode} lost the readonly operation cockpit`,
      );
    } else {
      assert.ok(
        !names.includes("obsidian_list_pending_operations"),
        `${profile}/${registrationMode} exposed a cockpit without live journals`,
      );
    }
    for (const hidden of [
      "obsidian_runtime_maintenance",
      "obsidian_admin_filesystem",
      "external_runtime_status",
      "external_read",
      "external_move_plan",
      "external_move_apply",
      "external_move_rollback",
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
  assert.ok(!full.includes("smart_search"));
  assert.ok(!full.includes("smart-search"));
  if (
    registrationMode === "live" ||
    registrationMode === "hybrid-live" ||
    registrationMode === "headless-filesystem"
  ) {
    assert.ok(
      full.includes("bases_upsert_config"),
      `${registrationMode}/full must preserve whole-Base compatibility`,
    );
  }
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

  for (const governed of [
    "obsidian_text_patch_plan",
    "obsidian_text_patch_apply",
    "obsidian_text_patch_status",
    "obsidian_text_patch_recover",
  ]) {
    assert.ok(live.includes(governed), `${profile}/live lost ${governed}`);
  }
  assert.ok(!live.includes("obsidian_update_note"));
  assert.ok(!live.includes("obsidian_search_replace"));
}

const fullLiveNames = compileToolProfileNames({
  profile: "full",
  registrationMode: "live",
  availableStaticRequirements: WITH_CACHE,
});
assert.ok(fullLiveNames.includes("obsidian_update_note"));
assert.ok(fullLiveNames.includes("obsidian_search_replace"));
const partialTextPatch = fullLiveNames.filter(
  (name) => name !== "obsidian_text_patch_recover",
);
const standardDuringPartialRegistration = selectAvailableToolProfileNames({
  profile: "standard",
  availableNames: partialTextPatch,
});
assert.ok(standardDuringPartialRegistration.includes("obsidian_update_note"));
assert.ok(
  standardDuringPartialRegistration.includes("obsidian_search_replace"),
);
assert.ok(
  !standardDuringPartialRegistration.some((name) =>
    name.startsWith("obsidian_text_patch_"),
  ),
);

const authoringLive = compileToolProfileNames({
  profile: "authoring",
  registrationMode: "live",
  availableStaticRequirements: WITH_CACHE,
});
assert.ok(authoringLive.includes("bases_create"));
assert.ok(authoringLive.includes("bases_upsert_rows"));
assert.ok(authoringLive.includes("bases_formula_patch_plan"));
assert.ok(!authoringLive.includes("bases_upsert_config"));

const tasksLive = compileToolProfileNames({
  profile: "tasks",
  registrationMode: "live",
  availableStaticRequirements: WITH_CACHE,
});
for (const required of [
  "operon_list_tasks",
  "operon_query_tasks",
  "operon_create_task",
  "operon_create_periodic_task",
  "operon_update_periodic_scheduling",
  "operon_update_task",
  "operon_transition_task",
  "operon_list_pending_recoveries",
  "operon_recover_mutation",
  "list_all_tasks",
  "query_tasks",
]) {
  assert.ok(
    tasksLive.includes(required),
    `live tasks profile lost ${required}`,
  );
}

const tasksSnapshot = compileToolProfileNames({
  profile: "tasks",
  registrationMode: "headless-readonly",
  availableStaticRequirements: WITH_CACHE,
});
assert.equal(tasksSnapshot.length, 14);
for (const required of [
  "operon_status",
  "operon_get_configuration",
  "operon_list_tasks",
  "operon_get_task",
  "operon_query_tasks",
  "operon_validate",
  "list_all_tasks",
  "query_tasks",
]) {
  assert.ok(
    tasksSnapshot.includes(required),
    `snapshot tasks profile lost ${required}`,
  );
}
for (const liveOnly of [
  "operon_query_saved_filter",
  "operon_get_diagnostics",
  "operon_find_tasks",
  "operon_resolve_task",
  "operon_get_relationships",
  "operon_build_context",
  "operon_get_timer_state",
  "operon_create_task",
  "operon_create_periodic_task",
  "operon_update_periodic_scheduling",
  "operon_update_task",
  "operon_transition_task",
  "operon_list_pending_recoveries",
  "operon_recover_mutation",
]) {
  assert.ok(
    !tasksSnapshot.includes(liveOnly),
    `snapshot tasks profile must hide live-only tool ${liveOnly}`,
  );
}

const selectedSnapshotTasks = selectAvailableToolProfileNames({
  profile: "tasks",
  availableNames: compileToolProfileNames({
    profile: "full",
    registrationMode: "headless-readonly",
    availableStaticRequirements: WITH_CACHE,
  }),
});
assert.deepEqual(selectedSnapshotTasks, tasksSnapshot);

const selectedLiveTasks = selectAvailableToolProfileNames({
  profile: "tasks",
  availableNames: compileToolProfileNames({
    profile: "full",
    registrationMode: "live",
    availableStaticRequirements: WITH_CACHE,
  }),
});
assert.deepEqual(selectedLiveTasks, tasksLive);

const standardWithoutCache = compileToolProfileNames({
  profile: "standard",
  registrationMode: "live",
  availableStaticRequirements: [],
});
assert.ok(!standardWithoutCache.includes("obsidian_global_search"));
assert.equal(standardWithoutCache.length, 21);

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

console.log(
  "PASS: profiles are deterministic, removed semantic aliases stay absent, whole-Base config stays full-only, governed families are atomic, and headless tasks expose only snapshot-safe Operon reads",
);
