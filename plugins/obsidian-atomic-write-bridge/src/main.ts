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

type PluginData = {
  instanceId: string;
  allowWrites: boolean;
  allowCanvasWrites: boolean;
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
  target.json(payload);
}

function errorPayload(code: string, message: string, details?: object) {
  return {
    ok: false,
    contractVersion: ATOMIC_WRITE_CONTRACT_VERSION,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

export default class OptimikeAtomicWriteBridgePlugin extends Plugin {
  private instanceId = "";
  private bindingFingerprint = "";
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

  private file(path: string, label = "Note"): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${label} not found.`);
    return file;
  }

  private async registerRestExtension(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.app.workspace.onLayoutReady(() => resolve()),
    );
    let mounted = false;
    const tryMount = () => {
      if (mounted) return;
      const restPlugin: any =
        (this.app as any).plugins?.plugins?.["obsidian-local-rest-api"] ??
        (this.app as any).plugins?.getPlugin?.("obsidian-local-rest-api");
      const getPublicApi =
        typeof restPlugin?.getPublicApi === "function"
          ? restPlugin.getPublicApi.bind(restPlugin)
          : undefined;
      if (!getPublicApi) return;
      const api = getPublicApi(this.manifest);
      if (!api || typeof api.addRoute !== "function") return;

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
          try {
            const request = parseCanvasReadRequest(req?.body);
            const content = await this.app.vault.read(
              this.file(request.path, "Canvas"),
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
            const notFound =
              error instanceof Error && error.message === "Canvas not found.";
            sendJson(
              res,
              notFound ? 404 : 400,
              errorPayload(
                notFound ? "canvas_not_found" : "invalid_request",
                error instanceof Error ? error.message : String(error),
              ),
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
            const request = parseCanvasCasRequest(req?.body);
            assertBindingFingerprint(
              request.bindingFingerprint,
              this.bindingFingerprint,
            );
            let beforeSha256 = "";
            const written = await this.app.vault.process(
              this.file(request.path, "Canvas"),
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
            if (error instanceof BindingConflictError) {
              sendJson(
                res,
                409,
                errorPayload("binding_conflict", error.message),
              );
              return;
            }
            if (error instanceof HashConflictError) {
              sendJson(
                res,
                409,
                errorPayload("hash_conflict", error.message, {
                  actualSha256: error.actualSha256,
                }),
              );
              return;
            }
            const notFound =
              error instanceof Error && error.message === "Canvas not found.";
            sendJson(
              res,
              notFound ? 404 : 400,
              errorPayload(
                notFound ? "canvas_not_found" : "invalid_request",
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
        });

      api
        .addRoute(`${ATOMIC_WRITE_REST_PREFIX}/notes/read`)
        .post(async (req: any, res: any) => {
          try {
            const request = parseReadRequest(req?.body);
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
            const notFound =
              error instanceof Error && error.message === "Note not found.";
            sendJson(
              res,
              notFound ? 404 : 400,
              errorPayload(
                notFound ? "note_not_found" : "invalid_request",
                error instanceof Error ? error.message : String(error),
              ),
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
            const request = parseCasRequest(req?.body);
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
            if (error instanceof BindingConflictError) {
              sendJson(
                res,
                409,
                errorPayload("binding_conflict", error.message),
              );
              return;
            }
            if (error instanceof HashConflictError) {
              sendJson(
                res,
                409,
                errorPayload("hash_conflict", error.message, {
                  actualSha256: error.actualSha256,
                }),
              );
              return;
            }
            const notFound =
              error instanceof Error && error.message === "Note not found.";
            sendJson(
              res,
              notFound ? 404 : 400,
              errorPayload(
                notFound ? "note_not_found" : "invalid_request",
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
        });

      this.register(() => {
        try {
          api.unregister?.();
        } catch {
          // Local REST API owns the route registry lifecycle.
        }
      });
      mounted = true;
    };

    tryMount();
    if (!mounted) {
      const interval = window.setInterval(tryMount, 500);
      const timeout = window.setTimeout(() => {
        window.clearInterval(interval);
        if (!mounted) {
          console.warn(
            "[atomic-write-bridge] Local REST API extension API unavailable.",
          );
        }
      }, 30_000);
      this.register(() => {
        window.clearInterval(interval);
        window.clearTimeout(timeout);
      });
    }
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
