import type { RequestContext } from "../../../utils/index.js";
import type {
  AtomicWriteCasRequest,
  AtomicWriteCasResponse,
  AtomicWriteReadRequest,
  AtomicWriteReadResponse,
  AtomicWriteStatusResponse,
  RequestFunction,
} from "../types.js";

const PREFIX = "/extensions/obsidian-atomic-write-bridge";

export async function getAtomicWriteStatus(
  request: RequestFunction,
  context: RequestContext,
): Promise<AtomicWriteStatusResponse> {
  return request<AtomicWriteStatusResponse>(
    { method: "GET", url: `${PREFIX}/status` },
    context,
    "getAtomicWriteStatus",
  );
}

export async function readAtomicWriteNote(
  request: RequestFunction,
  payload: AtomicWriteReadRequest,
  context: RequestContext,
): Promise<AtomicWriteReadResponse> {
  return request<AtomicWriteReadResponse>(
    { method: "POST", url: `${PREFIX}/notes/read`, data: payload },
    context,
    "readAtomicWriteNote",
  );
}

export async function replaceAtomicWriteNote(
  request: RequestFunction,
  payload: AtomicWriteCasRequest,
  context: RequestContext,
): Promise<AtomicWriteCasResponse> {
  return request<AtomicWriteCasResponse>(
    { method: "POST", url: `${PREFIX}/notes/cas`, data: payload },
    context,
    "replaceAtomicWriteNote",
  );
}
