/**
 * @module ObsidianRestApiService
 * @description
 * This module provides the core implementation for the Obsidian REST API service.
 * It encapsulates the logic for making authenticated requests to the API endpoints.
 */

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import https from "node:https"; // Import the https module for Agent configuration
import { config } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../utils/index.js"; // Added requestContextService
import * as activeFileMethods from "./methods/activeFileMethods.js";
import * as atomicWriteMethods from "./methods/atomicWriteMethods.js";
import * as baseAtomicWriteMethods from "./methods/baseAtomicWriteMethods.js";
import * as basesMethods from "./methods/basesMethods.js";
import * as commandMethods from "./methods/commandMethods.js";
import * as openMethods from "./methods/openMethods.js";
import * as patchMethods from "./methods/patchMethods.js";
import * as searchMethods from "./methods/searchMethods.js";
import * as vaultMethods from "./methods/vaultMethods.js";
import { requestLogMetadata } from "./requestLogMetadata.js";
import {
  ApiStatusResponse, // Import PatchOptions type
  AtomicWriteCasRequest,
  AtomicWriteCasResponse,
  AtomicWriteReadRequest,
  AtomicWriteReadResponse,
  AtomicWriteStatusResponse,
  BaseAtomicCasRequest,
  BaseAtomicCasResponse,
  BaseAtomicReadRequest,
  BaseAtomicReadResponse,
  BaseAtomicStatusResponse,
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
  ComplexSearchResult,
  NoteJson,
  NoteStat,
  ObsidianCommand,
  PatchOptions,
  PatchPayload,
  SimpleSearchResult,
} from "./types.js"; // Import types from the new file

export class ObsidianRestApiService {
  private axiosInstance: AxiosInstance;
  private apiKey: string;

  constructor() {
    const apiKey = config.obsidianApiKey; // Get from central config
    if (!apiKey) {
      // Config validation should prevent this, but double-check
      throw new McpError(
        BaseErrorCode.CONFIGURATION_ERROR,
        "Obsidian API Key is missing in configuration.",
        {},
      );
    }
    this.apiKey = apiKey;

    const httpsAgent = new https.Agent({
      rejectUnauthorized: config.obsidianVerifySsl,
    });

    this.axiosInstance = axios.create({
      baseURL: config.obsidianBaseUrl.replace(/\/$/, ""), // Remove trailing slash
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json", // Default accept type
      },
      timeout: 60000, // Increased timeout to 60 seconds (was 15000)
      httpsAgent,
    });

    logger.info(
      `ObsidianRestApiService initialized with base URL: ${this.axiosInstance.defaults.baseURL}, Verify SSL: ${config.obsidianVerifySsl}`,
      requestContextService.createRequestContext({
        operation: "ObsidianServiceInit",
      }),
    );
  }

  /**
   * Private helper to make requests and handle common errors.
   * @param config - Axios request configuration.
   * @param context - Request context for logging.
   * @param operationName - Name of the operation for logging context.
   * @returns The response data.
   * @throws {McpError} If the request fails.
   */
  private async _request<T = any>(
    requestConfig: AxiosRequestConfig,
    context: RequestContext,
    operationName: string,
  ): Promise<T> {
    const operationContext = {
      ...context,
      operation: `ObsidianAPI_${operationName}`,
    };
    logger.debug(
      `Making Obsidian API request: ${requestConfig.method} ${requestConfig.url}`,
      operationContext,
    );

    return await ErrorHandler.tryCatch(
      async () => {
        try {
          const response = await this.axiosInstance.request<T>(requestConfig);
          logger.debug(
            `Obsidian API request successful: ${requestConfig.method} ${requestConfig.url}`,
            { ...operationContext, status: response.status },
          );
          // For HEAD requests, we need the headers, so return the whole response.
          // For other requests, returning response.data is fine.
          if (requestConfig.method === "HEAD") {
            return response as T;
          }
          return response.data;
        } catch (error) {
          const axiosError = error as AxiosError;
          let errorCode = BaseErrorCode.INTERNAL_ERROR;
          let errorMessage = `Obsidian API request failed: ${axiosError.message}`;
          const errorDetails: Record<string, any> = {
            requestUrl: requestConfig.url,
            requestMethod: requestConfig.method,
            responseStatus: axiosError.response?.status,
            responseData: axiosError.response?.data,
          };

          if (axiosError.response) {
            // Handle specific HTTP status codes
            switch (axiosError.response.status) {
              case 400:
                errorCode = BaseErrorCode.VALIDATION_ERROR;
                errorMessage = `Obsidian API Bad Request: ${JSON.stringify(axiosError.response.data)}`;
                break;
              case 401:
                errorCode = BaseErrorCode.UNAUTHORIZED;
                errorMessage = "Obsidian API Unauthorized: Invalid API Key.";
                break;
              case 403:
                errorCode = BaseErrorCode.FORBIDDEN;
                errorMessage = "Obsidian API Forbidden: Check permissions.";
                break;
              case 404:
                errorCode = BaseErrorCode.NOT_FOUND;
                errorMessage = `Obsidian API Not Found: ${requestConfig.url}`;
                // Log 404s at debug level, as they might be expected (e.g., checking existence)
                logger.debug(errorMessage, {
                  ...operationContext,
                  ...errorDetails,
                });
                throw new McpError(errorCode, errorMessage, operationContext);
              // NOTE: We throw immediately after logging debug for 404, skipping the general error log below.
              case 405:
                errorCode = BaseErrorCode.VALIDATION_ERROR; // Method not allowed often implies incorrect usage
                errorMessage = `Obsidian API Method Not Allowed: ${requestConfig.method} on ${requestConfig.url}`;
                break;
              case 409:
                errorCode = BaseErrorCode.CONFLICT;
                errorMessage = `Obsidian API Conflict: ${JSON.stringify(axiosError.response.data)}`;
                break;
              case 412:
                errorCode = BaseErrorCode.CONFLICT;
                errorMessage =
                  "Obsidian API Precondition Failed: the note changed after it was read.";
                break;
              case 422:
                errorCode = BaseErrorCode.VALIDATION_ERROR;
                errorMessage = `Obsidian API Unprocessable Entity: ${JSON.stringify(axiosError.response.data)}`;
                break;
              case 503:
                errorCode = BaseErrorCode.SERVICE_UNAVAILABLE;
                errorMessage = "Obsidian API Service Unavailable.";
                break;
            }
            // General error logging for non-404 client/server errors handled above
            logger.error(errorMessage, {
              ...operationContext,
              ...errorDetails,
            });
            throw new McpError(errorCode, errorMessage, operationContext);
          } else if (axiosError.request) {
            // Network error (no response received)
            errorCode = BaseErrorCode.SERVICE_UNAVAILABLE;
            errorMessage = `Obsidian API Network Error: No response received from ${requestConfig.url}. This may be due to Obsidian not running, the Local REST API plugin being disabled, or a network issue.`;
            logger.error(errorMessage, {
              ...operationContext,
              ...errorDetails,
            });
            throw new McpError(errorCode, errorMessage, operationContext);
          } else {
            // Other errors (e.g., setup issues)
            // Pass error object correctly if it's an Error instance
            logger.error(
              errorMessage,
              error instanceof Error ? error : undefined,
              {
                ...operationContext,
                ...errorDetails,
                originalError: String(error),
              },
            );
            throw new McpError(errorCode, errorMessage, operationContext);
          }
        }
      },
      {
        operation: `ObsidianAPI_${operationName}_Wrapper`,
        context: context,
        input: requestLogMetadata(requestConfig),
        errorCode: BaseErrorCode.INTERNAL_ERROR, // Default if wrapper itself fails
      },
    );
  }

  // --- API Methods ---

  /**
   * Checks the status and authentication of the Obsidian Local REST API.
   * @param context - The request context for logging and correlation.
   * @returns {Promise<ApiStatusResponse>} - The status object from the API.
   */
  async checkStatus(context: RequestContext): Promise<ApiStatusResponse> {
    // Note: This is the only endpoint that doesn't strictly require auth,
    // but sending the key helps check if it's valid.
    // This one is simple enough to keep inline or could be extracted too.
    return this._request<ApiStatusResponse>(
      {
        method: "GET",
        url: "/",
      },
      context,
      "checkStatus",
    );
  }

  async getAtomicWriteStatus(
    context: RequestContext,
  ): Promise<AtomicWriteStatusResponse> {
    return atomicWriteMethods.getAtomicWriteStatus(
      this._request.bind(this),
      context,
    );
  }

  async readAtomicWriteNote(
    payload: AtomicWriteReadRequest,
    context: RequestContext,
  ): Promise<AtomicWriteReadResponse> {
    return atomicWriteMethods.readAtomicWriteNote(
      this._request.bind(this),
      payload,
      context,
    );
  }

  async replaceAtomicWriteNote(
    payload: AtomicWriteCasRequest,
    context: RequestContext,
  ): Promise<AtomicWriteCasResponse> {
    return atomicWriteMethods.replaceAtomicWriteNote(
      this._request.bind(this),
      payload,
      context,
    );
  }

  async getBaseAtomicStatus(
    context: RequestContext,
  ): Promise<BaseAtomicStatusResponse> {
    return baseAtomicWriteMethods.getBaseAtomicStatus(
      this._request.bind(this),
      context,
    );
  }

  async readAtomicBase(
    payload: BaseAtomicReadRequest,
    context: RequestContext,
  ): Promise<BaseAtomicReadResponse> {
    return baseAtomicWriteMethods.readAtomicBase(
      this._request.bind(this),
      payload,
      context,
    );
  }

  async replaceAtomicBase(
    payload: BaseAtomicCasRequest,
    context: RequestContext,
  ): Promise<BaseAtomicCasResponse> {
    return baseAtomicWriteMethods.replaceAtomicBase(
      this._request.bind(this),
      payload,
      context,
    );
  }

  // --- Vault Methods ---

  /**
   * Gets the content of a specific file in the vault.
   * @param filePath - Vault-relative path to the file.
   * @param format - 'markdown' or 'json' (for NoteJson).
   * @param context - Request context.
   * @returns The file content (string) or NoteJson object.
   */
  async getFileContent(
    filePath: string,
    format: "markdown" | "json" = "markdown",
    context: RequestContext,
  ): Promise<string | NoteJson> {
    return vaultMethods.getFileContent(
      this._request.bind(this),
      filePath,
      format,
      context,
    );
  }

  /**
   * Updates (overwrites) the content of a file or creates it if it doesn't exist.
   * @param filePath - Vault-relative path to the file.
   * @param content - The new content for the file.
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (204 No Content).
   */
  async updateFileContent(
    filePath: string,
    content: string,
    context: RequestContext,
  ): Promise<void> {
    return vaultMethods.updateFileContent(
      this._request.bind(this),
      filePath,
      content,
      context,
    );
  }

  /**
   * Appends content to the end of a file. Creates the file if it doesn't exist.
   * @param filePath - Vault-relative path to the file.
   * @param content - The content to append.
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (204 No Content).
   */
  async appendFileContent(
    filePath: string,
    content: string,
    context: RequestContext,
  ): Promise<void> {
    return vaultMethods.appendFileContent(
      this._request.bind(this),
      filePath,
      content,
      context,
    );
  }

  /**
   * Deletes a specific file in the vault.
   * @param filePath - Vault-relative path to the file.
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (204 No Content).
   */
  async deleteFile(filePath: string, context: RequestContext): Promise<void> {
    return vaultMethods.deleteFile(this._request.bind(this), filePath, context);
  }

  /**
   * Lists files within a specified directory in the vault.
   * @param dirPath - Vault-relative path to the directory. Use empty string "" or "/" for the root.
   * @param context - Request context.
   * @returns A list of file and directory names.
   */
  async listFiles(dirPath: string, context: RequestContext): Promise<string[]> {
    return vaultMethods.listFiles(this._request.bind(this), dirPath, context);
  }

  /**
   * Gets the metadata (stat) of a specific file using a lightweight HEAD request.
   * @param filePath - Vault-relative path to the file.
   * @param context - Request context.
   * @returns The file's metadata.
   */
  async getFileMetadata(
    filePath: string,
    context: RequestContext,
  ): Promise<NoteStat | null> {
    return vaultMethods.getFileMetadata(
      this._request.bind(this),
      filePath,
      context,
    );
  }

  // --- Search Methods ---

  /**
   * Performs a simple text search across the vault.
   * @param query - The text query string.
   * @param contextLength - Number of characters surrounding each match (default 100).
   * @param context - Request context.
   * @returns An array of search results.
   */
  async searchSimple(
    query: string,
    contextLength: number = 100,
    context: RequestContext,
  ): Promise<SimpleSearchResult[]> {
    return searchMethods.searchSimple(
      this._request.bind(this),
      query,
      contextLength,
      context,
    );
  }

  /**
   * Performs a complex search using Dataview DQL or JsonLogic.
   * @param query - The query string (DQL) or JSON object (JsonLogic).
   * @param contentType - The content type header indicating the query format.
   * @param context - Request context.
   * @returns An array of search results.
   */
  async searchComplex(
    query: string | object,
    contentType:
      | "application/vnd.olrapi.dataview.dql+txt"
      | "application/vnd.olrapi.jsonlogic+json",
    context: RequestContext,
  ): Promise<ComplexSearchResult[]> {
    return searchMethods.searchComplex(
      this._request.bind(this),
      query,
      contentType,
      context,
    );
  }

  // --- Bases Bridge Methods ---

  /**
   * Lists all `.base` files discovered by the Bases Bridge.
   */
  async listBases(context: RequestContext): Promise<BasesListResponse> {
    return basesMethods.listBases(this._request.bind(this), context);
  }

  /**
   * Retrieves schema information for a specific base.
   */
  async getBaseSchema(
    baseId: string,
    context: RequestContext,
  ): Promise<BaseSchemaResponse> {
    return basesMethods.getBaseSchema(
      this._request.bind(this),
      baseId,
      context,
    );
  }

  /**
   * Executes a query against the Bases Bridge.
   */
  async queryBase(
    baseId: string,
    payload: BaseQueryRequest,
    context: RequestContext,
  ): Promise<BaseQueryResponse> {
    return basesMethods.queryBase(
      this._request.bind(this),
      baseId,
      payload,
      context,
    );
  }

  /**
   * Performs a batch upsert against the Bases Bridge.
   */
  async upsertBaseRows(
    baseId: string,
    payload: BaseUpsertRequest,
    context: RequestContext,
  ): Promise<BaseUpsertResponse> {
    return basesMethods.upsertBaseRows(
      this._request.bind(this),
      baseId,
      payload,
      context,
    );
  }

  /**
   * Creates a new `.base` file or validates the payload without writing.
   */
  async createBase(
    payload: BaseCreateRequest,
    context: RequestContext,
  ): Promise<BaseCreateResponse> {
    return basesMethods.createBase(this._request.bind(this), payload, context);
  }

  /**
   * Retrieves the YAML/JSON configuration for a `.base` file.
   */
  async getBaseConfig(
    baseId: string,
    context: RequestContext,
  ): Promise<BaseConfigResponse> {
    return basesMethods.getBaseConfig(
      this._request.bind(this),
      baseId,
      context,
    );
  }

  /**
   * Updates or validates the configuration for a `.base` file.
   */
  async upsertBaseConfig(
    baseId: string,
    payload: BaseConfigUpsertRequest,
    context: RequestContext,
  ): Promise<BaseConfigUpsertResponse> {
    return basesMethods.upsertBaseConfig(
      this._request.bind(this),
      baseId,
      payload,
      context,
    );
  }

  // --- Command Methods ---

  /**
   * Executes a registered Obsidian command by its ID.
   * @param commandId - The ID of the command (e.g., "app:go-back").
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (204 No Content).
   */
  async executeCommand(
    commandId: string,
    context: RequestContext,
  ): Promise<void> {
    return commandMethods.executeCommand(
      this._request.bind(this),
      commandId,
      context,
    );
  }

  /**
   * Lists all available Obsidian commands.
   * @param context - Request context.
   * @returns A list of available commands.
   */
  async listCommands(context: RequestContext): Promise<ObsidianCommand[]> {
    return commandMethods.listCommands(this._request.bind(this), context);
  }

  // --- Open Methods ---

  /**
   * Opens a specific file in Obsidian. Creates the file if it doesn't exist.
   * @param filePath - Vault-relative path to the file.
   * @param newLeaf - Whether to open the file in a new editor tab (leaf).
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (200 OK, but no body expected).
   */
  async openFile(
    filePath: string,
    newLeaf: boolean = false,
    context: RequestContext,
  ): Promise<void> {
    return openMethods.openFile(
      this._request.bind(this),
      filePath,
      newLeaf,
      context,
    );
  }

  // --- Active File Methods ---

  /**
   * Gets the content of the currently active file in Obsidian.
   * @param format - 'markdown' or 'json' (for NoteJson).
   * @param context - Request context.
   * @returns The file content (string) or NoteJson object.
   */
  async getActiveFile(
    format: "markdown" | "json" = "markdown",
    context: RequestContext,
  ): Promise<string | NoteJson> {
    return activeFileMethods.getActiveFile(
      this._request.bind(this),
      format,
      context,
    );
  }

  /**
   * Updates (overwrites) the content of the currently active file.
   * @param content - The new content.
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (204 No Content).
   */
  async updateActiveFile(
    content: string,
    context: RequestContext,
  ): Promise<void> {
    return activeFileMethods.updateActiveFile(
      this._request.bind(this),
      content,
      context,
    );
  }

  /**
   * Appends content to the end of the currently active file.
   * @param content - The content to append.
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (204 No Content).
   */
  async appendActiveFile(
    content: string,
    context: RequestContext,
  ): Promise<void> {
    return activeFileMethods.appendActiveFile(
      this._request.bind(this),
      content,
      context,
    );
  }

  /**
   * Deletes the currently active file.
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (204 No Content).
   */
  async deleteActiveFile(context: RequestContext): Promise<void> {
    return activeFileMethods.deleteActiveFile(
      this._request.bind(this),
      context,
    );
  }

  // --- Patch Methods ---

  /**
   * Patches a specific file in the vault using granular controls.
   * @param filePath - Vault-relative path to the file.
   * @param payload - The value to apply. Omit it for delete operations.
   * @param options - Patch operation details (operation, targetType, target, etc.).
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (200 OK).
   */
  async patchFile(
    filePath: string,
    payload: PatchPayload,
    options: PatchOptions,
    context: RequestContext,
  ): Promise<void> {
    return patchMethods.patchFile(
      this._request.bind(this),
      filePath,
      payload,
      options,
      context,
    );
  }

  /**
   * Patches the currently active file in Obsidian using granular controls.
   * @param payload - The value to apply. Omit it for delete operations.
   * @param options - Patch operation details.
   * @param context - Request context.
   * @returns {Promise<void>} Resolves on success (200 OK).
   */
  async patchActiveFile(
    payload: PatchPayload,
    options: PatchOptions,
    context: RequestContext,
  ): Promise<void> {
    return patchMethods.patchActiveFile(
      this._request.bind(this),
      payload,
      options,
      context,
    );
  }
}
