import { createHash, randomUUID } from "node:crypto";
import { Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import {
  ATOMIC_WRITE_CONTRACT_VERSION,
  ATOMIC_WRITE_REST_PREFIX,
  assertCanvasContentSize,
  assertBindingFingerprint,
  BindingConflictError,
  compareAndReplace,
  HashConflictError,
  parseCasRequest,
  parseCanvasCasRequest,
  parseCanvasReadRequest,
  parseReadRequest,
  sha256,
} from "./contract.js";
import { getFrontmatterDateIntegrationContract } from "./modifiedTimeIntegrations.js";
import {
  RestExtensionLifecycle,
  RestExtensionPartialMountError,
} from "../../shared/restExtensionLifecycle.js";

type PluginData = {
  instanceId: string;
  allowWrites: boolean;
  allowCanvasWrites: boolean;
};

type AtomicResource = "note" | "canvas";

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

/**
 * Error values cross the Local REST boundary. They can be proxies supplied by
 * integrations, so even ordinary inspection must not be allowed to throw.
 */
function safeInstanceOf(value: unknown, constructor: Function): boolean {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

function safeProperty(value: unknown, property: string): unknown {
  if (!isObjectLike(value)) return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function safeMessageEquals(value: unknown, expected: string): boolean {
  return safeProperty(value, "message") === expected;
}

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
  target.json(payload);
}

type AtomicPublicErrorDescriptor = {
  code: string;
  reasonCode: string;
  status: "blocked" | "conflict" | "not_found" | "rejected";
  retryable: false;
  message: string;
};

const ATOMIC_PUBLIC_ERRORS: Record<string, AtomicPublicErrorDescriptor> = {
  invalid_request: {
    code: "invalid_request",
    reasonCode: "request_rejected",
    status: "rejected",
    retryable: false,
    message: "The request could not be validated.",
  },
  note_not_found: {
    code: "note_not_found",
    reasonCode: "resource_not_found",
    status: "not_found",
    retryable: false,
    message: "The requested note was not found.",
  },
  canvas_not_found: {
    code: "canvas_not_found",
    reasonCode: "resource_not_found",
    status: "not_found",
    retryable: false,
    message: "The requested Canvas was not found.",
  },
  writes_disabled: {
    code: "writes_disabled",
    reasonCode: "write_not_authorized",
    status: "blocked",
    retryable: false,
    message: "Atomic note writes are disabled.",
  },
  canvas_writes_disabled: {
    code: "canvas_writes_disabled",
    reasonCode: "write_not_authorized",
    status: "blocked",
    retryable: false,
    message: "Atomic Canvas writes are disabled.",
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
      "The resource changed after it was read. Read it again before retrying.",
  },
  read_error: {
    code: "read_error",
    reasonCode: "read_failed",
    status: "rejected",
    retryable: false,
    message: "The resource could not be read.",
  },
  write_error: {
    code: "write_error",
    reasonCode: "write_failed",
    status: "rejected",
    retryable: false,
    message: "The resource could not be written.",
  },
};

function safeErrorDetails(
  details: unknown,
): { actualSha256: string } | undefined {
  if (!isObjectLike(details)) {
    return undefined;
  }
  try {
    if (Array.isArray(details)) return undefined;
  } catch {
    return undefined;
  }
  const actualSha256 = safeProperty(details, "actualSha256");
  return typeof actualSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(actualSha256)
    ? { actualSha256 }
    : undefined;
}

function safeHashConflictDetails(
  error: unknown,
): { actualSha256: string } | undefined {
  if (!safeInstanceOf(error, HashConflictError)) return undefined;
  const actualSha256 = safeProperty(error, "actualSha256");
  return typeof actualSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(actualSha256)
    ? { actualSha256 }
    : undefined;
}

export function publicAtomicErrorPayload(
  code: unknown,
  _message?: unknown,
  details?: unknown,
) {
  const descriptor =
    typeof code === "string"
      ? (ATOMIC_PUBLIC_ERRORS[code] ?? ATOMIC_PUBLIC_ERRORS.invalid_request)
      : ATOMIC_PUBLIC_ERRORS.invalid_request;
  const safeDetails = safeErrorDetails(details);
  return {
    ok: false,
    contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
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

const errorPayload = publicAtomicErrorPayload;

export default class OptimikeAtomicWriteBridgePlugin extends Plugin {
  private instanceId = "";
  private bindingFingerprint = "";
  private readonly missingResources = new WeakMap<object, AtomicResource>();
  private restLifecycle: RestExtensionLifecycle<object> | null = null;
  allowWrites = false;
  allowCanvasWrites = false;

  async onload(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PluginData> | null;
    this.instanceId =
      typeof stored?.instanceId === "string" && stored.instanceId.length > 0
        ? stored.instanceId
        : randomUUID();
    this.allowWrites = stored?.allowWrites === true;
    this.allowCanvasWrites = stored?.allowCanvasWrites === true;
    const deviceStorageKey = "optimike-atomic-write-bridge:device-id";
    let deviceId = window.localStorage.getItem(deviceStorageKey);
    if (!deviceId) {
      deviceId = randomUUID();
      window.localStorage.setItem(deviceStorageKey, deviceId);
    }
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const basePath = adapter.getBasePath?.();
    if (!basePath) {
      throw new Error(
        "Atomic Write Bridge requires a desktop filesystem vault identity.",
      );
    }
    this.bindingFingerprint = createHash("sha256")
      .update(`${deviceId}\0${this.instanceId}\0${basePath}`, "utf8")
      .digest("hex");
    if (
      stored?.instanceId !== this.instanceId ||
      stored?.allowWrites !== this.allowWrites ||
      stored?.allowCanvasWrites !== this.allowCanvasWrites
    ) {
      await this.saveSettings();
    }
    this.addSettingTab(new AtomicWriteSettingsTab(this.app, this));
    void this.registerRestExtension();
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      instanceId: this.instanceId,
      allowWrites: this.allowWrites,
      allowCanvasWrites: this.allowCanvasWrites,
    } satisfies PluginData);
  }

  private file(path: string, resource: AtomicResource = "note"): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!safeInstanceOf(file, TFile)) {
      const missing = new Error();
      this.missingResources.set(missing, resource);
      throw missing;
    }
    return file as TFile;
  }

  private missingResource(error: unknown): AtomicResource | undefined {
    if (!isObjectLike(error)) return undefined;
    try {
      return this.missingResources.get(error);
    } catch {
      return undefined;
    }
  }

  private isMissingResource(
    error: unknown,
    resource: AtomicResource,
  ): boolean {
    return (
      this.missingResource(error) === resource ||
      safeMessageEquals(
        error,
        `${resource === "canvas" ? "Canvas" : "Note"} not found.`,
      )
    );
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
      if (!getPublicApi) return null;
      const api = getPublicApi(this.manifest);
      if (!api || typeof api.addRoute !== "function") return null;

      try {
      api
        .addRoute(`${ATOMIC_WRITE_REST_PREFIX}/status`)
        .get((_req: any, res: any) => {
          const dateContract = getFrontmatterDateIntegrationContract(this.app);
          sendJson(res, 200, {
            ok: true,
            contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
            plugin: {
              id: this.manifest.id,
              version: this.manifest.version,
            },
            lifecycle: this.restLifecycle?.snapshot() ?? null,
            backend: {
              kind: "obsidian-vault-process",
              bindingFingerprint: this.bindingFingerprint,
              atomicCas: true,
              writeEnabled: this.allowWrites,
              canvasAtomicCas: true,
              canvasWriteEnabled: this.allowCanvasWrites,
            },
            limits: { markdownOnly: true },
            settlement: {
              contractVersion: 1,
              modifiedTimeFrontmatter: {
                integrations: dateContract.settlementIntegrations,
                utcOffsetMinutes: -new Date().getTimezoneOffset(),
              },
            },
            protection: {
              contractVersion: 1,
              frontmatterDateProperties: {
                integrations: dateContract.protectionIntegrations,
                unsupportedIntegrations: dateContract.unsupportedIntegrations,
              },
            },
          });
        });

      api
        .addRoute(`${ATOMIC_WRITE_REST_PREFIX}/canvas/read`)
        .post(async (req: any, res: any) => {
          let request: ReturnType<typeof parseCanvasReadRequest>;
          try {
            request = parseCanvasReadRequest(req?.body);
          } catch (error) {
            sendJson(
              res,
              400,
              errorPayload("invalid_request"),
            );
            return;
          }
          try {
            const content = await this.app.vault.read(
              this.file(request.path, "canvas"),
            );
            assertCanvasContentSize(content);
            sendJson(res, 200, {
              ok: true,
              contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
              path: request.path,
              content,
              sha256: sha256(content),
              size: Buffer.byteLength(content, "utf8"),
              bindingFingerprint: this.bindingFingerprint,
            });
          } catch (error) {
            const notFound = this.isMissingResource(error, "canvas");
            sendJson(
              res,
              notFound ? 404 : 500,
              errorPayload(notFound ? "canvas_not_found" : "read_error"),
            );
          }
        });

      api
        .addRoute(`${ATOMIC_WRITE_REST_PREFIX}/canvas/cas`)
        .post(async (req: any, res: any) => {
          try {
            if (!this.allowCanvasWrites) {
              sendJson(
                res,
                403,
                errorPayload(
                  "canvas_writes_disabled",
                  "Atomic Canvas writes are disabled in the bridge settings.",
                ),
              );
              return;
            }
            let request: ReturnType<typeof parseCanvasCasRequest>;
            try {
              request = parseCanvasCasRequest(req?.body);
            } catch (error) {
              sendJson(
                res,
                400,
                errorPayload("invalid_request"),
              );
              return;
            }
            assertBindingFingerprint(
              request.bindingFingerprint,
              this.bindingFingerprint,
            );
            let beforeSha256 = "";
            const written = await this.app.vault.process(
              this.file(request.path, "canvas"),
              (current) => {
                const result = compareAndReplace(
                  current,
                  request.expectedSha256,
                  request.nextContent,
                );
                beforeSha256 = result.beforeSha256;
                return result.content;
              },
            );
            sendJson(res, 200, {
              ok: true,
              contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
              path: request.path,
              beforeSha256,
              afterSha256: sha256(written),
              size: Buffer.byteLength(written, "utf8"),
              bindingFingerprint: this.bindingFingerprint,
            });
          } catch (error) {
            if (safeInstanceOf(error, BindingConflictError)) {
              sendJson(
                res,
                409,
                errorPayload("binding_conflict"),
              );
              return;
            }
            if (safeInstanceOf(error, HashConflictError)) {
              sendJson(
                res,
                409,
                errorPayload(
                  "hash_conflict",
                  undefined,
                  safeHashConflictDetails(error),
                ),
              );
              return;
            }
            const notFound = this.isMissingResource(error, "canvas");
            sendJson(
              res,
              notFound ? 404 : 500,
              errorPayload(notFound ? "canvas_not_found" : "write_error"),
            );
          }
        });

      api
        .addRoute(`${ATOMIC_WRITE_REST_PREFIX}/notes/read`)
        .post(async (req: any, res: any) => {
          let request: ReturnType<typeof parseReadRequest>;
          try {
            request = parseReadRequest(req?.body);
          } catch (error) {
            sendJson(
              res,
              400,
              errorPayload("invalid_request"),
            );
            return;
          }
          try {
            const content = await this.app.vault.read(this.file(request.path));
            sendJson(res, 200, {
              ok: true,
              contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
              path: request.path,
              content,
              sha256: sha256(content),
              size: Buffer.byteLength(content, "utf8"),
              bindingFingerprint: this.bindingFingerprint,
            });
          } catch (error) {
            const notFound = this.isMissingResource(error, "note");
            sendJson(
              res,
              notFound ? 404 : 500,
              errorPayload(notFound ? "note_not_found" : "read_error"),
            );
          }
        });

      api
        .addRoute(`${ATOMIC_WRITE_REST_PREFIX}/notes/cas`)
        .post(async (req: any, res: any) => {
          try {
            if (!this.allowWrites) {
              sendJson(
                res,
                403,
                errorPayload(
                  "writes_disabled",
                  "Atomic note writes are disabled in the bridge settings.",
                ),
              );
              return;
            }
            let request: ReturnType<typeof parseCasRequest>;
            try {
              request = parseCasRequest(req?.body);
            } catch (error) {
              sendJson(
                res,
                400,
                errorPayload("invalid_request"),
              );
              return;
            }
            assertBindingFingerprint(
              request.bindingFingerprint,
              this.bindingFingerprint,
            );
            let beforeSha256 = "";
            const written = await this.app.vault.process(
              this.file(request.path),
              (current) => {
                const result = compareAndReplace(
                  current,
                  request.expectedSha256,
                  request.nextContent,
                );
                beforeSha256 = result.beforeSha256;
                return result.content;
              },
            );
            sendJson(res, 200, {
              ok: true,
              contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
              path: request.path,
              beforeSha256,
              afterSha256: sha256(written),
              size: Buffer.byteLength(written, "utf8"),
              bindingFingerprint: this.bindingFingerprint,
            });
          } catch (error) {
            if (safeInstanceOf(error, BindingConflictError)) {
              sendJson(
                res,
                409,
                errorPayload("binding_conflict"),
              );
              return;
            }
            if (safeInstanceOf(error, HashConflictError)) {
              sendJson(
                res,
                409,
                errorPayload(
                  "hash_conflict",
                  undefined,
                  safeHashConflictDetails(error),
                ),
              );
              return;
            }
            const notFound = this.isMissingResource(error, "note");
            sendJson(
              res,
              notFound ? 404 : 500,
              errorPayload(notFound ? "note_not_found" : "write_error"),
            );
          }
        });

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
      },
      onCleanupError: () =>
        console.warn(
          "[atomic-write-bridge] Local REST API extension cleanup failed.",
        ),
    });
    this.register(() => {
      this.restLifecycle?.stop();
      this.restLifecycle = null;
    });
    this.restLifecycle.start();
  }
}

class AtomicWriteSettingsTab extends PluginSettingTab {
  constructor(
    app: any,
    private readonly bridge: OptimikeAtomicWriteBridgePlugin,
  ) {
    super(app, bridge);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Optimike Atomic Write Bridge" });
    new Setting(containerEl)
      .setName("Autoriser les écritures atomiques")
      .setDesc(
        "Désactivé par défaut. Autorise uniquement les remplacements de notes Markdown avec précondition SHA-256 exacte via Local REST API.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.bridge.allowWrites).onChange(async (value) => {
          this.bridge.allowWrites = value;
          await this.bridge.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Autoriser les écritures Canvas atomiques")
      .setDesc(
        "Désactivé par défaut. Autorise uniquement les mutations gouvernées de fichiers JSON Canvas avec précondition SHA-256 exacte et validation du graphe.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.bridge.allowCanvasWrites)
          .onChange(async (value) => {
            this.bridge.allowCanvasWrites = value;
            await this.bridge.saveSettings();
          }),
      );
  }
}
