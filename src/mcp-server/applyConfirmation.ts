/**
 * MCP carriage of the governed apply confirmation. Opt-in: it needs
 * MCP_PROTOCOL_MODE=dual and MCP_APPLY_CONFIRMATION=elicit; legacy serving
 * never reads the variable. A handler returns an input_required round. On a
 * 2026-07-28 request the client answers it and retries; on a 2025-11-25
 * connection the SDK shim sends a classic elicitation/create and re-enters
 * the handler. A client that does not declare form elicitation is never
 * asked, and its apply flow is unchanged.
 */
import { randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createRequestStateCodec,
  inputRequired,
  type ClientCapabilities,
  type InputRequiredResult,
  type Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { mcpProtocolMode } from "./protocolMode.js";
import {
  APPLY_CONFIRMATION_INPUT_KEY,
  APPLY_CONFIRMATION_RECEIPT_VALUE,
  applyConfirmationRefusal,
  applyConfirmationRequest,
  readApplyConfirmationAnswer,
  type ApplyConfirmationTarget,
} from "../services/applyConfirmation.js";

export type ApplyConfirmationMode = "off" | "elicit";

/** Apply tools that ask. Another governed apply joins by calling the gate. */
export const APPLY_CONFIRMATION_TOOLS: readonly string[] = Object.freeze([
  "obsidian_text_patch_apply",
]);

/** Fails closed on an unknown value; never echoes it. */
export function applyConfirmationMode(): ApplyConfirmationMode {
  if (mcpProtocolMode() !== "dual") return "off";
  const value = process.env.MCP_APPLY_CONFIRMATION?.trim() || "off";
  if (value !== "off" && value !== "elicit") {
    throw new Error("Invalid MCP apply confirmation mode. Expected off or elicit.");
  }
  return value;
}

/**
 * The capabilities the SDK itself checks before sending an embedded request:
 * the request envelope on 2026-07-28, the initialize declaration otherwise.
 */
export function requestClientCapabilities(
  server: Server,
  ctx: ServerContext,
): ClientCapabilities | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  if (typeof envelope?.[PROTOCOL_VERSION_META_KEY] === "string") {
    return envelope[CLIENT_CAPABILITIES_META_KEY] as
      | ClientCapabilities
      | undefined;
  }
  return server.getClientCapabilities();
}

/**
 * Same reading as the SDK gate: an explicit form mode, or an elicitation
 * declaration naming no mode at all (the 2025 meaning of a bare one).
 */
export function declaresFormElicitation(
  capabilities: ClientCapabilities | undefined,
): boolean {
  const elicitation = capabilities?.elicitation as
    | Record<string, unknown>
    | undefined;
  if (!elicitation || typeof elicitation !== "object") return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

type ConfirmationState = {
  v: 1;
  tool: string;
  planRef: string;
  planDigest: string;
};

// Rounds of one flow always return to this process: the stdio proxy keeps
// one backend, and a restarted backend simply refuses the old state.
const stateCodec = createRequestStateCodec<ConfirmationState>({
  key: randomBytes(32),
  ttlSeconds: 600,
  bind: (ctx) =>
    `optimike.apply-confirmation\0${ctx.http?.authInfo?.clientId ?? ""}`,
});

export type ApplyConfirmationGate =
  | { kind: "proceed"; confirmation?: typeof APPLY_CONFIRMATION_RECEIPT_VALUE }
  | { kind: "input_required"; result: InputRequiredResult };

/**
 * Runs after the caller's own seal and policy checks (inside loadTarget) and
 * before any effect. Refusals throw a closed McpError; nothing is written and
 * the journal is not touched, so the plan stays applicable.
 */
export async function confirmGovernedApply(input: {
  server: Server;
  ctx: ServerContext;
  toolName: string;
  loadTarget: () => Promise<ApplyConfirmationTarget>;
}): Promise<ApplyConfirmationGate> {
  const { server, ctx, toolName } = input;
  if (
    applyConfirmationMode() !== "elicit" ||
    !APPLY_CONFIRMATION_TOOLS.includes(toolName) ||
    !declaresFormElicitation(requestClientCapabilities(server, ctx))
  ) {
    return { kind: "proceed" };
  }
  const target = await input.loadTarget();
  if (!target.pending) return { kind: "proceed" };

  const echoed = ctx.mcpReq.requestState();
  if (echoed === undefined) {
    if (!(await target.beforeStateMatches())) {
      throw applyConfirmationRefusal("apply_confirmation_target_changed");
    }
    const requestState = await stateCodec.mint(
      {
        v: 1,
        tool: toolName,
        planRef: target.planRef,
        planDigest: target.planDigest,
      },
      ctx,
    );
    return {
      kind: "input_required",
      result: inputRequired({
        inputRequests: {
          [APPLY_CONFIRMATION_INPUT_KEY]: inputRequired.elicit(
            applyConfirmationRequest(target),
          ),
        },
        requestState,
      }),
    };
  }

  let state: ConfirmationState;
  try {
    if (typeof echoed !== "string") throw new Error("malformed");
    state = await stateCodec.verify(echoed, ctx);
  } catch {
    throw applyConfirmationRefusal("apply_confirmation_invalid");
  }
  if (
    state.v !== 1 ||
    state.tool !== toolName ||
    state.planRef !== target.planRef ||
    state.planDigest !== target.planDigest
  ) {
    throw applyConfirmationRefusal("apply_confirmation_invalid");
  }
  switch (
    readApplyConfirmationAnswer(
      ctx.mcpReq.inputResponses?.[APPLY_CONFIRMATION_INPUT_KEY],
    )
  ) {
    case "accept":
      return { kind: "proceed", confirmation: APPLY_CONFIRMATION_RECEIPT_VALUE };
    case "decline":
      throw applyConfirmationRefusal("apply_confirmation_declined");
    case "cancel":
      throw applyConfirmationRefusal("apply_confirmation_cancelled");
    default:
      throw applyConfirmationRefusal("apply_confirmation_invalid");
  }
}

/**
 * Stdio proxy hop. When this upstream request declares form elicitation,
 * the backend request declares it too and carries the upstream retry
 * material verbatim; otherwise the params are forwarded unchanged. The
 * backend hop must be 2026-07-28 (the caller checks the era).
 */
export function applyConfirmationRelay(
  server: Server,
  ctx: ServerContext,
): (<T extends { _meta?: Record<string, unknown> }>(params: T) => T) | undefined {
  if (
    applyConfirmationMode() !== "elicit" ||
    !declaresFormElicitation(requestClientCapabilities(server, ctx))
  ) {
    return undefined;
  }
  const responses = ctx.mcpReq.inputResponses;
  const echoed = ctx.mcpReq.requestState();
  return (params) => ({
    ...params,
    _meta: {
      ...params._meta,
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
    },
    ...(responses ? { inputResponses: responses } : {}),
    ...(typeof echoed === "string" ? { requestState: echoed } : {}),
  });
}
