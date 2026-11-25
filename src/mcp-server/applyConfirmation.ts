/**
 * MCP carriage of the governed apply confirmation. Opt-in: it needs
 * MCP_PROTOCOL_MODE=dual and MCP_APPLY_CONFIRMATION=elicit; legacy serving
 * never reads the variable. On a 2026-07-28 request the handler returns an
 * input_required round that the client answers by retrying with an
 * integrity-protected requestState. On a 2025-11-25 connection the handler
 * sends a classic elicitation/create itself, so a client error or a timeout
 * becomes a closed refusal (the SDK shim's free text never reaches the
 * caller). A fresh call from a client that does not declare form elicitation
 * is never asked and keeps the unchanged apply flow. A call that carries
 * answer material is never treated as a fresh call.
 */
import { randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createRequestStateCodec,
  inputRequired,
  type CallToolResult,
  type ClientCapabilities,
  type ElicitResult,
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
  type ApplyConfirmationRefusalCode,
  type ApplyConfirmationTarget,
} from "../services/applyConfirmation.js";
import { publicMcpToolErrorPayload } from "../utils/internal/errorHandler.js";

export type ApplyConfirmationMode = "off" | "elicit";

/** Apply tools that ask. Another governed apply joins by calling the gate. */
export const APPLY_CONFIRMATION_TOOLS: readonly string[] = Object.freeze([
  "obsidian_text_patch_apply",
]);

/** How long one question may wait for its answer (both generations). */
export const APPLY_CONFIRMATION_TIMEOUT_MS = 600_000;

/** Fails closed on an unknown value; never echoes it. */
export function applyConfirmationMode(): ApplyConfirmationMode {
  if (mcpProtocolMode() !== "dual") return "off";
  const value = process.env.MCP_APPLY_CONFIRMATION?.trim() || "off";
  if (value !== "off" && value !== "elicit") {
    throw new Error("Invalid MCP apply confirmation mode. Expected off or elicit.");
  }
  return value;
}

/** A request carrying the 2026-07-28 per-request envelope. */
export function isModernRequest(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  return typeof envelope?.[PROTOCOL_VERSION_META_KEY] === "string";
}

/**
 * The capabilities the SDK itself checks before sending an embedded request:
 * the request envelope on 2026-07-28, the initialize declaration otherwise.
 */
export function requestClientCapabilities(
  server: Server,
  ctx: ServerContext,
): ClientCapabilities | undefined {
  if (isModernRequest(ctx)) {
    return (ctx.mcpReq.envelope as Record<string, unknown>)[
      CLIENT_CAPABILITIES_META_KEY
    ] as ClientCapabilities | undefined;
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

/** True when the request carries answer material of a multi-round flow. */
export function carriesConfirmationAnswer(ctx: ServerContext): boolean {
  return (
    ctx.mcpReq.requestState() !== undefined ||
    Object.keys(ctx.mcpReq.inputResponses ?? {}).length > 0 ||
    (ctx.mcpReq.droppedInputResponseKeys?.length ?? 0) > 0
  );
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
  ttlSeconds: APPLY_CONFIRMATION_TIMEOUT_MS / 1000,
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
  if (mcpProtocolMode() !== "dual" || !APPLY_CONFIRMATION_TOOLS.includes(toolName)) {
    return { kind: "proceed" };
  }
  const capable =
    applyConfirmationMode() === "elicit" &&
    declaresFormElicitation(requestClientCapabilities(server, ctx));
  const answering = carriesConfirmationAnswer(ctx);
  if (!answering && !capable) return { kind: "proceed" };
  const target = await input.loadTarget();
  if (answering) return settleAnswerRound(ctx, toolName, target, capable);
  if (!target.pending) return { kind: "proceed" };
  if (!(await target.beforeStateMatches())) {
    throw applyConfirmationRefusal("apply_confirmation_target_changed");
  }
  if (isModernRequest(ctx)) {
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
  // 2025-11-25: ask in place, within this request.
  let answer: ElicitResult;
  try {
    answer = await ctx.mcpReq.elicitInput(applyConfirmationRequest(target), {
      timeout: APPLY_CONFIRMATION_TIMEOUT_MS,
    });
  } catch {
    throw applyConfirmationRefusal("apply_confirmation_unavailable");
  }
  return settleAnswer(readApplyConfirmationAnswer(answer), true);
}

/**
 * A retried 2026-07-28 request. The answer counts only with the state this
 * process minted for this exact plan; a decline or cancel is refused even if
 * the plan was meanwhile applied by another call.
 */
async function settleAnswerRound(
  ctx: ServerContext,
  toolName: string,
  target: ApplyConfirmationTarget,
  capable: boolean,
): Promise<ApplyConfirmationGate> {
  const echoed = ctx.mcpReq.requestState();
  let state: ConfirmationState;
  try {
    if (typeof echoed !== "string") throw new Error("missing");
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
  const answer = readApplyConfirmationAnswer(
    ctx.mcpReq.inputResponses?.[APPLY_CONFIRMATION_INPUT_KEY],
  );
  // An accept needs the opt-in and a declared capability on this request too.
  if (answer === "accept" && !capable) {
    throw applyConfirmationRefusal("apply_confirmation_invalid");
  }
  return settleAnswer(answer, target.pending);
}

function settleAnswer(
  answer: ReturnType<typeof readApplyConfirmationAnswer>,
  pending: boolean,
): ApplyConfirmationGate {
  switch (answer) {
    case "accept":
      // A plan already applied by another call only replays its receipt.
      return pending
        ? { kind: "proceed", confirmation: APPLY_CONFIRMATION_RECEIPT_VALUE }
        : { kind: "proceed" };
    case "decline":
      throw applyConfirmationRefusal("apply_confirmation_declined");
    case "cancel":
      throw applyConfirmationRefusal("apply_confirmation_cancelled");
    default:
      throw applyConfirmationRefusal("apply_confirmation_invalid");
  }
}

/** Closed tool-error result for a refusal decided outside a tool handler. */
export function applyConfirmationRefusalResult(
  code: ApplyConfirmationRefusalCode,
  toolName: string,
  params: unknown,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          publicMcpToolErrorPayload(applyConfirmationRefusal(code), {
            operation: toolName,
            toolName,
            params,
          }),
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

export type ApplyConfirmationRelay =
  | { kind: "forward" }
  | { kind: "refuse" }
  | {
      kind: "relay";
      upstreamModern: boolean;
      answering: boolean;
      params<T extends { _meta?: Record<string, unknown> }>(
        params: T,
        answer?: { inputResponses: Record<string, unknown>; requestState?: string },
      ): T;
    };

/**
 * Stdio proxy hop. "forward": unchanged call (legacy serving, or a fresh call
 * without capability or opt-in). "refuse": the request carries answer
 * material that this hop cannot carry, so nothing is forwarded. "relay": the
 * backend request (2026-07-28 only; the caller checks the era) declares form
 * elicitation and carries the answer material verbatim.
 */
export function applyConfirmationRelay(
  server: Server,
  ctx: ServerContext,
): ApplyConfirmationRelay {
  if (mcpProtocolMode() !== "dual") return { kind: "forward" };
  const answering = carriesConfirmationAnswer(ctx);
  const capable =
    applyConfirmationMode() === "elicit" &&
    declaresFormElicitation(requestClientCapabilities(server, ctx));
  if (!capable) return answering ? { kind: "refuse" } : { kind: "forward" };
  const responses = ctx.mcpReq.inputResponses;
  const echoed = ctx.mcpReq.requestState();
  return {
    kind: "relay",
    upstreamModern: isModernRequest(ctx),
    answering,
    params: (params, answer) => {
      const inputResponses = answer?.inputResponses ?? responses;
      const requestState =
        answer?.requestState ?? (typeof echoed === "string" ? echoed : undefined);
      return {
        ...params,
        _meta: {
          ...params._meta,
          [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
        },
        ...(inputResponses ? { inputResponses } : {}),
        ...(requestState !== undefined ? { requestState } : {}),
      };
    },
  };
}

/**
 * For a 2025-11-25 upstream: the one form elicitation of a backend round, or
 * undefined when the round asks for anything else.
 */
export function relayableConfirmationQuestion(
  round: InputRequiredResult,
): Parameters<ServerContext["mcpReq"]["elicitInput"]>[0] | undefined {
  const entries = Object.entries(round.inputRequests ?? {});
  if (entries.length !== 1 || typeof round.requestState !== "string") {
    return undefined;
  }
  const [key, request] = entries[0]!;
  const params = (request as { method?: unknown; params?: unknown }).params as
    | Record<string, unknown>
    | undefined;
  if (
    key !== APPLY_CONFIRMATION_INPUT_KEY ||
    (request as { method?: unknown }).method !== "elicitation/create" ||
    !params ||
    (params.mode !== undefined && params.mode !== "form")
  ) {
    return undefined;
  }
  return params as Parameters<ServerContext["mcpReq"]["elicitInput"]>[0];
}
