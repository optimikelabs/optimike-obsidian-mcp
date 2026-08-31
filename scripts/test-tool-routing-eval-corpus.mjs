import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TOOL_PROFILE_IDS,
  compileToolProfileNames,
} from "../dist/mcp-server/toolProfiles.js";
import { getToolSurfaceEntry } from "../dist/mcp-server/toolSurfaceRegistry.js";

const corpusEnvelope = JSON.parse(
  fs.readFileSync(
    new URL("../evals/tool-routing-corpus.json", import.meta.url),
    "utf8",
  ),
);
const corpus = corpusEnvelope.cases;

assert.ok(Array.isArray(corpus));
assert.ok(
  corpusEnvelope.schemaVersion === "tool-routing-corpus/v1",
  "routing corpus must use the versioned v1 envelope",
);
assert.equal(corpusEnvelope.corpusId, "optimike-tool-routing-v1");
assert.equal(corpus.length, 31, "P6 must preserve all 31 discriminating cases");

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
  assert.equal(typeof testCase.expectedToolFamily, "string");
  assert.ok(testCase.expectedToolFamily.length > 0);
  assert.ok(
    ["none", "required", "before_mutation"].includes(
      testCase.clarificationExpectation,
    ),
    `${testCase.id} has an invalid clarification expectation`,
  );
  assert.ok(Array.isArray(testCase.acceptableFirstTools));
  assert.ok(Array.isArray(testCase.forbiddenTools ?? []));
  assert.ok(
    Number.isInteger(
      testCase.minimumToolCalls ?? (testCase.expectNoTool ? 0 : 1),
    ) && (testCase.minimumToolCalls ?? (testCase.expectNoTool ? 0 : 1)) >= 0,
    `${testCase.id} minimumToolCalls must be a non-negative integer`,
  );

  if (testCase.expectNoTool) {
    assert.equal(
      testCase.acceptableFirstTools.length,
      0,
      `${testCase.id} no-tool case must not define acceptable first tools`,
    );
    assert.equal(
      testCase.minimumToolCalls ?? 0,
      0,
      `${testCase.id} no-tool case cannot require tool calls`,
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
    assert.ok(
      getToolSurfaceEntry(name),
      `${testCase.id} references unknown tool ${name}`,
    );
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

  if (!testCase.expectNoTool) {
    const acceptableFirstToolFamilies =
      testCase.acceptableFirstToolFamilies ?? [testCase.expectedToolFamily];
    assert.ok(
      Array.isArray(acceptableFirstToolFamilies) &&
        acceptableFirstToolFamilies.length > 0,
      `${testCase.id} must define at least one acceptable first-tool family`,
    );
    assert.ok(
      testCase.acceptableFirstTools.every((name) =>
        acceptableFirstToolFamilies.includes(getToolSurfaceEntry(name)?.family),
      ),
      `${testCase.id} must classify every accepted first route`,
    );
  }

  if (testCase.expectNoTool) {
    assert.equal(testCase.expectedToolFamily, "none");
  }
}

for (const testCase of corpus) {
  if (testCase.recommendedProfile === "full") continue;
  assert.ok(!(testCase.acceptableFirstTools ?? []).includes("smart_search"));
  assert.ok(!(testCase.acceptableFirstTools ?? []).includes("smart-search"));
}

const semantic = corpus.find((item) => item.id === "semantic-canonical");
assert.deepEqual(semantic?.acceptableFirstTools, ["smart_semantic_search"]);

console.log(
  `PASS: ${corpus.length} routing eval cases are profile-valid and canonical`,
);
