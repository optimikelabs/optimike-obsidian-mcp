import type { RequestContext } from "../../../utils/index.js";
import type {
  AtomicWriteCasRequest,
  AtomicWriteCasResponse,
  AtomicWriteReadRequest,
  AtomicWriteReadResponse,
  AtomicWriteStatusResponse,
  CanvasAtomicCasRequest,
  CanvasAtomicCasResponse,
  CanvasAtomicReadRequest,
  CanvasAtomicReadResponse,
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

export async function readAtomicWriteCanvas(
  request: RequestFunction,
  payload: CanvasAtomicReadRequest,
  context: RequestContext,
): Promise<CanvasAtomicReadResponse> {
  return request<CanvasAtomicReadResponse>(
    { method: "POST", url: `${PREFIX}/canvas/read`, data: payload },
    context,
    "readAtomicWriteCanvas",
  );
}

export async function replaceAtomicWriteCanvas(
  request: RequestFunction,
  payload: CanvasAtomicCasRequest,
  context: RequestContext,
): Promise<CanvasAtomicCasResponse> {
  return request<CanvasAtomicCasResponse>(
    { method: "POST", url: `${PREFIX}/canvas/cas`, data: payload },
    context,
    "replaceAtomicWriteCanvas",
  );
}
