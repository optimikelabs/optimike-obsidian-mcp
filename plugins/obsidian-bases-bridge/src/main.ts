import type { LocalRestApiPublicApi } from "obsidian-local-rest-api";
import { describeRestRoutes } from "../../shared/restOpenApi";
import { createHash, randomUUID } from "node:crypto";
import {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  apiVersion,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import {
  EngineRequestError,
  evaluateBaseFormulas,
  parseEvaluateRequest,
  queryBaseViewWithEngine,
  unavailableEvaluation,
} from "./engine-evaluate.mjs";
import {
  createFunctionRegistry,
  unavailableRegistry,
} from "./function-registry.mjs";
import {
  compareFilterValues,
  isTruthyFilterReference,
  isTruthyFilterValue,
  parseComparisonLiteral,
} from "./filter-comparison.mjs";
import { normalizeLinkish } from "./link-normalization.mjs";
import { baseQuerySnapshot } from "./base-query-snapshot.mjs";
import {
  BASE_ATOMIC_CONTRACT_VERSION,
  BASE_ATOMIC_REST_PREFIX,
  BaseBindingConflictError,
  BaseHashConflictError,
  assertBaseBinding,
  compareAndReplaceBase,
  parseBaseCasRequest,
  parseBaseReadRequest,
  sha256,
} from "./atomic-contract.mjs";
import {
  RestExtensionLifecycle,
  RestExtensionPartialMountError,
} from "../../shared/restExtensionLifecycle.js";

/** -------- Engine V2 (flag + cache) -------- */
type EngineRow = Record<string, any>;
type EngineSnap = { ts: number; rows: EngineRow[]; total: number };
const ENGINE_CACHE = new Map<string, EngineSnap>();

interface BridgeSettings {
  engineEnabled: boolean;
  instanceId: string;
  allowAtomicBaseWrites: boolean;
  allowLegacyConfigWrites: boolean;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  engineEnabled: false,
  instanceId: "",
  allowAtomicBaseWrites: false,
  allowLegacyConfigWrites: false,
};
const VIEW_TYPE = "bases-bridge-headless";
const EXTENSION_ID = "obsidian-bases-bridge";
const REST_PREFIX = `/extensions/${EXTENSION_ID}`;

function normBaseId(id: string): string {
  if (!id) return "";
  try {
    id = decodeURIComponent(id);
  } catch {}
  return id.replace(/\\/g, "/");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanupOf(disposable: any): () => void {
  if (!disposable) return () => {};
  if (typeof disposable === "function") return disposable;
  if (disposable?.dispose) return () => disposable.dispose();
  if (disposable?.unregister) return () => disposable.unregister();
  if (disposable?.unload) return () => disposable.unload();
  return () => {};
}

type BaseSummary = { id: string; name: string; path: string };
type BasesListResponse = { bases: BaseSummary[] };
type BaseConfigResponse = {
  id: string;
  yaml: string;
  json?: Record<string, any>;
};
type BaseConfigUpsertRequest = {
  yaml?: string;
  json?: Record<string, any>;
  validateOnly?: boolean;
};
type BaseConfigUpsertResponse = {
  ok: boolean;
  id: string;
  warnings?: string[];
};

function responseStatus(res: any, status: number): any {
  if (typeof res?.status === "function") return res.status(status);
  if (res && "statusCode" in res) res.statusCode = status;
  return res;
}

function sendJson(res: any, status: number, payload: unknown): void {
  const target = responseStatus(res, status);
  if (typeof target?.json !== "function") {
    throw new Error("Local REST API response does not expose json().");
  }
  target.json(publicBaseHttpFailurePayload(payload));
}

type LegacyBaseRouteHandler = (
  req: any,
  res: any,
) => unknown | Promise<unknown>;

/**
 * Values arriving at an HTTP boundary are untrusted, including values thrown by
 * host/plugin code.  A revoked Proxy or a throwing getter must be treated as
 * absent: reading it must never make our redaction path throw (or fall through
 * to Local REST's serializer).
 */
function safeProperty(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeArray(value: unknown): unknown[] | undefined {
  try {
    return Array.isArray(value) ? Array.from(value) : undefined;
  } catch {
    return undefined;
  }
}

function safeArrayItems(value: unknown): unknown[] {
  return safeArray(value) ?? [];
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return Array.isArray(value) ? undefined : (value as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function safeStringProperty(value: unknown, key: string): string | undefined {
  const candidate = safeProperty(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function safeNumberProperty(value: unknown, key: string): number | undefined {
  const candidate = safeProperty(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function safeBooleanProperty(
  value: unknown,
  key: string,
): boolean | undefined {
  const candidate = safeProperty(value, key);
  return typeof candidate === "boolean" ? candidate : undefined;
}

function isBaseBindingConflict(error: unknown): boolean {
  try {
    return error instanceof BaseBindingConflictError;
  } catch {
    return false;
  }
}

function isBaseHashConflict(error: unknown): boolean {
  try {
    return error instanceof BaseHashConflictError;
  } catch {
    return false;
  }
}

function isBaseNotFoundError(error: unknown): boolean {
  const message = safeStringProperty(error, "message");
  return (
    message === "Base not found." ||
    (typeof message === "string" && message.startsWith("Base introuvable:"))
  );
}

/**
 * Local REST's extension router does not install a value-safe error boundary for
 * plugin routes. Keep legacy success payloads untouched, but ensure a thrown
 * Vault/engine error can never fall through to the host's undocumented error
 * serializer.
 */
export function withPublicLegacyBaseBoundary(
  handler: LegacyBaseRouteHandler,
): LegacyBaseRouteHandler {
  return async (req: any, res: any) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (safeProperty(res, "headersSent") || safeProperty(res, "writableEnded")) {
        return;
      }
      if (isBaseBindingConflict(error)) {
        sendJson(res, 409, atomicError("binding_conflict"));
        return;
      }
      if (isBaseHashConflict(error)) {
        sendJson(
          res,
          409,
          atomicError("hash_conflict", undefined, {
            actualSha256: safeStringProperty(error, "actualSha256"),
          }),
        );
        return;
      }
      const notFound = isBaseNotFoundError(error);
      sendJson(
        res,
        notFound ? 404 : 500,
        atomicError(notFound ? "base_not_found" : "read_error"),
      );
    }
  };
}

type BasePublicErrorDescriptor = {
  code: string;
  reasonCode: string;
  status: "blocked" | "conflict" | "not_found" | "rejected";
  retryable: false;
  message: string;
};

const BASE_PUBLIC_ERRORS: Record<string, BasePublicErrorDescriptor> = {
  invalid_request: {
    code: "invalid_request",
    reasonCode: "request_rejected",
    status: "rejected",
    retryable: false,
    message: "The request could not be validated.",
  },
  base_not_found: {
    code: "base_not_found",
    reasonCode: "resource_not_found",
    status: "not_found",
    retryable: false,
    message: "The requested Base was not found.",
  },
  writes_disabled: {
    code: "writes_disabled",
    reasonCode: "write_not_authorized",
    status: "blocked",
    retryable: false,
    message: "Atomic Base writes are disabled.",
  },
  binding_conflict: {
    code: "binding_conflict",
    reasonCode: "backend_binding_changed",
    status: "conflict",
    retryable: false,
    message:
      "The sealed backend binding no longer matches. Refresh status before retrying.",
  },
  hash_conflict: {
    code: "hash_conflict",
    reasonCode: "resource_changed",
    status: "conflict",
    retryable: false,
    message:
      "The Base changed after it was read. Read it again before retrying.",
  },
  write_timeout: {
    code: "write_timeout",
    reasonCode: "write_timeout",
    status: "rejected",
    retryable: false,
    message:
      "The Base write did not complete. Verify the current state before retrying.",
  },
  write_error: {
    code: "write_error",
    reasonCode: "write_failed",
    status: "rejected",
    retryable: false,
    message: "The Base write could not be completed.",
  },
  read_error: {
    code: "read_error",
    reasonCode: "read_failed",
    status: "rejected",
    retryable: false,
    message: "The Base could not be read.",
  },
  forbidden_key: {
    code: "forbidden_key",
    reasonCode: "field_not_authorized",
    status: "rejected",
    retryable: false,
    message: "The request includes a protected Base field.",
  },
  serialization_error: {
    code: "serialization_error",
    reasonCode: "serialization_failed",
    status: "rejected",
    retryable: false,
    message: "The Base specification could not be serialized.",
  },
};

function safeAtomicErrorDetails(
  details: unknown,
): { actualSha256: string } | undefined {
  if (!safeRecord(details)) return undefined;
  const actualSha256 = safeStringProperty(details, "actualSha256");
  return typeof actualSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(actualSha256)
    ? { actualSha256 }
    : undefined;
}

export function publicBaseAtomicErrorPayload(
  code: string,
  _message?: unknown,
  details?: unknown,
) {
  const requestedCode = typeof code === "string" ? code : "";
  const descriptor =
    BASE_PUBLIC_ERRORS[requestedCode] ?? BASE_PUBLIC_ERRORS.invalid_request;
  const safeDetails = safeAtomicErrorDetails(details);
  return {
    ok: false,
    contractVersion: BASE_ATOMIC_CONTRACT_VERSION,
    status: descriptor.status,
    retryable: descriptor.retryable,
    error: {
      code: descriptor.code,
      reasonCode: descriptor.reasonCode,
      message: descriptor.message,
      ...(safeDetails ? { details: safeDetails } : {}),
    },
  };
}

const atomicError = publicBaseAtomicErrorPayload;

type LegacyUpsertErrorDescriptor = {
  code: string;
  message: string;
  retryable: boolean;
};

const LEGACY_UPSERT_ERRORS: Record<string, LegacyUpsertErrorDescriptor> = {
  validation_error: {
    code: "validation_error",
    message: "The Base row operation could not be validated.",
    retryable: false,
  },
  not_found: {
    code: "not_found",
    message: "The requested note was not found.",
    retryable: false,
  },
  mtime_conflict: {
    code: "mtime_conflict",
    message:
      "The note changed after it was read. Read it again before retrying.",
    retryable: false,
  },
  forbidden_key: {
    code: "forbidden_key",
    message: "The request includes a protected Base field.",
    retryable: false,
  },
  write_timeout: {
    code: "write_timeout",
    message:
      "The Base write did not complete. Verify the current state before retrying.",
    retryable: true,
  },
  write_error: {
    code: "write_error",
    message: "The Base write could not be completed.",
    retryable: false,
  },
};

function publicLegacyUpsertFailurePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const results = safeArrayItems(safeProperty(payload, "results"));
  return {
    ok: false,
    results: results.map((result) => {
      const item = safeRecord(result);
      if (!item) {
        return {
          mtime: 0,
          error: {
            code: "write_error",
            message: LEGACY_UPSERT_ERRORS.write_error.message,
            retryable: false,
          },
        };
      }
      const rawError = safeRecord(safeProperty(item, "error"));
      if (!rawError) {
        const safe: Record<string, unknown> = {};
        const mtime = safeNumberProperty(item, "mtime");
        if (mtime !== undefined) {
          safe.mtime = mtime;
        }
        const changed = safeRecord(safeProperty(item, "changed"));
        if (changed) {
          const keys = safeArrayItems(safeProperty(changed, "keys")).filter(
            (key) => typeof key === "string",
          );
          const unset = safeArrayItems(safeProperty(changed, "unset")).filter(
            (key) => typeof key === "string",
          );
          safe.changed = {
            keys,
            ...(unset.length > 0 ? { unset } : {}),
          };
        }
        const warnings = safeArrayItems(safeProperty(item, "warnings"));
        if (warnings.length > 0 && warnings.every((warning) => warning === "dry_run_no_write")) {
          safe.warnings = ["dry_run_no_write"];
        }
        return safe;
      }
      const descriptor =
        LEGACY_UPSERT_ERRORS[safeStringProperty(rawError, "code") ?? ""] ??
        LEGACY_UPSERT_ERRORS.write_error;
      const safe: Record<string, unknown> = {
        mtime: safeNumberProperty(item, "mtime") ?? 0,
        error: {
          code: descriptor.code,
          message: descriptor.message,
          retryable: descriptor.retryable,
        },
      };
      const warnings = safeArrayItems(safeProperty(item, "warnings"));
      if (warnings.length > 0 && warnings.every((warning) => warning === "dry_run_no_write")) {
        safe.warnings = ["dry_run_no_write"];
      }
      return safe;
    }),
  };
}

const LEGACY_BASE_FAILURE_WARNINGS = new Map<string, string>([
  [
    "YAML invalide: root doit être un objet.",
    "The Base YAML root must be an object.",
  ],
  ["Payload requis: yaml ou json.", "A YAML or JSON payload is required."],
  ["path requis.", "A Base path is required."],
  ["spec doit être un objet.", "The Base specification must be an object."],
  [
    "The Base specification could not be serialized.",
    "The Base specification could not be serialized.",
  ],
  [
    "Legacy whole-file Base writes are disabled. Use the governed atomic Base operation.",
    "Legacy whole-file Base writes are disabled. Use the governed atomic Base operation.",
  ],
  [
    "Legacy Base creation and replacement are disabled. Enable the explicit compatibility toggle to use this route.",
    "Legacy Base creation and replacement are disabled. Enable the explicit compatibility toggle to use this route.",
  ],
]);

function safeLegacyBaseId(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024) return "";
  const normalized = value.replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:\//iu.test(normalized) ||
    !normalized.toLowerCase().endsWith(".base")
  ) {
    return "";
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
    segments[0]?.toLowerCase() === ".obsidian"
  ) {
    return "";
  }
  return normalized;
}

function publicLegacyConfigFailurePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const rawWarnings = safeArrayItems(safeProperty(payload, "warnings"));
  const warnings = rawWarnings.map((warning) =>
    typeof warning === "string"
      ? (LEGACY_BASE_FAILURE_WARNINGS.get(warning) ??
        "The Base operation could not be completed.")
      : "The Base operation could not be completed.",
  );
  const created = safeBooleanProperty(payload, "created");
  const overwritten = safeBooleanProperty(payload, "overwritten");
  return {
    ok: false,
    id: safeLegacyBaseId(safeProperty(payload, "id")),
    warnings:
      warnings.length > 0
        ? warnings
        : ["The Base operation could not be completed."],
    ...(created !== undefined ? { created } : {}),
    ...(overwritten !== undefined ? { overwritten } : {}),
  };
}

/** Normalizes every non-throwing REST failure before it reaches HTTP. */
export function publicBaseHttpFailurePayload(payload: unknown): unknown {
  const record = safeRecord(payload);
  if (!record) {
    return publicBaseAtomicErrorPayload("invalid_request");
  }
  const ok = safeProperty(record, "ok");
  if (ok === true) return payload;
  if (ok !== false) return publicBaseAtomicErrorPayload("invalid_request");
  if (safeArray(safeProperty(record, "results")) !== undefined) {
    return publicLegacyUpsertFailurePayload(record);
  }
  if (
    safeProperty(record, "id") !== undefined &&
    safeArray(safeProperty(record, "warnings")) !== undefined &&
    safeProperty(record, "error") === undefined
  ) {
    return publicLegacyConfigFailurePayload(record);
  }
  const rawError = safeRecord(safeProperty(record, "error"));
  const requestedCode = safeStringProperty(rawError, "code") ?? "invalid_request";
  const rawDetails = safeRecord(safeProperty(rawError, "details"));
  return publicBaseAtomicErrorPayload(requestedCode, undefined, rawDetails);
}
type BaseCreateRequest = {
  path: string;
  spec: Record<string, any>;
  overwrite?: boolean;
  validateOnly?: boolean;
};
type BaseCreateResponse = {
  ok: boolean;
  id: string;
  warnings?: string[];
  created?: boolean;
  overwritten?: boolean;
};
type BaseSchemaProperty = {
  key: string;
  kind: "note" | "file" | "formula" | "unknown";
  displayName?: string;
  valueType?: string;
};
type BaseSchemaView = {
  name: string;
  type: string;
  limit?: number;
  order?: string[];
  filters?: any;
  description?: string;
};
type BaseSchemaResponse = {
  id: string;
  path: string;
  name?: string;
  properties: BaseSchemaProperty[];
  formulas?: Record<string, any>;
  views: BaseSchemaView[];
  filters?: any;
};
type BaseQueryRequest = {
  view?: string;
  filter?: any;
  sort?: Array<{ prop: string; dir?: "asc" | "desc" }>;
  limit?: number;
  page?: number;
  evaluate?: boolean;
};
type BaseQueryRow = {
  file: { path: string; name: string };
  props: Record<string, any>;
  computed?: Record<string, string | null>;
};
type QueryCandidateRow = {
  file: TFile;
  values?: Record<string, string | null>;
};

/** True when a filter tree references a formula, which only the engine computes. */
function filterMentionsFormula(filter: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof filter === "string") return /(^|[^\w.])formula\./u.test(filter);
  if (Array.isArray(filter)) {
    return filter.some((part) => filterMentionsFormula(part, depth + 1));
  }
  if (filter && typeof filter === "object") {
    return Object.values(filter).some((part) =>
      filterMentionsFormula(part, depth + 1),
    );
  }
  return false;
}
type BaseQueryResponse = {
  baseSnapshot?: ReturnType<typeof baseQuerySnapshot>;
  total: number;
  page: number;
  rows: BaseQueryRow[];
  evaluate?: boolean;
  source?: "engine" | "fallback";
  warnings?: string[];
};
type BaseUpsertOperation = {
  file: string;
  set?: Record<string, any>;
  unset?: string[];
  expected_mtime?: number;
};
type BaseUpsertRequest = {
  operations: BaseUpsertOperation[];
  continueOnError?: boolean;
  dryRun?: boolean;
};
type BaseUpsertResult = {
  file: string;
  mtime: number;
  changed?: { keys: string[]; unset?: string[] };
  warnings?: string[];
  error?: { code: string; message: string };
};
type BaseUpsertResponse = { ok: boolean; results: BaseUpsertResult[] };

const PROTECTED_UPSERT_KEYS = new Set(["création", "creation", "modification"]);

function isForbiddenUpsertKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized.startsWith("file.") ||
    normalized.startsWith("formula.") ||
    PROTECTED_UPSERT_KEYS.has(normalized)
  );
}

function validateUpsertKeys(
  setObj: Record<string, any>,
  unsetArr: string[],
): string[] {
  return [...Object.keys(setObj), ...unsetArr].filter(isForbiddenUpsertKey);
}

function classifyWriteError(error: any): {
  code: string;
  message: string;
  warnings?: string[];
} {
  const message = safeStringProperty(error, "message");
  if (
    typeof message === "string" &&
    /processFrontMatter.*timed out|timed out|timeout/i.test(message)
  ) {
    return {
      code: "write_timeout",
      message:
        "The Base write did not complete. Verify the current state before retrying.",
      warnings: [
        "The write did not complete. Verify the current state before retrying.",
      ],
    };
  }
  return {
    code: "write_error",
    message: "The Base write could not be completed.",
  };
}

function ensureBaseExt(path: string): string {
  const normalized = normBaseId(path);
  return normalized.endsWith(".base") ? normalized : `${normalized}.base`;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "" : normalized.slice(0, idx);
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitOutsideQuotes(input: string, needle: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const prev = i > 0 ? input[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;

    if (!inSingle && !inDouble && input.startsWith(needle, i)) {
      parts.push(current);
      current = "";
      i += needle.length - 1;
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseStringListLiteral(inner: string): string[] {
  const parts = splitOutsideQuotes(inner, ",");
  const values: string[] = [];
  for (const part of parts) {
    const v = stripQuotes(part.trim());
    if (v) values.push(v);
  }
  return values;
}

export default class BasesBridgePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  private headlessMounted = false;
  private headlessRegistrationCollector:
    | ((cleanup: () => void) => void)
    | null = null;
  private bindingFingerprint = "";
  private restLifecycle: RestExtensionLifecycle<object> | null = null;
  private headlessLifecycle: RestExtensionLifecycle<object> | null = null;

  register(cleanup: () => void): void {
    const collector = this.headlessRegistrationCollector;
    if (collector) {
      collector(cleanup);
      return;
    }
    super.register(cleanup);
  }

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.instanceId) this.settings.instanceId = randomUUID();
    const deviceStorageKey = "optimike-bases-bridge:device-id";
    let deviceId = window.localStorage.getItem(deviceStorageKey);
    if (!deviceId) {
      deviceId = randomUUID();
      window.localStorage.setItem(deviceStorageKey, deviceId);
    }
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const basePath = adapter.getBasePath?.();
    if (!basePath) {
      throw new Error(
        "Bases Bridge atomic writes require a desktop filesystem vault identity.",
      );
    }
    this.bindingFingerprint = createHash("sha256")
      .update(`${deviceId}\0${this.settings.instanceId}\0${basePath}`, "utf8")
      .digest("hex");
    await this.saveSettings();
    this.addSettingTab(new BridgeSettingsTab(this.app, this));

    (this as any).setEngineEnabled = async (on: boolean) => {
      this.settings.engineEnabled = !!on;
      await this.saveData(this.settings);
      console.log("[bases-bridge] Engine setting updated.");
      if (this.settings.engineEnabled) {
        this.maybeRegisterHeadlessView();
      } else {
        this.stopHeadlessLifecycle();
      }
    };
    (this as any).getEngineState = () => ({
      engineEnabled: this.settings.engineEnabled,
      cacheSize: ENGINE_CACHE.size,
      keys: Array.from(ENGINE_CACHE.keys()),
    });

    this.addCommand({
      id: "engine-on",
      name: "Bases Bridge: Engine ON",
      callback: () => (this as any).setEngineEnabled(true),
    });
    this.addCommand({
      id: "engine-off",
      name: "Bases Bridge: Engine OFF",
      callback: () => (this as any).setEngineEnabled(false),
    });
    this.addCommand({
      id: "engine-state",
      name: "Bases Bridge: Show engine state",
      callback: () => console.log("[bases-bridge] Engine state requested."),
    });

    // Important: ne tente pas de monter l'engine tant qu'il n'est pas explicitement activé.
    // Ça réduit drastiquement les risques de crash/instabilité côté Obsidian.
    if (this.settings.engineEnabled) {
      this.maybeRegisterHeadlessView();
    }

    const onVaultMutation = (path: string) => {
      if (!path) return;
      if (path.endsWith(".base")) {
        this.invalidateEngineCache(path);
        return;
      }
      if (path.endsWith(".md")) {
        this.invalidateEngineCache();
      }
    };
    this.registerEvent(
      this.app.vault.on("modify", (file: any) =>
        onVaultMutation(String(file?.path ?? "")),
      ),
    );
    this.registerEvent(
      this.app.vault.on("create", (file: any) =>
        onVaultMutation(String(file?.path ?? "")),
      ),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: any) =>
        onVaultMutation(String(file?.path ?? "")),
      ),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file: any, oldPath: string) => {
        onVaultMutation(String(oldPath ?? ""));
        onVaultMutation(String(file?.path ?? ""));
      }),
    );

    this.registerRestExtension().catch(() => {
      console.error("[bases-bridge] REST extension registration failed.");
    });
  }

  onunload(): void {
    this.stopHeadlessLifecycle();
    this.restLifecycle?.stop();
    this.restLifecycle = null;
    console.log("[bases-bridge] unloaded");
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private baseFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "base") {
      throw new Error("Base not found.");
    }
    return file;
  }

  private maybeRegisterHeadlessView(): void {
    if (this.headlessLifecycle) {
      this.headlessLifecycle.start();
      return;
    }
    this.headlessLifecycle = new RestExtensionLifecycle({
      probe: () => {
        const selfRegister: any = (this as any).registerBasesView;
        const coreBases = (this.app as any).internalPlugins
          ?.getEnabledPluginById?.("bases");
        if (
          typeof selfRegister === "function" &&
          coreBases &&
          typeof coreBases === "object"
        ) {
          // Plugin.registerBasesView() resolves this exact enabled core
          // provider internally. Its object/registry survives a fast OFF/ON;
          // a genuine provider replacement changes the lifecycle fence.
          return coreBases;
        }
        const basesPlugin =
          (this.app as any).plugins?.plugins?.bases ??
          (this.app as any).plugins?.plugins?.["obsidian-bases"] ??
          (this.app as any).plugins?.getPlugin?.("bases") ??
          (this.app as any).plugins?.getPlugin?.("obsidian-bases");
        const basesApi: any =
          basesPlugin?.api ??
          (this.app as any).bases ??
          (this.app as any).plugins?.api?.bases;
        return typeof basesApi?.registerBasesView === "function"
          ? basesApi
          : null;
      },
      mount: (provider: any) => {
        const selfRegister: any = (this as any).registerBasesView;
        const activeCoreBases = (this.app as any).internalPlugins
          ?.getEnabledPluginById?.("bases");
        let cleanup: (() => void) | null = null;
        if (
          typeof selfRegister === "function" &&
          provider === activeCoreBases
        ) {
          cleanup = this.registerHeadlessThroughPublicApi(selfRegister);
        } else {
          const registration = provider.registerBasesView(
            this,
            VIEW_TYPE,
            this.makeHeadlessSpec(),
          );
          if (registration === false) return null;
          cleanup = cleanupOf(registration);
        }
        if (!cleanup) return null;
        this.headlessMounted = true;
        console.log("[bases-bridge] Headless view mounted.");
        return () => {
          cleanup();
          this.headlessMounted = false;
        };
      },
      onCleanupError: () =>
        console.warn("[bases-bridge] Headless view cleanup failed."),
    });
    this.register(() => {
      this.stopHeadlessLifecycle();
    });
    this.headlessLifecycle.start();
  }

  private registerHeadlessThroughPublicApi(
    registerBasesView: (viewType: string, spec: unknown) => boolean,
  ): (() => void) | null {
    let capturedCleanup: (() => void) | null = null;
    this.headlessRegistrationCollector = (cleanup) => {
      if (capturedCleanup) {
        throw new Error("Bases view registration returned multiple cleanups.");
      }
      capturedCleanup = cleanup;
    };
    try {
      const accepted = registerBasesView.call(
        this,
        VIEW_TYPE,
        this.makeHeadlessSpec(),
      );
      if (!accepted) {
        if (capturedCleanup) {
          throw new RestExtensionPartialMountError(capturedCleanup);
        }
        return null;
      }
      if (!capturedCleanup) {
        throw new Error("Bases view registration did not expose cleanup.");
      }
      return capturedCleanup;
    } catch (error) {
      if (capturedCleanup) {
        throw new RestExtensionPartialMountError(capturedCleanup);
      }
      throw error;
    } finally {
      this.headlessRegistrationCollector = null;
    }
  }

  private stopHeadlessLifecycle(): void {
    const lifecycle = this.headlessLifecycle;
    if (!lifecycle) {
      this.headlessMounted = false;
      return;
    }
    lifecycle.stop();
    if (lifecycle.snapshot().state !== "degraded") {
      this.headlessLifecycle = null;
      this.headlessMounted = false;
    }
  }

  private makeHeadlessSpec() {
    return {
      name: "Bridge (Headless)",
      icon: "plug-zap",
      factory: (controller: any, _containerEl: HTMLElement) => {
        const basePath =
          controller?.config?.path ??
          controller?.base?.path ??
          controller?.file?.path ??
          "";
        const id = normBaseId(basePath);

        const sync = () => {
          if (!this.settings.engineEnabled) return;
          try {
            const data = controller?.data;
            const entries =
              data?.entries ?? data?.rows ?? data?.table?.rows ?? [];
            const rows: EngineRow[] = [];
            for (const entry of entries)
              rows.push(entry?.values ?? entry?.row ?? entry ?? {});
            ENGINE_CACHE.set(id, { ts: Date.now(), rows, total: rows.length });
          } catch {
            console.error("[bases-bridge] Engine synchronization failed.");
          }
        };

        try {
          controller?.onDataUpdated?.(sync);
        } catch {}
        try {
          sync();
        } catch {}
        return { unload() {} };
      },
    };
  }

  private invalidateEngineCache(baseId?: string): void {
    if (baseId) {
      ENGINE_CACHE.delete(ensureBaseExt(baseId));
      return;
    }
    ENGINE_CACHE.clear();
  }

  private async readBaseConfig(baseId: string): Promise<{
    id: string;
    file: TFile;
    yaml: string;
    json: Record<string, any>;
    snapshot: ReturnType<typeof baseQuerySnapshot>;
  }> {
    const path = ensureBaseExt(baseId);
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      throw new Error(`Base introuvable: ${path}`);
    }
    const binding = this.bindingFingerprint;
    const yaml = await this.app.vault.read(abstract);
    if (binding !== this.bindingFingerprint) throw new Error("Base generation changed during read");
    const jsonRaw = parseYaml(yaml);
    const json =
      jsonRaw && typeof jsonRaw === "object" && !Array.isArray(jsonRaw)
        ? (jsonRaw as Record<string, any>)
        : {};

    return { id: path, file: abstract, yaml, json, snapshot: baseQuerySnapshot(path, yaml, binding) };
  }

  private async ensureFoldersFor(path: string): Promise<void> {
    const dir = dirname(path);
    if (!dir) return;
    const parts = dir.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing) continue;
      await this.app.vault.createFolder(current).catch(() => {});
    }
  }

  private extractSchema(
    basePath: string,
    spec: Record<string, any>,
  ): BaseSchemaResponse {
    const propertiesValue = spec.properties;
    const formulasValue = spec.formulas;
    const viewsValue = spec.views;

    const properties: BaseSchemaProperty[] = [];
    if (
      propertiesValue &&
      typeof propertiesValue === "object" &&
      !Array.isArray(propertiesValue)
    ) {
      for (const [key, value] of Object.entries(propertiesValue)) {
        const displayName =
          value && typeof value === "object" && !Array.isArray(value)
            ? ((value as any).name ?? (value as any).label)
            : undefined;
        const valueType =
          value && typeof value === "object" && !Array.isArray(value)
            ? ((value as any).type ?? (value as any).valueType)
            : undefined;
        const kind: BaseSchemaProperty["kind"] = key.startsWith("file.")
          ? "file"
          : "note";
        properties.push({ key, kind, displayName, valueType });
      }
    }

    if (
      formulasValue &&
      typeof formulasValue === "object" &&
      !Array.isArray(formulasValue)
    ) {
      for (const [key, value] of Object.entries(formulasValue)) {
        const displayName =
          value && typeof value === "object" && !Array.isArray(value)
            ? ((value as any).name ?? (value as any).label)
            : undefined;
        properties.push({
          key,
          kind: "formula",
          displayName,
          valueType: "formula",
        });
      }
    }

    const views: BaseSchemaView[] = [];
    if (Array.isArray(viewsValue)) {
      for (const view of viewsValue) {
        if (!view || typeof view !== "object" || Array.isArray(view)) continue;
        views.push({
          name: String((view as any).name ?? ""),
          type: String((view as any).type ?? "table"),
          limit:
            typeof (view as any).limit === "number"
              ? (view as any).limit
              : undefined,
          order: Array.isArray((view as any).order)
            ? ((view as any).order as any[]).map((v) => String(v))
            : Array.isArray((view as any).sort)
              ? ((view as any).sort as any[]).map((v) => String(v))
              : undefined,
          filters: (view as any).filters,
          description:
            typeof (view as any).description === "string"
              ? (view as any).description
              : undefined,
        });
      }
    }

    return {
      id: basePath,
      path: basePath,
      name: spec.name ? String(spec.name) : undefined,
      properties,
      formulas:
        formulasValue &&
        typeof formulasValue === "object" &&
        !Array.isArray(formulasValue)
          ? (formulasValue as any)
          : undefined,
      views,
      filters: spec.filters,
    };
  }

  private getFrontmatter(file: TFile): Record<string, any> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    return fm && typeof fm === "object" && !Array.isArray(fm)
      ? (fm as Record<string, any>)
      : {};
  }

  private getTagSet(file: TFile): Set<string> {
    const tags = new Set<string>();
    const cache = this.app.metadataCache.getFileCache(file);
    for (const t of cache?.tags ?? []) {
      const raw = typeof (t as any).tag === "string" ? (t as any).tag : "";
      const normalized = raw.startsWith("#") ? raw.slice(1) : raw;
      if (normalized) tags.add(normalized);
    }
    const fm = this.getFrontmatter(file);
    const fmTags = fm.tags;
    if (typeof fmTags === "string") {
      for (const t of fmTags
        .split(/[, ]+/)
        .map((x) => x.trim())
        .filter(Boolean)) {
        tags.add(t.startsWith("#") ? t.slice(1) : t);
      }
    } else if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === "string" && t.trim())
          tags.add(t.startsWith("#") ? t.slice(1) : t);
      }
    }
    return tags;
  }

  private fileHasLink(file: TFile, target: string): boolean {
    const want = target.trim();
    if (!want) return false;
    const cache = this.app.metadataCache.getFileCache(file);
    const links = cache?.links ?? [];
    const normalizedWant = want.replace(/\.md$/i, "");
    for (const link of links) {
      const raw =
        typeof (link as any).link === "string" ? (link as any).link : "";
      if (!raw) continue;
      const normalizedLink = raw.replace(/\.md$/i, "");
      if (normalizedLink === normalizedWant || raw === want) return true;
    }
    return false;
  }

  private getValueForRef(
    file: TFile,
    ref: string,
    schema?: BaseSchemaResponse,
    formulaValues?: Record<string, string | null>,
  ): any {
    const fm = this.getFrontmatter(file);
    const trimmed = ref.trim();
    if (trimmed.startsWith("file.")) {
      const key = trimmed.slice("file.".length);
      switch (key) {
        case "path":
          return file.path;
        case "name":
          return file.basename;
        case "ext":
          return file.extension;
        case "size":
          return file.stat.size;
        case "ctime":
          return file.stat.ctime;
        case "mtime":
          return file.stat.mtime;
        case "folder":
          return dirname(file.path);
        default:
          return undefined;
      }
    }

    if (trimmed.startsWith("note.")) {
      return fm[trimmed.slice("note.".length)];
    }

    // Formula values are computed only by Obsidian's engine (query route).
    if (trimmed.startsWith("formula.")) {
      return formulaValues?.[trimmed.slice("formula.".length)] ?? undefined;
    }

    return fm[trimmed];
  }

  private evaluateStatement(
    file: TFile,
    statement: string,
    schema?: BaseSchemaResponse,
    formulaValues?: Record<string, string | null>,
  ): { ok: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const raw = String(statement ?? "").trim();
    if (!raw) return { ok: true, warnings };

    // OR / AND at top-level (simple heuristic, split outside quotes).
    const orParts = splitOutsideQuotes(raw, " or ");
    if (orParts.length > 1) {
      let any = false;
      for (const part of orParts) {
        const res = this.evaluateStatement(file, part, schema, formulaValues);
        warnings.push(...res.warnings);
        if (res.ok) any = true;
      }
      return { ok: any, warnings };
    }
    const orParts2 = splitOutsideQuotes(raw, "||");
    if (orParts2.length > 1) {
      let any = false;
      for (const part of orParts2) {
        const res = this.evaluateStatement(file, part, schema, formulaValues);
        warnings.push(...res.warnings);
        if (res.ok) any = true;
      }
      return { ok: any, warnings };
    }

    const andParts = splitOutsideQuotes(raw, " and ");
    if (andParts.length > 1) {
      for (const part of andParts) {
        const res = this.evaluateStatement(file, part, schema, formulaValues);
        warnings.push(...res.warnings);
        if (!res.ok) return { ok: false, warnings };
      }
      return { ok: true, warnings };
    }
    const andParts2 = splitOutsideQuotes(raw, "&&");
    if (andParts2.length > 1) {
      for (const part of andParts2) {
        const res = this.evaluateStatement(file, part, schema, formulaValues);
        warnings.push(...res.warnings);
        if (!res.ok) return { ok: false, warnings };
      }
      return { ok: true, warnings };
    }

    // Unary not
    if (raw.startsWith("not ")) {
      const res = this.evaluateStatement(file, raw.slice(4), schema, formulaValues);
      warnings.push(...res.warnings);
      return { ok: !res.ok, warnings };
    }
    if (raw.startsWith("!")) {
      const res = this.evaluateStatement(file, raw.slice(1), schema, formulaValues);
      warnings.push(...res.warnings);
      return { ok: !res.ok, warnings };
    }

    // Built-in functions
    const hasTagMatch = raw.match(/^file\.hasTag\((.+)\)$/);
    if (hasTagMatch) {
      const tag = stripQuotes(hasTagMatch[1]);
      return { ok: this.getTagSet(file).has(tag.replace(/^#/, "")), warnings };
    }
    const inFolderMatch = raw.match(/^file\.inFolder\((.+)\)$/);
    if (inFolderMatch) {
      const folder = stripQuotes(inFolderMatch[1])
        .replace(/\\/g, "/")
        .replace(/\/+$/g, "");
      const prefix = folder ? `${folder}/` : "";
      return { ok: prefix ? file.path.startsWith(prefix) : true, warnings };
    }
    const hasLinkMatch = raw.match(/^file\.hasLink\((.+)\)$/);
    if (hasLinkMatch) {
      const target = stripQuotes(hasLinkMatch[1]);
      return { ok: this.fileHasLink(file, target), warnings };
    }

    // List literal contains: ["a","b"].contains(file.ext)
    const listContainsMatch = raw.match(/^\[(.*)\]\.contains\((.*)\)$/s);
    if (listContainsMatch) {
      const items = parseStringListLiteral(listContainsMatch[1]);
      const needleRef = listContainsMatch[2].trim();
      let needle = this.getValueForRef(file, needleRef, schema, formulaValues);
      if (needle === undefined) needle = stripQuotes(needleRef);
      return { ok: items.includes(String(needle ?? "")), warnings };
    }

    // String helpers on file.*
    const pathStartsWithMatch = raw.match(/^file\.path\.startsWith\((.+)\)$/);
    if (pathStartsWithMatch) {
      const prefix = stripQuotes(pathStartsWithMatch[1]).replace(/\\/g, "/");
      return { ok: file.path.startsWith(prefix), warnings };
    }
    const pathContainsMatch = raw.match(/^file\.path\.contains\((.+)\)$/);
    if (pathContainsMatch) {
      const needle = stripQuotes(pathContainsMatch[1]).replace(/\\/g, "/");
      return { ok: file.path.includes(needle), warnings };
    }
    const folderStartsWithMatch = raw.match(
      /^file\.folder\.startsWith\((.+)\)$/,
    );
    if (folderStartsWithMatch) {
      const prefix = stripQuotes(folderStartsWithMatch[1])
        .replace(/\\/g, "/")
        .replace(/\/+$/g, "");
      const folder = dirname(file.path);
      return { ok: folder.startsWith(prefix), warnings };
    }
    const folderContainsMatch = raw.match(/^file\.folder\.contains\((.+)\)$/);
    if (folderContainsMatch) {
      const needle = stripQuotes(folderContainsMatch[1]).replace(/\\/g, "/");
      const folder = dirname(file.path);
      return { ok: folder.includes(needle), warnings };
    }

    // file.tags.contains("tag/subtag")
    const fileTagsContainsMatch = raw.match(/^file\.tags\.contains\((.+)\)$/);
    if (fileTagsContainsMatch) {
      const tag = stripQuotes(fileTagsContainsMatch[1]);
      return { ok: this.getTagSet(file).has(tag.replace(/^#/, "")), warnings };
    }

    // collection.contains(link("Domaines")) / list(dans).contains(link("Atlas/Maps/Réunions"))
    const listPropContainsLinkMatch = raw.match(
      /^list\(([\p{L}\p{N}_-]+)\)\.contains\(link\((.+)\)\)$/u,
    );
    if (listPropContainsLinkMatch) {
      const key = listPropContainsLinkMatch[1];
      const targetRaw = stripQuotes(listPropContainsLinkMatch[2]);
      const want = normalizeLinkish(targetRaw);
      const v = this.getValueForRef(file, key, schema, formulaValues);
      const arr = Array.isArray(v)
        ? v
        : v === undefined || v === null
          ? []
          : [v];
      const ok = arr.some((x) => normalizeLinkish(String(x)) === want);
      return { ok, warnings };
    }
    const propContainsLinkMatch = raw.match(
      /^([\p{L}\p{N}_-]+)\.contains\(link\((.+)\)\)$/u,
    );
    if (propContainsLinkMatch) {
      const key = propContainsLinkMatch[1];
      const targetRaw = stripQuotes(propContainsLinkMatch[2]);
      const want = normalizeLinkish(targetRaw);
      const v = this.getValueForRef(file, key, schema, formulaValues);
      const arr = Array.isArray(v)
        ? v
        : v === undefined || v === null
          ? []
          : [v];
      const ok = arr.some((x) => normalizeLinkish(String(x)) === want);
      return { ok, warnings };
    }

    // Generic contains/startsWith on simple file.* fields
    const fileFieldOpMatch = raw.match(
      /^file\.(path|name|folder|ext)\.(contains|startsWith)\((.+)\)$/,
    );
    if (fileFieldOpMatch) {
      const field = `file.${fileFieldOpMatch[1]}`;
      const op = fileFieldOpMatch[2];
      const needle = stripQuotes(fileFieldOpMatch[3]);
      const hay = String(this.getValueForRef(file, field, schema, formulaValues) ?? "");
      if (op === "contains") return { ok: hay.includes(needle), warnings };
      return { ok: hay.startsWith(needle), warnings };
    }

    // Comparisons: support ==, =, !=, >=, <=, >, <
    const opMatch = raw.match(/^(.*?)\s*(==|=|!=|>=|<=|>|<)\s*(.*?)\s*$/);
    if (opMatch) {
      const leftRef = opMatch[1].trim();
      const op = opMatch[2];
      const rightRaw = opMatch[3].trim();

      const left = this.getValueForRef(file, leftRef, schema, formulaValues);
      const right = parseComparisonLiteral(rightRaw);
      return { ok: compareFilterValues(left, op, right), warnings };
    }

    // Bare identifier: treat as "truthy" frontmatter key (used a lot in Bases configs)
    // Ex: `- groupe_réunion` or `- sas_statut`
    if (isTruthyFilterReference(raw)) {
      const v = this.getValueForRef(file, raw, schema, formulaValues);
      return { ok: isTruthyFilterValue(v), warnings };
    }

    warnings.push("Filter non reconnu.");
    return { ok: true, warnings };
  }

  private evaluateFilter(
    file: TFile,
    filter: any,
    schema?: BaseSchemaResponse,
    formulaValues?: Record<string, string | null>,
  ): { ok: boolean; warnings: string[] } {
    if (!filter) return { ok: true, warnings: [] };
    if (typeof filter === "string")
      return this.evaluateStatement(file, filter, schema, formulaValues);

    if (typeof filter === "object" && !Array.isArray(filter)) {
      if (Array.isArray((filter as any).and)) {
        const warnings: string[] = [];
        for (const part of (filter as any).and) {
          const res = this.evaluateFilter(file, part, schema, formulaValues);
          warnings.push(...res.warnings);
          if (!res.ok) return { ok: false, warnings };
        }
        return { ok: true, warnings };
      }
      if (Array.isArray((filter as any).or)) {
        const warnings: string[] = [];
        let any = false;
        for (const part of (filter as any).or) {
          const res = this.evaluateFilter(file, part, schema, formulaValues);
          warnings.push(...res.warnings);
          if (res.ok) any = true;
        }
        return { ok: any, warnings };
      }
      if ((filter as any).not) {
        const res = this.evaluateFilter(file, (filter as any).not, schema, formulaValues);
        return { ok: !res.ok, warnings: res.warnings };
      }
    }

    // Unknown filter shape: accept but warn.
    return { ok: true, warnings: ["Filter non supporté (shape inconnu)."] };
  }

  /**
   * Note and file properties come from the metadata cache. Formula values only
   * exist when Obsidian's engine computed them: without `formulaValues` the
   * formula keys are left out (the caller reports them in `warnings`).
   */
  private buildRowProps(
    file: TFile,
    schema: BaseSchemaResponse,
    formulaValues?: Record<string, string | null>,
  ): Record<string, any> {
    const props: Record<string, any> = {};
    for (const p of schema.properties) {
      if (p.kind === "formula") {
        if (formulaValues) props[p.key] = formulaValues[p.key] ?? null;
        continue;
      }
      // Settings stored under `properties` as `formula.<name>` (displayName...)
      // name a formula column, not a note property.
      if (p.key.startsWith("formula.")) {
        if (formulaValues) props[p.key] = formulaValues[p.key.slice("formula.".length)] ?? null;
        continue;
      }
      props[p.key] = this.getValueForRef(file, p.key, schema);
    }
    return props;
  }

  private sortRows(
    rows: QueryCandidateRow[],
    specs: Array<{ prop: string; dir: "asc" | "desc" }>,
    schema: BaseSchemaResponse,
  ): void {
    if (specs.length === 0) return;
    const valueOf = (row: QueryCandidateRow, prop: string) =>
      prop.startsWith("formula.")
        ? row.values?.[prop.slice("formula.".length)]
        : this.getValueForRef(row.file, prop, schema);
    rows.sort((a, b) => {
      for (const { prop, dir } of specs) {
        const av = valueOf(a, prop);
        const bv = valueOf(b, prop);
        const aNum = typeof av === "number" ? av : Number(av);
        const bNum = typeof bv === "number" ? bv : Number(bv);
        const bothNum = Number.isFinite(aNum) && Number.isFinite(bNum);
        let cmp = 0;
        if (bothNum) cmp = aNum === bNum ? 0 : aNum < bNum ? -1 : 1;
        else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }

  /**
   * Base query. With `evaluate: true`, Obsidian's engine selects the rows of
   * the view (global and view filters, sort, limit) and computes every
   * formula from the same Base bytes as `baseSnapshot`: `source: "engine"`.
   * Otherwise, or when the engine is unavailable, the Bridge's supported-filter
   * snapshot selects the rows and no formula value is returned:
   * `source: "fallback"`, with one warning per formula when evaluation was
   * requested.
   */
  private async handleBaseQuery(req: any, res: any): Promise<void> {
    const id = normBaseId(req.params?.id);
    const body: BaseQueryRequest = (req.body ?? {}) as any;
    const config = await this.readBaseConfig(id);
    const schema = this.extractSchema(config.id, config.json);

    const viewName = typeof body?.view === "string" ? body.view : undefined;
    const view = viewName
      ? schema.views.find((v) => v.name === viewName)
      : schema.views[0];
    const rawViews: unknown[] = Array.isArray(config.json.views)
      ? config.json.views
      : [];
    const isViewObject = (v: unknown) =>
      !!v && typeof v === "object" && !Array.isArray(v);
    const viewIndex = !view
      ? -1
      : viewName
        ? rawViews.findIndex(
            (v) => isViewObject(v) && String((v as any).name ?? "") === viewName,
          )
        : rawViews.findIndex(isViewObject);

    const limit = clampInt(body?.limit ?? view?.limit ?? 20, 20, 1, 500);
    const page = clampInt(body?.page ?? 1, 1, 1, 1_000_000);
    const evaluate = !!body?.evaluate;
    const formulaNames = schema.formulas ? Object.keys(schema.formulas) : [];

    const warningsSet = new Set<string>();
    let warningsTruncated = false;
    const addWarnings = (ws: string[]) => {
      for (const w of ws) {
        if (warningsSet.size >= 200) {
          warningsTruncated = true;
          return;
        }
        warningsSet.add(String(w));
      }
    };
    if (viewName && !view) addWarnings(["Vue introuvable."]);
    const formulaFilterWarning = (filter: unknown) => {
      if (filterMentionsFormula(filter)) {
        addWarnings(["Filtre sur formule non évalué par le Bridge."]);
      }
    };

    let source: "engine" | "fallback" = "fallback";
    let candidates: QueryCandidateRow[] | null = null;
    if (evaluate) {
      const engine = await queryBaseViewWithEngine(
        { app: this.app, parseYaml, stringifyYaml, obsidianVersion: apiVersion },
        { path: config.id, text: config.yaml, viewIndex },
      );
      if (engine.available) {
        source = "engine";
        candidates = [];
        for (const row of engine.rows) {
          const file = this.app.vault.getAbstractFileByPath(row.path);
          if (file instanceof TFile) candidates.push({ file, values: row.values });
          else addWarnings(["Ligne du moteur introuvable dans le coffre."]);
        }
      } else {
        for (const name of formulaNames) {
          addWarnings([`formula_not_evaluated:${name}:${engine.reason}`]);
        }
      }
    }

    if (!candidates) {
      // Bridge supported-filter snapshot: global and view filters only.
      const baseFilter = {
        and: [schema.filters, view?.filters].filter(Boolean),
      };
      formulaFilterWarning(baseFilter);
      candidates = [];
      for (const f of this.app.vault.getFiles()) {
        if (!(f instanceof TFile)) continue;
        if (f.path.startsWith(".obsidian/") || f.extension === "base") continue;
        const r = this.evaluateFilter(f, baseFilter, schema);
        addWarnings(r.warnings);
        if (r.ok) candidates.push({ file: f });
      }
      if (!(Array.isArray(body?.sort) && body.sort.length > 0) && Array.isArray(view?.order)) {
        const orderSpecs: Array<{ prop: string; dir: "asc" | "desc" }> = [];
        for (const raw of view.order) {
          const str = String(raw).trim();
          const dir: "asc" | "desc" = str.startsWith("-") ? "desc" : "asc";
          const prop = str.startsWith("-") ? str.slice(1) : str;
          if (prop) orderSpecs.push({ prop, dir });
        }
        this.sortRows(candidates, orderSpecs, schema);
      }
      // A view limit hides rows in Obsidian; the Bridge's order may differ
      // from Obsidian's sort, so say when it decided which rows were kept.
      if (typeof view?.limit === "number" && candidates.length > view.limit) {
        candidates = candidates.slice(0, Math.max(0, Math.trunc(view.limit)));
        addWarnings([`view_limit_applied_with_bridge_order:${view.limit}`]);
      }
    }

    if (body?.filter) {
      if (source === "fallback") formulaFilterWarning(body.filter);
      candidates = candidates.filter((row) => {
        const r = this.evaluateFilter(row.file, body.filter, schema, row.values);
        addWarnings(r.warnings);
        return r.ok;
      });
    }

    const sortSpecs: Array<{ prop: string; dir: "asc" | "desc" }> = [];
    if (Array.isArray(body?.sort)) {
      for (const s of body.sort) {
        if (!s || typeof s !== "object") continue;
        const prop = String((s as any).prop ?? "").trim();
        if (!prop) continue;
        const dir =
          String((s as any).dir ?? "asc").toLowerCase() === "desc"
            ? "desc"
            : "asc";
        sortSpecs.push({ prop, dir });
      }
    }
    if (source === "fallback" && sortSpecs.some((s) => s.prop.startsWith("formula."))) {
      addWarnings(["Tri sur formule non évalué par le Bridge."]);
    }
    this.sortRows(candidates, sortSpecs, schema);

    const total = candidates.length;
    const start = (page - 1) * limit;
    const rows: BaseQueryRow[] = candidates
      .slice(start, start + limit)
      .map(({ file, values }) => ({
        file: { path: file.path, name: file.basename },
        props: this.buildRowProps(file, schema, values),
        computed: evaluate && values ? { ...values } : undefined,
      }));

    const warnings = Array.from(warningsSet).sort((a, b) => a.localeCompare(b));
    if (warningsTruncated) warnings.push("Warnings tronqués (max 200).");
    const response: BaseQueryResponse = {
      total,
      page,
      rows,
      evaluate,
      source,
      // Proof comes from the same bytes parsed into config.json and, for the
      // engine, handed to it: not a reread.
      baseSnapshot: config.snapshot,
      warnings,
    };
    res.json(response);
  }

  private functionRegistry = createFunctionRegistry({
    obsidianVersion: apiVersion,
    fetchBundle: async () => {
      // The renderer serves its own bundle; this reads the running app's code.
      const response = await fetch("app.js");
      if (!response.ok) throw new Error("bundle_unavailable");
      return response.text();
    },
    translate: (key: string) => (window as any).i18next?.t?.(key),
  });

  /** Engine routes answer 200 with `available`; they never use the error envelope. */
  private registerEngineRoutes(api: any): void {
    const send = (res: any, status: number, payload: unknown) =>
      responseStatus(res, status).json(payload);

    api
      .addRoute(`${REST_PREFIX}/engine/evaluate`)
      .post(async (req: any, res: any) => {
        let request: ReturnType<typeof parseEvaluateRequest>;
        try {
          request = parseEvaluateRequest(req?.body);
        } catch (error) {
          send(res, 400, {
            ...unavailableEvaluation("invalid_request"),
            ...(error instanceof EngineRequestError
              ? { message: error.message }
              : {}),
          });
          return;
        }
        try {
          send(
            res,
            200,
            await evaluateBaseFormulas(
              { app: this.app, parseYaml, stringifyYaml, obsidianVersion: apiVersion },
              request,
            ),
          );
        } catch {
          send(res, 200, unavailableEvaluation("engine_unavailable"));
        }
      });

    api
      .addRoute(`${REST_PREFIX}/engine/functions`)
      .get(async (req: any, res: any) => {
        try {
          const on = req?.query?.on;
          send(res, 200, await this.functionRegistry(typeof on === "string" ? on : undefined));
        } catch {
          send(res, 200, unavailableRegistry("engine_unavailable"));
        }
      });
  }

  private async registerRestExtension(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.app.workspace.onLayoutReady(() => resolve()),
    );
    this.restLifecycle = new RestExtensionLifecycle({
      probe: () =>
        (this.app as any).plugins?.plugins?.["obsidian-local-rest-api"] ??
        (this.app as any).plugins?.getPlugin?.("obsidian-local-rest-api") ??
        null,
      mount: (restPlugin: any) => {
      const getPublicApi =
        typeof restPlugin?.getPublicApi === "function"
          ? restPlugin.getPublicApi.bind(restPlugin)
          : undefined;

      if (typeof getPublicApi === "function") {
        const nativeApi: LocalRestApiPublicApi | undefined = getPublicApi(this.manifest);
      if (!nativeApi || typeof nativeApi.addRoute !== "function") return null;
      const documentation = describeRestRoutes(nativeApi, this.manifest.id);
      const api = documentation.api;
        if (!api || typeof api.addRoute !== "function") return null;

        try {
        console.log(
          `[bases-bridge] Registered API extension via Local REST API (prefix=${REST_PREFIX})`,
        );

        api.addRoute(`${REST_PREFIX}/ping`).get((_req: any, res: any) =>
          res.json({
            ok: true,
            id: this.manifest.id,
            version: this.manifest.version,
            lifecycle: this.restLifecycle?.snapshot() ?? null,
            headlessLifecycle: this.headlessLifecycle?.snapshot() ?? null,
            engineEnabled: this.settings.engineEnabled,
            engineReady: this.settings.engineEnabled && ENGINE_CACHE.size > 0,
            cacheSize: ENGINE_CACHE.size,
          }),
        );

        api
          .addRoute(`${BASE_ATOMIC_REST_PREFIX}/status`)
          .get((_req: any, res: any) =>
            sendJson(res, 200, {
              ok: true,
              contractVersion: BASE_ATOMIC_CONTRACT_VERSION,
              plugin: { id: this.manifest.id, version: this.manifest.version },
              lifecycle: this.restLifecycle?.snapshot() ?? null,
              backend: {
                kind: "obsidian-vault-process-base",
                bindingFingerprint: this.bindingFingerprint,
                atomicCas: true,
                writeEnabled: this.settings.allowAtomicBaseWrites,
              },
              limits: {
                baseOnly: true,
                sourcePreservingCompilerRequired: true,
              },
              migration: {
                legacyConfigWritesEnabled:
                  this.settings.allowLegacyConfigWrites,
              },
            }),
          );

        api
          .addRoute(`${BASE_ATOMIC_REST_PREFIX}/bases/read`)
          .post(async (req: any, res: any) => {
            let request: ReturnType<typeof parseBaseReadRequest>;
            try {
              request = parseBaseReadRequest(req?.body);
            } catch (error) {
              sendJson(
                res,
                400,
                atomicError("invalid_request"),
              );
              return;
            }
            try {
              const yaml = await this.app.vault.read(
                this.baseFile(request.path),
              );
              sendJson(res, 200, {
                ok: true,
                contractVersion: BASE_ATOMIC_CONTRACT_VERSION,
                path: request.path,
                yaml,
                sha256: sha256(yaml),
                size: Buffer.byteLength(yaml, "utf8"),
                bindingFingerprint: this.bindingFingerprint,
              });
            } catch (error) {
              const notFound = isBaseNotFoundError(error);
              sendJson(
                res,
                notFound ? 404 : 500,
                atomicError(notFound ? "base_not_found" : "read_error"),
              );
            }
          });

        api
          .addRoute(`${BASE_ATOMIC_REST_PREFIX}/bases/cas`)
          .post(async (req: any, res: any) => {
            try {
              if (!this.settings.allowAtomicBaseWrites) {
                sendJson(
                  res,
                  403,
                  atomicError(
                    "writes_disabled",
                    "Atomic Base writes are disabled in the bridge settings.",
                  ),
                );
                return;
              }
              let request: ReturnType<typeof parseBaseCasRequest>;
              try {
                request = parseBaseCasRequest(req?.body);
                const parsed = parseYaml(request.nextYaml);
                if (
                  !parsed ||
                  typeof parsed !== "object" ||
                  Array.isArray(parsed)
                ) {
                  throw new Error("nextYaml must contain a Base mapping root.");
                }
              } catch (error) {
                sendJson(
                  res,
                  400,
                  atomicError("invalid_request"),
                );
                return;
              }
              assertBaseBinding(
                request.bindingFingerprint,
                this.bindingFingerprint,
              );
              let beforeSha256 = "";
              const written = await this.app.vault.process(
                this.baseFile(request.path),
                (current) => {
                  const result = compareAndReplaceBase(
                    current,
                    request.expectedSha256,
                    request.nextYaml,
                  );
                  beforeSha256 = result.beforeSha256;
                  return result.content;
                },
              );
              sendJson(res, 200, {
                ok: true,
                contractVersion: BASE_ATOMIC_CONTRACT_VERSION,
                path: request.path,
                beforeSha256,
                afterSha256: sha256(written),
                size: Buffer.byteLength(written, "utf8"),
                bindingFingerprint: this.bindingFingerprint,
              });
            } catch (error) {
              if (isBaseBindingConflict(error)) {
                sendJson(
                  res,
                  409,
                  atomicError("binding_conflict"),
                );
                return;
              }
              if (isBaseHashConflict(error)) {
                sendJson(
                  res,
                  409,
                  atomicError("hash_conflict", undefined, {
                    actualSha256: safeStringProperty(error, "actualSha256"),
                  }),
                );
                return;
              }
              const notFound = isBaseNotFoundError(error);
              sendJson(
                res,
                notFound ? 404 : 500,
                atomicError(notFound ? "base_not_found" : "write_error"),
              );
            }
          });

        this.registerEngineRoutes(api);

        api
          .addRoute(`${REST_PREFIX}/debug/engine-keys`)
          .get((_req: any, res: any) =>
            res.json({ keys: Array.from(ENGINE_CACHE.keys()) }),
          );

        const listBases = async (_req: any, res: any) => {
          const bases: BaseSummary[] = [];
          for (const file of this.app.vault.getFiles()) {
            if (file.path.startsWith(".obsidian/")) continue;
            if (file.extension !== "base") continue;
            bases.push({ id: file.path, path: file.path, name: file.basename });
          }
          bases.sort((a, b) => a.path.localeCompare(b.path));
          const response: BasesListResponse = { bases };
          res.json(response);
        };
        api
          .addRoute(`${REST_PREFIX}/bases`)
          .get(withPublicLegacyBaseBoundary(listBases));
        api.addRoute(`/bases`).get(withPublicLegacyBaseBoundary(listBases));

        const getBaseConfig = async (req: any, res: any) => {
          const id = normBaseId(req.params?.id);
          const config = await this.readBaseConfig(id);
          const response: BaseConfigResponse = {
            id: config.id,
            yaml: config.yaml,
            json: config.json,
          };
          res.json(response);
        };

        api
          .addRoute(`${REST_PREFIX}/bases/:id(*)/config`)
          .get(withPublicLegacyBaseBoundary(getBaseConfig));
        api
          .addRoute(`/bases/:id(*)/config`)
          .get(withPublicLegacyBaseBoundary(getBaseConfig));

        const putBaseConfig = async (req: any, res: any) => {
          const id = normBaseId(req.params?.id);
          const path = ensureBaseExt(id);
          const body: BaseConfigUpsertRequest = (req.body ?? {}) as any;
          const validateOnly = !!body?.validateOnly;

          let nextYaml = "";
          const warnings: string[] = [];

          if (typeof body?.yaml === "string" && body.yaml.trim()) {
            const parsed = parseYaml(body.yaml);
            if (
              !parsed ||
              typeof parsed !== "object" ||
              Array.isArray(parsed)
            ) {
              const response: BaseConfigUpsertResponse = {
                ok: false,
                id: path,
                warnings: ["YAML invalide: root doit être un objet."],
              };
              sendJson(res, 200, response);
              return;
            }
            nextYaml = body.yaml;
          } else if (
            body?.json &&
            typeof body.json === "object" &&
            !Array.isArray(body.json)
          ) {
            nextYaml = stringifyYaml(body.json);
          } else {
            const response: BaseConfigUpsertResponse = {
              ok: false,
              id: path,
              warnings: ["Payload requis: yaml ou json."],
            };
            sendJson(res, 200, response);
            return;
          }

          if (validateOnly) {
            const response: BaseConfigUpsertResponse = {
              ok: true,
              id: path,
              warnings,
            };
            sendJson(res, 200, response);
            return;
          }

          if (!this.settings.allowLegacyConfigWrites) {
            sendJson(res, 403, {
              ok: false,
              id: path,
              warnings: [
                "Legacy whole-file Base writes are disabled. Use the governed atomic Base operation.",
              ],
            });
            return;
          }

          await this.ensureFoldersFor(path);
          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile)
            await this.app.vault.modify(existing, nextYaml);
          else await this.app.vault.create(path, nextYaml);

          const response: BaseConfigUpsertResponse = {
            ok: true,
            id: path,
            warnings,
          };
          res.json(response);
        };

        api
          .addRoute(`${REST_PREFIX}/bases/:id(*)/config`)
          .put(withPublicLegacyBaseBoundary(putBaseConfig));
        api
          .addRoute(`/bases/:id(*)/config`)
          .put(withPublicLegacyBaseBoundary(putBaseConfig));

        const createBase = async (req: any, res: any) => {
          const body: BaseCreateRequest = (req.body ?? {}) as any;
          const path = ensureBaseExt(String(body?.path ?? ""));
          if (!path || path === ".base") {
            const response: BaseCreateResponse = {
              ok: false,
              id: path || "",
              warnings: ["path requis."],
            };
            sendJson(res, 200, response);
            return;
          }
          if (
            !body?.spec ||
            typeof body.spec !== "object" ||
            Array.isArray(body.spec)
          ) {
            const response: BaseCreateResponse = {
              ok: false,
              id: path,
              warnings: ["spec doit être un objet."],
            };
            sendJson(res, 200, response);
            return;
          }
          const overwrite = body?.overwrite !== false;
          const validateOnly = !!body?.validateOnly;

          let yaml = "";
          try {
            yaml = stringifyYaml(body.spec);
          } catch (e: any) {
            const response: BaseCreateResponse = {
              ok: false,
              id: path,
              warnings: ["The Base specification could not be serialized."],
            };
            sendJson(res, 200, response);
            return;
          }

          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing && !overwrite) {
            const response: BaseCreateResponse = {
              ok: true,
              id: path,
              warnings: ["Le fichier existe déjà (overwrite=false)."],
              created: false,
              overwritten: false,
            };
            res.json(response);
            return;
          }

          if (validateOnly) {
            const response: BaseCreateResponse = {
              ok: true,
              id: path,
              created: false,
              overwritten: false,
            };
            res.json(response);
            return;
          }

          if (!this.settings.allowLegacyConfigWrites) {
            sendJson(res, 403, {
              ok: false,
              id: path,
              warnings: [
                "Legacy Base creation and replacement are disabled. Enable the explicit compatibility toggle to use this route.",
              ],
              created: false,
              overwritten: false,
            });
            return;
          }

          await this.ensureFoldersFor(path);
          if (existing instanceof TFile) {
            await this.app.vault.modify(existing, yaml);
            const response: BaseCreateResponse = {
              ok: true,
              id: path,
              created: false,
              overwritten: true,
            };
            res.json(response);
            return;
          }
          await this.app.vault.create(path, yaml);
          const response: BaseCreateResponse = {
            ok: true,
            id: path,
            created: true,
            overwritten: false,
          };
          res.json(response);
        };

        api
          .addRoute(`${REST_PREFIX}/bases`)
          .post(withPublicLegacyBaseBoundary(createBase));
        api.addRoute(`/bases`).post(withPublicLegacyBaseBoundary(createBase));

        const getBaseSchema = async (req: any, res: any) => {
          const id = normBaseId(req.params?.id);
          const config = await this.readBaseConfig(id);
          const schema = this.extractSchema(config.id, config.json);
          res.json(schema);
        };

        api
          .addRoute(`${REST_PREFIX}/bases/:id(*)/schema`)
          .get(withPublicLegacyBaseBoundary(getBaseSchema));
        api
          .addRoute(`/bases/:id(*)/schema`)
          .get(withPublicLegacyBaseBoundary(getBaseSchema));

        const queryBase = (req: any, res: any) => this.handleBaseQuery(req, res);

        api
          .addRoute(`${REST_PREFIX}/bases/:id(*)/query`)
          .post(withPublicLegacyBaseBoundary(queryBase));
        api
          .addRoute(`/bases/:id(*)/query`)
          .post(withPublicLegacyBaseBoundary(queryBase));

        const upsertBase = async (req: any, res: any) => {
          const body: BaseUpsertRequest = (req.body ?? {}) as any;
          const continueOnError = !!body?.continueOnError;
          const dryRun = !!body?.dryRun;
          const results: BaseUpsertResult[] = [];

          for (const op of body?.operations ?? []) {
            const filePath = normBaseId(String(op?.file ?? ""));
            if (!filePath) {
              results.push({
                file: "",
                mtime: 0,
                error: {
                  code: "validation_error",
                  message: "Opération sans champ 'file'.",
                },
              });
              if (!continueOnError) break;
              continue;
            }

            const abstract = this.app.vault.getAbstractFileByPath(filePath);
            if (!(abstract instanceof TFile)) {
              results.push({
                file: filePath,
                mtime: 0,
                error: {
                  code: "not_found",
                  message: `Note introuvable: ${filePath}`,
                },
              });
              if (!continueOnError) break;
              continue;
            }

            const expected =
              typeof op?.expected_mtime === "number"
                ? op.expected_mtime
                : undefined;
            if (expected && abstract.stat.mtime !== expected) {
              results.push({
                file: filePath,
                mtime: abstract.stat.mtime,
                error: {
                  code: "mtime_conflict",
                  message: `Conflit mtime (expected=${expected}, actual=${abstract.stat.mtime}).`,
                },
              });
              if (!continueOnError) break;
              continue;
            }

            const setObj =
              op?.set && typeof op.set === "object" && !Array.isArray(op.set)
                ? (op.set as Record<string, any>)
                : {};
            const unsetArr = Array.isArray(op?.unset)
              ? (op.unset.filter((k: any) => typeof k === "string") as string[])
              : [];
            const forbiddenKeys = validateUpsertKeys(setObj, unsetArr);
            if (forbiddenKeys.length > 0) {
              results.push({
                file: filePath,
                mtime: abstract.stat.mtime,
                error: {
                  code: "forbidden_key",
                  message: "The request includes a protected Base field.",
                },
              });
              if (!continueOnError) break;
              continue;
            }

            try {
              const changedKeys: string[] = [];
              for (const k of Object.keys(setObj)) changedKeys.push(k);

              if (!dryRun) {
                await (this.app as any).fileManager.processFrontMatter(
                  abstract,
                  (fm: any) => {
                    for (const [k, v] of Object.entries(setObj)) {
                      fm[k] = v;
                    }
                    for (const k of unsetArr) {
                      if (k in fm) delete fm[k];
                    }
                  },
                );
              }

              results.push({
                file: filePath,
                mtime: abstract.stat.mtime,
                changed: {
                  keys: changedKeys,
                  unset: unsetArr.length ? unsetArr : undefined,
                },
                warnings: dryRun ? ["dry_run_no_write"] : undefined,
              });
            } catch (e: any) {
              const classified = classifyWriteError(e);
              results.push({
                file: filePath,
                mtime: abstract.stat.mtime,
                error: {
                  code: classified.code,
                  message: classified.message,
                },
                warnings: classified.warnings,
              });
              if (!continueOnError) break;
            }
          }

          const ok = results.every((r) => !r.error);
          const response: BaseUpsertResponse = { ok, results };
          sendJson(res, 200, response);
        };

        api
          .addRoute(`${REST_PREFIX}/bases/:id(*)/upsert`)
          .post(withPublicLegacyBaseBoundary(upsertBase));
        api
          .addRoute(`/bases/:id(*)/upsert`)
          .post(withPublicLegacyBaseBoundary(upsertBase));

        console.info("[" + this.manifest.id + "] optional OpenAPI: " + documentation.publish());
      return () => api.unregister?.();
        } catch {
          const rollback = () => api.unregister?.();
          try {
            rollback();
          } catch {
            throw new RestExtensionPartialMountError(rollback);
          }
          throw new Error("Local REST API route registration failed.");
        }
      }
      return null;
      },
      onCleanupError: () =>
        console.warn("[bases-bridge] Local REST API extension cleanup failed."),
    });
    this.register(() => {
      this.restLifecycle?.stop();
      this.restLifecycle = null;
    });
    this.restLifecycle.start();
  }
}

class BridgeSettingsTab extends PluginSettingTab {
  plugin: BasesBridgePlugin;

  constructor(app: any, plugin: BasesBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Bases Bridge – Engine" });

    new Setting(containerEl)
      .setName("Monter la vue « Bridge (Headless) »")
      .setDesc(
        "Expérimental. Les requêtes avec evaluate calculent les formules avec le moteur d’Obsidian, que ce réglage soit actif ou non.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.engineEnabled)
          .onChange(async (value) => {
            await (this.plugin as any).setEngineEnabled(value);
          }),
      );

    containerEl.createEl("h3", { text: "Écritures gouvernées" });

    new Setting(containerEl)
      .setName("Autoriser le CAS atomique des Bases")
      .setDesc(
        "Désactivé par défaut. Autorise uniquement les remplacements .base avec empreinte de coffre et précondition SHA-256 exactes.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowAtomicBaseWrites)
          .onChange(async (value) => {
            this.plugin.settings.allowAtomicBaseWrites = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Compatibilité : écritures de configuration historiques")
      .setDesc(
        "Désactivé par défaut. Réactive temporairement le remplacement complet non gouverné via PUT /bases/:id/config et POST /bases.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowLegacyConfigWrites)
          .onChange(async (value) => {
            this.plugin.settings.allowLegacyConfigWrites = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
