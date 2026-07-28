/**
 * @module VaultMethods
 * @description
 * Methods for interacting with vault files and directories via the Obsidian REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import {
  DocumentMap,
  NoteJson,
  FileListResponse,
  NoteStat,
  RequestFunction,
} from "../types.js";
import { encodeVaultPath } from "../../../utils/obsidian/obsidianApiUtils.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

/**
 * Gets the content of a specific file in the vault.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param format - 'markdown' or 'json' (for NoteJson).
 * @param context - Request context.
 * @returns The file content (string) or NoteJson object.
 */
export async function getFileContent(
  _request: RequestFunction,
  filePath: string,
  format: "markdown" | "json" = "markdown",
  context: RequestContext,
): Promise<string | NoteJson> {
  const acceptHeader =
    format === "json" ? "application/vnd.olrapi.note+json" : "text/markdown";
  const encodedPath = encodeVaultPath(filePath); // Use the new encoding function
  return _request<string | NoteJson>(
    {
      method: "GET",
      url: `/vault${encodedPath}`,
      headers: { Accept: acceptHeader },
    },
    context,
    "getFileContent",
  );
}

/**
 * Gets the markdown-patch 2.x document map for a vault file.
 *
 * The returned version token can be supplied to
 * {@link replaceFileContentIfMatch} for an atomic read-modify-write cycle.
 */
export async function getFileDocumentMap(
  _request: RequestFunction,
  filePath: string,
  context: RequestContext,
): Promise<DocumentMap> {
  const encodedPath = encodeVaultPath(filePath);
  const documentMap = await _request<DocumentMap>(
    {
      method: "GET",
      url: `/vault${encodedPath}`,
      headers: {
        Accept: "application/vnd.olrapi.document-map+json",
      },
    },
    context,
    "getFileDocumentMap",
  );

  if (
    !documentMap ||
    typeof documentMap.version !== "string" ||
    documentMap.version.trim().length === 0
  ) {
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "Obsidian Local REST API did not return a document version. Conditional writes require markdown-patch 2.x support.",
      { filePath },
    );
  }

  return documentMap;
}

/**
 * Replaces an existing vault file only if its document version still matches.
 *
 * This uses markdown-patch 2.x raw-content mode. A stale version is returned by
 * Local REST API as HTTP 412 and mapped by the service to CONFLICT.
 *
 * Empty content is rejected deliberately: raw-content mode treats an empty
 * body as a missing payload rather than an instruction to clear the note.
 */
export async function replaceFileContentIfMatch(
  _request: RequestFunction,
  filePath: string,
  content: string,
  expectedVersion: string,
  context: RequestContext,
): Promise<void> {
  const normalizedVersion = expectedVersion.trim();
  if (!normalizedVersion) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "A non-empty document version is required for a conditional write.",
      { filePath },
    );
  }
  if (content.length === 0) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "Conditional raw-content replacement cannot use an empty payload.",
      { filePath },
    );
  }

  const encodedPath = encodeVaultPath(filePath);
  await _request<void>(
    {
      method: "PATCH",
      url: `/vault${encodedPath}`,
      headers: {
        "Content-Type": "text/markdown",
        Operation: "replace",
        "If-Match": normalizedVersion,
      },
      data: content,
    },
    context,
    "replaceFileContentIfMatch",
  );
}

/**
 * Updates (overwrites) the content of a file or creates it if it doesn't exist.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param content - The new content for the file.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function updateFileContent(
  _request: RequestFunction,
  filePath: string,
  content: string,
  context: RequestContext,
): Promise<void> {
  const encodedPath = encodeVaultPath(filePath); // Use the new encoding function
  // PUT returns 204 No Content, so the expected type is void
  await _request<void>(
    {
      method: "PUT",
      url: `/vault${encodedPath}`, // Construct URL correctly
      headers: { "Content-Type": "text/markdown" },
      data: content,
    },
    context,
    "updateFileContent",
  );
}

/**
 * Appends content to the end of a file. Creates the file if it doesn't exist.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param content - The content to append.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function appendFileContent(
  _request: RequestFunction,
  filePath: string,
  content: string,
  context: RequestContext,
): Promise<void> {
  const encodedPath = encodeVaultPath(filePath); // Use the new encoding function
  await _request<void>(
    {
      method: "POST",
      url: `/vault${encodedPath}`, // Construct URL correctly
      headers: { "Content-Type": "text/markdown" },
      data: content,
    },
    context,
    "appendFileContent",
  );
}

/**
 * Deletes a specific file in the vault.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function deleteFile(
  _request: RequestFunction,
  filePath: string,
  context: RequestContext,
): Promise<void> {
  const encodedPath = encodeVaultPath(filePath); // Use the new encoding function
  await _request<void>(
    {
      method: "DELETE",
      url: `/vault${encodedPath}`, // Construct URL correctly
    },
    context,
    "deleteFile",
  );
}

/**
 * Lists files within a specified directory in the vault.
 * @param _request - The internal request function from the service instance.
 * @param dirPath - Vault-relative path to the directory. Use empty string "" or "/" for the root.
 * @param context - Request context.
 * @returns A list of file and directory names.
 */
export async function listFiles(
  _request: RequestFunction,
  dirPath: string,
  context: RequestContext,
): Promise<string[]> {
  // Normalize path: remove leading/trailing slashes for consistency, except for root
  let pathSegment = dirPath.trim();

  // Explicitly handle root path variations ('', '/') by setting pathSegment to empty.
  // This ensures that the final URL constructed later will be '/vault/', which the API
  // uses to list the root directory contents.
  if (pathSegment === "" || pathSegment === "/") {
    pathSegment = ""; // Use empty string to signify root for URL construction
  } else {
    // For non-root paths:
    // 1. Remove any leading/trailing slashes to prevent issues like '/vault//path/' or '/vault/path//'.
    // 2. URI-encode *each component* of the remaining path segment to handle special characters safely.
    pathSegment = pathSegment
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
  }

  // Construct the final URL for the API request:
  // - If pathSegment is not empty (i.e., it's a specific directory), format as '/vault/{encoded_path}/'.
  // - If pathSegment IS empty (signifying the root), format as '/vault/'.
  // The trailing slash is important for directory listing endpoints in this API.
  const url = pathSegment ? `/vault/${pathSegment}/` : "/vault/";

  const response = await _request<FileListResponse>(
    {
      method: "GET",
      url: url, // Use the correctly constructed URL
    },
    context,
    "listFiles",
  );
  return response.files;
}

/**
 * Gets the metadata (stat) of a specific file using a lightweight HEAD request.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param context - Request context.
 * @returns The file's metadata.
 */
export async function getFileMetadata(
  _request: RequestFunction,
  filePath: string,
  context: RequestContext,
): Promise<NoteStat | null> {
  const encodedPath = encodeVaultPath(filePath);
  try {
    const response = await _request<any>(
      {
        method: "HEAD",
        url: `/vault${encodedPath}`,
      },
      context,
      "getFileMetadata",
    );

    if (response && response.headers) {
      const headers = response.headers;
      return {
        mtime: headers["x-obsidian-mtime"]
          ? parseFloat(headers["x-obsidian-mtime"]) * 1000
          : 0,
        ctime: headers["x-obsidian-ctime"]
          ? parseFloat(headers["x-obsidian-ctime"]) * 1000
          : 0,
        size: headers["content-length"]
          ? parseInt(headers["content-length"], 10)
          : 0,
      };
    }
    return null;
  } catch (error) {
    // Errors are already logged by the _request function, so we can just return null
    return null;
  }
}
