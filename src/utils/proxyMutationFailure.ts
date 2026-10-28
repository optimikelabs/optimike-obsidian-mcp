/** A transport failure cannot prove whether a dispatched governed write occurred. */
export function proxyMutationFailure(name: string, args: unknown) {
  const prefixes: Record<string, string> = {
    obsidian_text_patch_apply: "obsidian-text-patch:v1:",
    obsidian_frontmatter_patch_apply: "obsidian-frontmatter-patch:v1:",
    obsidian_note_replace_apply: "obsidian-note-replace:v1:",
    obsidian_note_create_apply: "obsidian-note-create:v1:",
    bases_create_apply: "obsidian-base-create:v1:",
    obsidian_canvas_create_apply: "obsidian-canvas-create:v1:",
    obsidian_note_move_apply: "obsidian-note-move:v1:",
    obsidian_note_delete_apply: "obsidian-note-delete:v1:",
    obsidian_canvas_patch_apply: "obsidian-canvas-patch:v1:",
    bases_formula_patch_apply: "obsidian-base-formula-patch:v1:",
    bases_config_patch_apply: "obsidian-base-config-patch:v1:",
    bases_rows_patch_apply: "obsidian-base-rows-patch:v1:",
  };
  const prefix = prefixes[name];
  if (!prefix || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(args, "planRef");
  const planRef = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof planRef !== "string" || !planRef.startsWith(prefix) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(planRef.slice(prefix.length))) return undefined;
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({
      ok: false,
      error: { code: "OUTCOME_UNKNOWN", message: "The mutation may have applied. Call the matching status tool before any further action.",
        details: { mutationMayHaveApplied: true, planRef, nextAction: name.replace(/_apply$/u, "_status") } },
    }) }],
  };
}
