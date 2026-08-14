#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(file, before, after) {
  const content = readFileSync(file, "utf8");
  const count = content.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: expected one patch anchor, found ${count}`);
  }
  writeFileSync(file, content.replace(before, after), "utf8");
}

replaceOnce(
  "src/services/operations/obsidianNoteReplaceJournal.ts",
  `export type ObsidianNoteReplacePlan = {
  operationId: string;
  idempotencyKey: string;
  requestDigest: string;`,
  `export type ObsidianNoteReplaceProjection = {
  contractVersion: 1;
  kind: string;
  publicIdempotencyKey: string;
  intentDigest: string;
  proof: Record<string, unknown>;
};

export type ObsidianNoteReplacePlan = {
  operationId: string;
  idempotencyKey: string;
  requestDigest: string;
  idempotencyIdentity?: string;
  projection?: ObsidianNoteReplaceProjection;`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceJournal.ts",
  `function sameRequestInput(
  existing: ObsidianNoteReplacePlan,
  input: Pick<ObsidianNoteReplacePlan, "path" | "afterSha256">,
): boolean {
  return (
    existing.path === input.path && existing.afterSha256 === input.afterSha256
  );
}`,
  `function sameRequestInput(
  existing: ObsidianNoteReplacePlan,
  input: Pick<
    ObsidianNoteReplacePlan,
    "path" | "afterSha256" | "idempotencyIdentity"
  >,
): boolean {
  if (
    existing.idempotencyIdentity !== undefined ||
    input.idempotencyIdentity !== undefined
  ) {
    return (
      existing.path === input.path &&
      existing.idempotencyIdentity !== undefined &&
      existing.idempotencyIdentity === input.idempotencyIdentity
    );
  }
  return (
    existing.path === input.path && existing.afterSha256 === input.afterSha256
  );
}`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `  ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
} from "./obsidianNoteReplaceJournal.js";`,
  `  ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
  type ObsidianNoteReplaceProjection,
} from "./obsidianNoteReplaceJournal.js";`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `export type ObsidianNoteReplacePlanInput = {
  path: string;
  nextContent: string;
  idempotencyKey: string;
};`,
  `export type ObsidianNoteReplacePlanInput = {
  path: string;
  nextContent: string;
  idempotencyKey: string;
  expectedBeforeSha256?: string;
  expectedBindingFingerprint?: string;
  idempotencyIdentity?: string;
  projection?: ObsidianNoteReplaceProjection;
};`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `    requestDigest: plan.requestDigest,
  });`,
  `    requestDigest: plan.requestDigest,
    idempotencyIdentity: plan.idempotencyIdentity ?? null,
    projectionDigest: plan.projection ? operationDigest(plan.projection) : null,
  });`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `  if (Buffer.byteLength(input.nextContent, "utf8") > 5 * 1024 * 1024) {
    throw new Error("nextContent exceeds the bridge limit.");
  }
}`,
  `  if (Buffer.byteLength(input.nextContent, "utf8") > 5 * 1024 * 1024) {
    throw new Error("nextContent exceeds the bridge limit.");
  }
  for (const [name, value] of [
    ["expectedBeforeSha256", input.expectedBeforeSha256],
    ["expectedBindingFingerprint", input.expectedBindingFingerprint],
    ["idempotencyIdentity", input.idempotencyIdentity],
  ] as const) {
    if (value !== undefined && !SHA256.test(value)) {
      throw new Error(\`${name} must be a lowercase SHA-256 digest.\`);
    }
  }
  if (input.projection) {
    if (
      input.projection.contractVersion !== 1 ||
      !input.projection.kind ||
      input.projection.kind.length > 128 ||
      !input.projection.publicIdempotencyKey ||
      input.projection.publicIdempotencyKey.length > 256 ||
      !SHA256.test(input.projection.intentDigest) ||
      input.projection.intentDigest !== input.idempotencyIdentity
    ) {
      throw new Error("projection metadata is malformed or not bound to the idempotency identity.");
    }
    if (Buffer.byteLength(JSON.stringify(input.projection), "utf8") > 128 * 1024) {
      throw new Error("projection metadata exceeds the private journal limit.");
    }
  }
}`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `    if (existing) {
      if (
        existing.path !== input.path ||
        existing.afterSha256 !== afterSha256
      ) {
        throw new Error(
          "The idempotency key is already bound to a different note replacement.",
        );
      }
      return receipt(existing);
    }`,
  `    if (existing) {
      const identityBound =
        existing.idempotencyIdentity !== undefined ||
        input.idempotencyIdentity !== undefined;
      const matches = identityBound
        ? existing.path === input.path &&
          existing.idempotencyIdentity !== undefined &&
          existing.idempotencyIdentity === input.idempotencyIdentity
        : existing.path === input.path &&
          existing.afterSha256 === afterSha256;
      if (!matches) {
        throw new Error(
          "The idempotency key is already bound to a different note replacement.",
        );
      }
      return receipt(existing);
    }`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `    if (
      read.bindingFingerprint !== status.backend.bindingFingerprint ||
      read.path !== input.path
    ) {
      throw new Error(
        "Atomic-write backend identity or target changed during planning.",
      );
    }
    const requestDigest = operationDigest({`,
  `    if (
      read.bindingFingerprint !== status.backend.bindingFingerprint ||
      read.path !== input.path
    ) {
      throw new Error(
        "Atomic-write backend identity or target changed during planning.",
      );
    }
    if (
      input.expectedBeforeSha256 !== undefined &&
      read.sha256 !== input.expectedBeforeSha256
    ) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "The note changed after the domain projection was compiled.",
      );
    }
    if (
      input.expectedBindingFingerprint !== undefined &&
      read.bindingFingerprint !== input.expectedBindingFingerprint
    ) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "The atomic-write backend changed after the domain projection was compiled.",
      );
    }
    const requestDigest = operationDigest({`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `      afterSha256,
      bindingFingerprint: read.bindingFingerprint,
    });`,
  `      afterSha256,
      bindingFingerprint: read.bindingFingerprint,
      idempotencyIdentity: input.idempotencyIdentity ?? null,
      projectionDigest: input.projection
        ? operationDigest(input.projection)
        : null,
    });`,
);

replaceOnce(
  "src/services/operations/obsidianNoteReplaceOperationAdapter.ts",
  `        requestDigest,
        path: input.path,`,
  `        requestDigest,
        ...(input.idempotencyIdentity
          ? { idempotencyIdentity: input.idempotencyIdentity }
          : {}),
        ...(input.projection ? { projection: input.projection } : {}),
        path: input.path,`,
);

replaceOnce(
  "src/mcp-server/tools/governedNoteReplaceTools/runtime.ts",
  `export class GovernedNoteReplaceRuntime {`,
  `export type GovernedNoteReplacePlanView = {
  operationId: string;
  idempotencyKey: string;
  idempotencyIdentity?: string;
  path: string;
  beforeSha256: string;
  afterSha256: string;
  bindingFingerprint: string;
  status: ObsidianNoteReplacePlan["status"];
  projection?: ObsidianNoteReplacePlan["projection"];
};

export class GovernedNoteReplaceRuntime {`,
);

replaceOnce(
  "src/mcp-server/tools/governedNoteReplaceTools/runtime.ts",
  `  plan(input: ObsidianNoteReplacePlanInput): Promise<OperationReceipt> {`,
  `  readForProjection(path: string) {
    return this.backend.read({ contractVersion: 1, path });
  }

  findPlanByIdempotencyKey(
    idempotencyKey: string,
  ): GovernedNoteReplacePlanView | undefined {
    const plan = this.journal.getByIdempotencyKey(idempotencyKey);
    return plan ? this.view(plan) : undefined;
  }

  inspect(reference: string): GovernedNoteReplacePlanView {
    return this.view(this.required(reference));
  }

  plan(input: ObsidianNoteReplacePlanInput): Promise<OperationReceipt> {`,
);

replaceOnce(
  "src/mcp-server/tools/governedNoteReplaceTools/runtime.ts",
  `  private required(reference: string): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationIdFromRef(reference));
    if (!plan) throw new Error("Unknown note-replacement operation plan.");
    return plan;
  }

  private async refreshCacheAfterCommit(`,
  `  private required(reference: string): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationIdFromRef(reference));
    if (!plan) throw new Error("Unknown note-replacement operation plan.");
    return plan;
  }

  private view(plan: ObsidianNoteReplacePlan): GovernedNoteReplacePlanView {
    return {
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      ...(plan.idempotencyIdentity
        ? { idempotencyIdentity: plan.idempotencyIdentity }
        : {}),
      path: plan.path,
      beforeSha256: plan.beforeSha256,
      afterSha256: plan.afterSha256,
      bindingFingerprint: plan.bindingFingerprint,
      status: plan.status,
      ...(plan.projection
        ? { projection: structuredClone(plan.projection) }
        : {}),
    };
  }

  private async refreshCacheAfterCommit(`,
);

replaceOnce(
  "src/services/writePolicy.ts",
  `  | "obsidian_note_replace_recover"
  | "bases_create"`,
  `  | "obsidian_note_replace_recover"
  | "obsidian_frontmatter_patch_plan"
  | "obsidian_frontmatter_patch_apply"
  | "obsidian_frontmatter_patch_recover"
  | "bases_create"`,
);

replaceOnce(
  "src/mcp-server/tools/runtimeTools/registration.ts",
  `import { registerOperonTools } from "../operonTools/index.js";`,
  `import { registerGovernedFrontmatterTools } from "../governedFrontmatterTools/index.js";
import { registerOperonTools } from "../operonTools/index.js";`,
);

replaceOnce(
  "src/mcp-server/tools/runtimeTools/registration.ts",
  `  await registerGovernedNoteReplaceTools(server, governedNoteReplaceRuntime);
  await registerOperonTools(server);`,
  `  await registerGovernedNoteReplaceTools(server, governedNoteReplaceRuntime);
  await registerGovernedFrontmatterTools(server, governedNoteReplaceRuntime);
  await registerOperonTools(server);`,
);

console.log("Applied the bounded P1 projection seam over released P0.");
