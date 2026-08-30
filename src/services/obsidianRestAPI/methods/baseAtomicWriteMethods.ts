import type { RequestContext } from "../../../utils/index.js";
import type {
  BaseAtomicCasRequest,
  BaseAtomicCasResponse,
  BaseAtomicReadRequest,
  BaseAtomicReadResponse,
  BaseAtomicStatusResponse,
  RequestFunction,
} from "../types.js";

const PREFIX = "/extensions/obsidian-bases-bridge/atomic";

export function getBaseAtomicStatus(
  request: RequestFunction,
  context: RequestContext,
  timeoutMs?: number,
): Promise<BaseAtomicStatusResponse> {
  return request<BaseAtomicStatusResponse>(
    { method: "GET", url: `${PREFIX}/status`, timeout: timeoutMs },
    context,
    "getBaseAtomicStatus",
  );
}

export function readAtomicBase(
  request: RequestFunction,
  payload: BaseAtomicReadRequest,
  context: RequestContext,
): Promise<BaseAtomicReadResponse> {
  return request<BaseAtomicReadResponse>(
    { method: "POST", url: `${PREFIX}/bases/read`, data: payload },
    context,
    "readAtomicBase",
  );
}

export function replaceAtomicBase(
  request: RequestFunction,
  payload: BaseAtomicCasRequest,
  context: RequestContext,
): Promise<BaseAtomicCasResponse> {
  return request<BaseAtomicCasResponse>(
    { method: "POST", url: `${PREFIX}/bases/cas`, data: payload },
    context,
    "replaceAtomicBase",
  );
}
