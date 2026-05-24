/**
 * @module BasesMethods
 * @description
 * Helper methods that wrap HTTP calls to the Bases Bridge REST extension.
 * These methods are responsible only for constructing the request payload
 * and delegating execution to the shared request helper provided by the
 * `ObsidianRestApiService`.
 */

import { RequestContext } from "../../../utils/index.js";
import {
  BaseConfigResponse,
  BaseConfigUpsertRequest,
  BaseConfigUpsertResponse,
  BaseCreateRequest,
  BaseCreateResponse,
  BaseQueryRequest,
  BaseQueryResponse,
  BaseSchemaResponse,
  BasesListResponse,
  BaseUpsertRequest,
  BaseUpsertResponse,
  RequestFunction,
} from "../types.js";

/**
 * Fetches the list of `.base` files available in the vault.
 */
export async function listBases(
  _request: RequestFunction,
  context: RequestContext,
): Promise<BasesListResponse> {
  return _request<BasesListResponse>(
    {
      method: "GET",
      url: "/bases",
    },
    context,
    "listBases",
  );
}

/**
 * Retrieves the schema/configuration summary of a given base.
 */
export async function getBaseSchema(
  _request: RequestFunction,
  baseId: string,
  context: RequestContext,
): Promise<BaseSchemaResponse> {
  return _request<BaseSchemaResponse>(
    {
      method: "GET",
      url: `/bases/${encodeURIComponent(baseId)}/schema`,
    },
    context,
    "getBaseSchema",
  );
}

/**
 * Executes a query against a base, optionally leveraging evaluated values.
 */
export async function queryBase(
  _request: RequestFunction,
  baseId: string,
  payload: BaseQueryRequest,
  context: RequestContext,
): Promise<BaseQueryResponse> {
  return _request<BaseQueryResponse>(
    {
      method: "POST",
      url: `/bases/${encodeURIComponent(baseId)}/query`,
      headers: { "Content-Type": "application/json" },
      data: payload,
    },
    context,
    "queryBase",
  );
}

/**
 * Performs a batch upsert of note properties for rows in a base.
 */
export async function upsertBaseRows(
  _request: RequestFunction,
  baseId: string,
  payload: BaseUpsertRequest,
  context: RequestContext,
): Promise<BaseUpsertResponse> {
  const { requestTimeoutMs, ...bridgePayload } = payload;
  return _request<BaseUpsertResponse>(
    {
      method: "POST",
      url: `/bases/${encodeURIComponent(baseId)}/upsert`,
      headers: { "Content-Type": "application/json" },
      data: bridgePayload,
      timeout: requestTimeoutMs,
    },
    context,
    "upsertBaseRows",
  );
}

/**
 * Creates a new `.base` file on disk (or validates the payload).
 */
export async function createBase(
  _request: RequestFunction,
  payload: BaseCreateRequest,
  context: RequestContext,
): Promise<BaseCreateResponse> {
  return _request<BaseCreateResponse>(
    {
      method: "POST",
      url: "/bases",
      headers: { "Content-Type": "application/json" },
      data: payload,
    },
    context,
    "createBase",
  );
}

/**
 * Fetches the YAML configuration of a `.base` file.
 */
export async function getBaseConfig(
  _request: RequestFunction,
  baseId: string,
  context: RequestContext,
): Promise<BaseConfigResponse> {
  return _request<BaseConfigResponse>(
    {
      method: "GET",
      url: `/bases/${encodeURIComponent(baseId)}/config`,
    },
    context,
    "getBaseConfig",
  );
}

/**
 * Replaces or validates the YAML/JSON configuration of a `.base` file.
 */
export async function upsertBaseConfig(
  _request: RequestFunction,
  baseId: string,
  payload: BaseConfigUpsertRequest,
  context: RequestContext,
): Promise<BaseConfigUpsertResponse> {
  return _request<BaseConfigUpsertResponse>(
    {
      method: "PUT",
      url: `/bases/${encodeURIComponent(baseId)}/config`,
      headers: { "Content-Type": "application/json" },
      data: payload,
    },
    context,
    "upsertBaseConfig",
  );
}
