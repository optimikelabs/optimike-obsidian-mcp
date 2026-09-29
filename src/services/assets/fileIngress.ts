import axios from "axios";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { operationDigest } from "../operations/contract.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { ASSET_SOURCE_MAX_BYTES } from "./imageProcessing.js";
import { assetHash } from "./windowsAssetFiles.js";
import {
  CHATGPT_FILE_ROOT_ID,
  type AssetFileParam,
  type AssetSource,
  type AssetSourceProvider,
} from "./assetImportContract.js";

export { CHATGPT_FILE_ROOT_ID } from "./assetImportContract.js";
const FILE_ID = /^file_[A-Za-z0-9_-]{6,240}$/u;

function deny(reason: string, code = BaseErrorCode.FORBIDDEN): never {
  throw new McpError(
    code,
    "The host-provided asset file could not be authorized or retrieved.",
    { reason },
  );
}
function blockedIpv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
    return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIp(address: string): boolean {
  if (net.isIPv4(address)) return blockedIpv4(address);
  if (!net.isIPv6(address)) return true;
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) {
    return blockedIpv4(value.slice("::ffff:".length));
  }
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/u.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8")
  );
}
export function validateAssetFileDownloadUrl(
  raw: string,
  allowedHosts: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    deny("asset_file_url_invalid", BaseErrorCode.VALIDATION_ERROR);
  }
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const normalizedHost = hostname.toLowerCase();
  const allowed = new Set(allowedHosts.map((value) => value.toLowerCase()));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    normalizedHost === "localhost" ||
    net.isIP(hostname) !== 0 ||
    !allowed.has(normalizedHost)
  ) {
    deny(
      allowed.has(normalizedHost)
        ? "asset_file_url_forbidden"
        : "asset_file_host_not_allowed",
    );
  }
  return url;
}

const publicHttpsAgent = new https.Agent({
  lookup: (hostname, _options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 4);
        return;
      }
      if (!addresses.length || addresses.some((item) => blockedIp(item.address))) {
        callback(new Error("asset_file_host_forbidden"), "", 4);
        return;
      }
      const selected = addresses[0];
      callback(null, selected.address, selected.family);
    });
  },
});
type DownloadedFile = { bytes: Buffer; contentType?: string };
export type AssetFileDownloader = (url: URL) => Promise<DownloadedFile>;

async function downloadHttpsFile(url: URL): Promise<DownloadedFile> {
  try {
    const response = await axios.request<ArrayBuffer>({
      method: "GET",
      url: url.toString(),
      responseType: "arraybuffer",
      maxRedirects: 0,
      timeout: 15_000,
      maxContentLength: ASSET_SOURCE_MAX_BYTES,
      maxBodyLength: ASSET_SOURCE_MAX_BYTES,
      proxy: false,
      httpsAgent: publicHttpsAgent,
      headers: { Accept: "image/*,application/octet-stream" },
      validateStatus: (status) => status === 200,
    });
    const bytes = Buffer.from(response.data);
    if (!bytes.length || bytes.length > ASSET_SOURCE_MAX_BYTES) {
      deny("asset_file_size_invalid", BaseErrorCode.VALIDATION_ERROR);
    }
    const contentType =
      typeof response.headers["content-type"] === "string"
        ? response.headers["content-type"].split(";")[0].trim().toLowerCase()
        : undefined;
    if (
      contentType &&
      !contentType.startsWith("image/") &&
      contentType !== "application/octet-stream"
    ) {
      deny("asset_file_content_type_invalid", BaseErrorCode.VALIDATION_ERROR);
    }
    return { bytes, contentType };
  } catch (error) {
    if (error instanceof McpError) throw error;
    deny("asset_file_download_failed", BaseErrorCode.SERVICE_UNAVAILABLE);
  }
}
export class AssetFileIngress {
  private readonly allowedHosts: readonly string[];
  private readonly policyDigest: string;

  constructor(
    private readonly enabled: boolean,
    allowedHosts: readonly string[],
    private readonly downloader: AssetFileDownloader = downloadHttpsFile,
  ) {
    this.allowedHosts = Object.freeze(
      [...new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort(),
    );
    this.policyDigest = operationDigest({
      version: 1,
      kind: "chatgpt_file_param",
      httpsOnly: true,
      redirects: 0,
      maxBytes: ASSET_SOURCE_MAX_BYTES,
      allowedHosts: this.allowedHosts,
    });
  }

  isEnabled(): boolean {
    return this.enabled && this.allowedHosts.length > 0;
  }

  isReference(source: AssetSource): boolean {
    return source.rootId === CHATGPT_FILE_ROOT_ID;
  }

  authorizeReference(source: AssetSource): string {
    if (!this.isEnabled()) deny("asset_file_ingress_disabled");
    if (
      source.rootId !== CHATGPT_FILE_ROOT_ID ||
      !FILE_ID.test(source.relativePath)
    ) {
      deny("asset_file_reference_invalid", BaseErrorCode.VALIDATION_ERROR);
    }
    return this.policyDigest;
  }

  async materialize(file: AssetFileParam): Promise<{
    source: AssetSource;
    provider: AssetSourceProvider;
    contentType?: string;
  }> {
    if (!this.isEnabled()) deny("asset_file_ingress_disabled");
    if (!FILE_ID.test(file.file_id)) {
      deny("asset_file_id_invalid", BaseErrorCode.VALIDATION_ERROR);
    }
    if (file.mime_type && !file.mime_type.toLowerCase().startsWith("image/")) {
      deny("asset_file_mime_invalid", BaseErrorCode.VALIDATION_ERROR);
    }
    const url = validateAssetFileDownloadUrl(
      file.download_url,
      this.allowedHosts,
    );
    const downloaded = await this.downloader(url);
    const bytes = Buffer.from(downloaded.bytes);
    const source: AssetSource = {
      rootId: CHATGPT_FILE_ROOT_ID,
      relativePath: file.file_id,
      sha256: assetHash(bytes),
    };
    const provider: AssetSourceProvider = {
      authorize: (candidate) => {
        if (
          candidate.rootId !== source.rootId ||
          candidate.relativePath !== source.relativePath ||
          candidate.sha256 !== source.sha256
        ) {
          deny("asset_file_reference_changed", BaseErrorCode.CONFLICT);
        }
        return this.authorizeReference(candidate);
      },
      read: async (candidate) => {
        provider.authorize(candidate);
        return Buffer.from(bytes);
      },
    };
    return { source, provider, contentType: downloaded.contentType };
  }
}
