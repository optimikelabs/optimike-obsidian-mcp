import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TOOL_PROFILE_IDS,
  compileToolProfileNames,
} from "../dist/mcp-server/toolProfiles.js";
import { getToolSurfaceEntry } from "../dist/mcp-server/toolSurfaceRegistry.js";

const corpus = JSON.parse(
  fs.readFileSync(new URL("../evals/tool-routing-corpus.json", import.meta.url), "utf8"),
);

assert.ok(Array.isArray(corpus));
assert.ok(corpus.length >= 25 && corpus.length <= 40, "initial routing corpus must remain 25-40 cases");

const ids = new Set();
for (const testCase of corpus) {
  assert.equal(typeof testCase.id, "string");
  assert.ok(testCase.id.length > 0);
  assert.ok(!ids.has(testCase.id), `duplicate eval id: ${testCase.id}`);
  ids.add(testCase.id);

  assert.equal(typeof testCase.prompt, "string");
  assert.ok(testCase.prompt.length >= 12, `${testCase.id} prompt is too weak`);
  assert.ok(
    TOOL_PROFILE_IDS.includes(testCase.recommendedProfile),
    `${testCase.id} uses unknown profile ${testCase.recommendedProfile}`,
  );
  assert.ok(Array.isArray(testCase.acceptableFirstTools));
  assert.ok(Array.isArray(testCase.forbiddenTools ?? []));

  if (testCase.expectNoTool) {
    assert.equal(
      testCase.acceptableFirstTools.length,
      0,
      `${testCase.id} no-tool case must not define acceptable first tools`,
    );
  } else {
    assert.ok(
      testCase.acceptableFirstTools.length > 0,
      `${testCase.id} needs at least one acceptable first tool`,
    );
  }

  for (const name of [
    ...testCase.acceptableFirstTools,
    ...(testCase.forbiddenTools ?? []),
  ]) {
    assert.ok(getToolSurfaceEntry(name), `${testCase.id} references unknown tool ${name}`);
  }

  const liveProfile = new Set(
    compileToolProfileNames({
      profile: testCase.recommendedProfile,
      registrationMode: "live",
      availableStaticRequirements: ["vault-cache"],
    }),
  );
  for (const name of testCase.acceptableFirstTools) {
    assert.ok(
      liveProfile.has(name),
      `${testCase.id} expects ${name}, but recommended live profile ${testCase.recommendedProfile} hides it`,
    );
  }
}

for (const testCase of corpus) {
  if (testCase.recommendedProfile === "full") continue;
  assert.ok(
    !(testCase.acceptableFirstTools ?? []).includes("smart_search") &&
      !(testCase.acceptableFirstTools ?? []).includes("smart-search"),
    `${testCase.id} teaches a deprecated semantic alias`,
  );
}

const semantic = corpus.find((item) => item.id === "semantic-canonical");
assert.deepEqual(semantic?.acceptableFirstTools, ["smart_semantic_search"]);
assert.ok(semantic?.forbiddenTools.includes("smart_search"));
assert.ok(semantic?.forbiddenTools.includes("smart-search"));

console.log(`PASS: ${corpus.length} routing eval cases are profile-valid and canonical`);
