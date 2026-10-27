import assert from "node:assert/strict";
import { proxyMutationFailure } from "../dist/utils/proxyMutationFailure.js";
for (const [name, prefix] of [["obsidian_text_patch_apply", "obsidian-text-patch:v1:"], ["obsidian_frontmatter_patch_apply", "obsidian-frontmatter-patch:v1:"],
  // Every governed apply gets the same honest receipt when the proxy loses the response
  // (for example the SDK's 60 s request timeout on a long verified apply).
  ["obsidian_note_replace_apply", "obsidian-note-replace:v1:"], ["obsidian_note_create_apply", "obsidian-note-create:v1:"],
  ["obsidian_note_move_apply", "obsidian-note-move:v1:"], ["obsidian_note_delete_apply", "obsidian-note-delete:v1:"],
  ["obsidian_canvas_patch_apply", "obsidian-canvas-patch:v1:"], ["bases_formula_patch_apply", "obsidian-base-formula-patch:v1:"],
  ["bases_rows_patch_apply", "obsidian-base-rows-patch:v1:"]]) {
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
