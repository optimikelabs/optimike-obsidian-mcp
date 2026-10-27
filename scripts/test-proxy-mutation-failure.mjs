import assert from "node:assert/strict";
import { proxyMutationFailure } from "../dist/utils/proxyMutationFailure.js";
for (const [name, prefix] of [["obsidian_text_patch_apply", "obsidian-text-patch:v1:"], ["obsidian_frontmatter_patch_apply", "obsidian-frontmatter-patch:v1:"]]) {
  const planRef = prefix + "30414766-9f49-4a61-9842-ddf6fc7574e8";
  const result = proxyMutationFailure(name, { planRef, content: "PRIVATE_NOTE" });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.equal(payload.error.details.mutationMayHaveApplied, true);
  assert.equal(payload.error.details.planRef, planRef);
  assert.equal(payload.error.details.nextAction, name.replace(/_apply$/, "_status"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NOTE/);
  assert.equal(proxyMutationFailure(name, { planRef: planRef + "/PRIVATE" }), undefined);
}
assert.equal(proxyMutationFailure("obsidian_text_patch_plan", { planRef: "x" }), undefined);
console.log("PASS: proxy uncertainty receipts preserve only validated references.");
