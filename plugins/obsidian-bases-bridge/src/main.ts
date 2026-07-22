import {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import { normalizeLinkish } from "./link-normalization.mjs";

/** -------- Engine V2 (flag + cache) -------- */
type EngineRow = Record<string, any>;
type EngineSnap = { ts: number; rows: EngineRow[]; total: number };
const ENGINE_CACHE = new Map<string, EngineSnap>();
const ENGINE_CACHE_TTL_MS = 15_000;

interface BridgeSettings {
  engineEnabled: boolean;
}

const DEFAULT_SETTINGS: BridgeSettings = { engineEnabled: false };
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
type BaseConfigResponse = { id: string; yaml: string; json?: Record<string, any> };
type BaseConfigUpsertRequest = {
  yaml?: string;
  json?: Record<string, any>;
  validateOnly?: boolean;
};
type BaseConfigUpsertResponse = { ok: boolean; id: string; warnings?: string[] };
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
  computed?: Record<string, any>;
};
type BaseQueryResponse = {
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
type BaseUpsertRequest = { operations: BaseUpsertOperation[]; continueOnError?: boolean; dryRun?: boolean };
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

function validateUpsertKeys(setObj: Record<string, any>, unsetArr: string[]): string[] {
  return [...Object.keys(setObj), ...unsetArr].filter(isForbiddenUpsertKey);
}

function classifyWriteError(error: any): { code: string; message: string; warnings?: string[] } {
  const message = String(error?.message ?? error);
  if (/processFrontMatter.*timed out|timed out|timeout/i.test(message)) {
    return {
      code: "write_timeout",
      message,
      warnings: [
        "Obsidian appears busy, indexing, locked, or slow while processFrontMatter is running. Retry this operation alone after a short backoff.",
      ],
    };
  }
  return { code: "write_error", message };
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

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
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
    if (ch === "\"" && !inSingle && prev !== "\\") inDouble = !inDouble;

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

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const prev = i > 0 ? input[i - 1]! : "";

    if (ch === "'" && !inDouble && prev !== "\\") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === "\"" && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }

    current += ch;
  }
  parts.push(current);
  return parts;
}

export default class BasesBridgePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  private headlessMounted = false;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new BridgeSettingsTab(this.app, this));

    (this as any).setEngineEnabled = async (on: boolean) => {
      this.settings.engineEnabled = !!on;
      await this.saveData(this.settings);
      console.log("[bases-bridge] ENGINE_ENABLED:", this.settings.engineEnabled);
      if (this.settings.engineEnabled) {
        this.maybeRegisterHeadlessView();
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
      callback: () => console.log((this as any).getEngineState()),
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
      this.app.vault.on("modify", (file: any) => onVaultMutation(String(file?.path ?? "")))
    );
    this.registerEvent(
      this.app.vault.on("create", (file: any) => onVaultMutation(String(file?.path ?? "")))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: any) => onVaultMutation(String(file?.path ?? "")))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file: any, oldPath: string) => {
        onVaultMutation(String(oldPath ?? ""));
        onVaultMutation(String(file?.path ?? ""));
      })
    );

    this.registerRestExtension().catch((error) => {
      console.error("[bases-bridge] Unable to register REST extension:", error);
    });
  }

  onunload(): void {
    console.log("[bases-bridge] unloaded");
  }

  private maybeRegisterHeadlessView(): void {
    if (this.headlessMounted) return;
    this.headlessMounted = true;
    this.registerHeadlessView().catch((error) => {
      console.error("[bases-bridge] Unable to register headless view:", error);
      this.headlessMounted = false;
    });
  }

  private async registerHeadlessView(): Promise<void> {
    let mounted = false;
    const tryMount = async () => {
      if (mounted) return;
      const selfRegister: any = (this as any).registerBasesView;
      if (typeof selfRegister === "function") {
        const disp = selfRegister.call(this, VIEW_TYPE, this.makeHeadlessSpec());
        this.register(cleanupOf(disp));
        console.log("[bases-bridge] Headless view registered via self API");
        mounted = true;
        return;
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
      const externalRegister: any = basesApi?.registerBasesView;
      if (typeof externalRegister === "function") {
        const disp = externalRegister.call(
          basesApi,
          this,
          VIEW_TYPE,
          this.makeHeadlessSpec(),
        );
        this.register(cleanupOf(disp));
        console.log("[bases-bridge] Headless view registered via Bases API");
        mounted = true;
      }
    };
    await tryMount();
    if (!mounted) {
      const interval = window.setInterval(tryMount, 500);
      const timeout = window.setTimeout(() => {
        if (!mounted) console.warn("[bases-bridge] Bases API still unavailable; headless view not mounted");
        window.clearInterval(interval);
      }, 30000);
      this.register(() => {
        window.clearInterval(interval);
        window.clearTimeout(timeout);
      });
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
            for (const entry of entries) rows.push(entry?.values ?? entry?.row ?? entry ?? {});
            ENGINE_CACHE.set(id, { ts: Date.now(), rows, total: rows.length });
          } catch (error) {
            console.error("[bases-bridge] engine sync error:", error);
          }
        };

        try { controller?.onDataUpdated?.(sync); } catch {}
        try { sync(); } catch {}
        return { unload() {} };
      },
    };
  }

  private async ensureEngineForBase(baseId: string): Promise<void> {
    if (!this.settings.engineEnabled) return;
    const key = ensureBaseExt(baseId);
    const snap = ENGINE_CACHE.get(key);
    if (snap && Date.now() - snap.ts <= ENGINE_CACHE_TTL_MS) return;
    if (snap) ENGINE_CACHE.delete(key);

    this.maybeRegisterHeadlessView();
  }

  private invalidateEngineCache(baseId?: string): void {
    if (baseId) {
      ENGINE_CACHE.delete(ensureBaseExt(baseId));
      return;
    }
    ENGINE_CACHE.clear();
  }

  private async readBaseConfig(baseId: string): Promise<{ id: string; file: TFile; yaml: string; json: Record<string, any> }> {
    const path = ensureBaseExt(baseId);
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      throw new Error(`Base introuvable: ${path}`);
    }
    const yaml = await this.app.vault.read(abstract);
    const jsonRaw = parseYaml(yaml);
    const json =
      jsonRaw && typeof jsonRaw === "object" && !Array.isArray(jsonRaw)
        ? (jsonRaw as Record<string, any>)
        : {};

    return { id: path, file: abstract, yaml, json };
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

  private extractSchema(basePath: string, spec: Record<string, any>): BaseSchemaResponse {
    const propertiesValue = spec.properties;
    const formulasValue = spec.formulas;
    const viewsValue = spec.views;

    const properties: BaseSchemaProperty[] = [];
    if (propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)) {
      for (const [key, value] of Object.entries(propertiesValue)) {
        const displayName =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as any).name ?? (value as any).label
            : undefined;
        const valueType =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as any).type ?? (value as any).valueType
            : undefined;
        const kind: BaseSchemaProperty["kind"] =
          key.startsWith("file.") ? "file" : "note";
        properties.push({ key, kind, displayName, valueType });
      }
    }

    if (formulasValue && typeof formulasValue === "object" && !Array.isArray(formulasValue)) {
      for (const [key, value] of Object.entries(formulasValue)) {
        const displayName =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as any).name ?? (value as any).label
            : undefined;
        properties.push({ key, kind: "formula", displayName, valueType: "formula" });
      }
    }

    const views: BaseSchemaView[] = [];
    if (Array.isArray(viewsValue)) {
      for (const view of viewsValue) {
        if (!view || typeof view !== "object" || Array.isArray(view)) continue;
        views.push({
          name: String((view as any).name ?? ""),
          type: String((view as any).type ?? "table"),
          limit: typeof (view as any).limit === "number" ? (view as any).limit : undefined,
          order: Array.isArray((view as any).order)
            ? ((view as any).order as any[]).map((v) => String(v))
            : Array.isArray((view as any).sort)
              ? ((view as any).sort as any[]).map((v) => String(v))
              : undefined,
          filters: (view as any).filters,
          description: typeof (view as any).description === "string" ? (view as any).description : undefined,
        });
      }
    }

    return {
      id: basePath,
      path: basePath,
      name: spec.name ? String(spec.name) : undefined,
      properties,
      formulas: formulasValue && typeof formulasValue === "object" && !Array.isArray(formulasValue) ? (formulasValue as any) : undefined,
      views,
      filters: spec.filters,
    };
  }

  private getFrontmatter(file: TFile): Record<string, any> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    return fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, any>) : {};
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
      for (const t of fmTags.split(/[, ]+/).map((x) => x.trim()).filter(Boolean)) {
        tags.add(t.startsWith("#") ? t.slice(1) : t);
      }
    } else if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === "string" && t.trim()) tags.add(t.startsWith("#") ? t.slice(1) : t);
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
      const raw = typeof (link as any).link === "string" ? (link as any).link : "";
      if (!raw) continue;
      const normalizedLink = raw.replace(/\.md$/i, "");
      if (normalizedLink === normalizedWant || raw === want) return true;
    }
    return false;
  }

  private getValueForRef(file: TFile, ref: string, schema?: BaseSchemaResponse): any {
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

    if (trimmed.startsWith("formula.")) {
      return this.evalFormula(file, trimmed.slice("formula.".length), schema);
    }

    return fm[trimmed];
  }

  private evalFormula(file: TFile, formulaKey: string, schema?: BaseSchemaResponse): any {
    if (!schema?.formulas || typeof schema.formulas !== "object") return undefined;
    const expr = (schema.formulas as any)[formulaKey];
    if (typeof expr !== "string") return undefined;
    return this.evalFormulaExpression(file, expr, schema);
  }

  private isTruthyValue(value: any): boolean {
    return (
      value === true ||
      (typeof value === "string" && value.trim().length > 0) ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (Array.isArray(value) && value.length > 0) ||
      (!!value && typeof value === "object" && Object.keys(value).length > 0)
    );
  }

  private getEngineRowPath(row: any): string | undefined {
    const candidates = [row?.file?.path, row?.path, row?.filePath];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.replace(/\\/g, "/");
      }
    }
    return undefined;
  }

  /**
   * Évalue un sous-ensemble “safe” de formules Bases.
   * Objectif : améliorer le mode fallback quand l’engine est désactivé.
   */
  private evalFormulaExpression(file: TFile, expr: string, schema?: BaseSchemaResponse): any {
    const raw = String(expr ?? "").trim();
    if (!raw) return undefined;

    // Literals
    if (raw === "null") return null;
    if (/^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return stripQuotes(raw);
    }

    // Direct refs
    if (raw.startsWith("file.") || raw.startsWith("note.") || raw.startsWith("formula.")) {
      return this.getValueForRef(file, raw, schema);
    }
    if (/^[\p{L}\p{N}_-]+$/u.test(raw)) {
      return this.getValueForRef(file, raw, schema);
    }

    // join(list(x))
    const joinListMatch = raw.match(/^join\s*\(\s*list\s*\(\s*([^\)]+)\s*\)\s*\)\s*$/s);
    if (joinListMatch) {
      const ref = String(joinListMatch[1] ?? "").trim();
      const v = this.getValueForRef(file, ref, schema);
      const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
      return arr.map((x) => String(x)).join(", ");
    }

    // list(x)
    const listMatch = raw.match(/^list\s*\(\s*([^\)]+)\s*\)\s*$/s);
    if (listMatch) {
      const ref = String(listMatch[1] ?? "").trim();
      const v = this.getValueForRef(file, ref, schema);
      if (v === undefined || v === null) return [];
      return Array.isArray(v) ? v : [v];
    }

    // if(a, b, c)
    const ifMatch = raw.match(/^if\((.*)\)$/s);
    if (ifMatch) {
      const args = splitTopLevelCommas(String(ifMatch[1] ?? "")).map((x) => x.trim());
      if (args.length >= 3) {
        const condExpr = args[0]!;
        const thenExpr = args[1]!;
        const elseExpr = args.slice(2).join(",").trim();

        let condVal = this.evalFormulaExpression(file, condExpr, schema);
        if (condVal === undefined) {
          const condRes = this.evaluateStatement(file, condExpr, schema);
          condVal = condRes.ok;
        }

        return this.isTruthyValue(condVal)
          ? this.evalFormulaExpression(file, thenExpr, schema)
          : this.evalFormulaExpression(file, elseExpr, schema);
      }
    }

    return undefined;
  }

  private buildComputed(file: TFile, schema: BaseSchemaResponse): Record<string, any> {
    const computed: Record<string, any> = {};
    const formulas = schema.formulas ?? {};
    if (formulas && typeof formulas === "object" && !Array.isArray(formulas)) {
      for (const key of Object.keys(formulas)) {
        computed[key] = this.evalFormula(file, key, schema);
      }
    }
    return computed;
  }

  private evaluateStatement(
    file: TFile,
    statement: string,
    schema?: BaseSchemaResponse,
  ): { ok: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const raw = String(statement ?? "").trim();
    if (!raw) return { ok: true, warnings };

    // OR / AND at top-level (simple heuristic, split outside quotes).
    const orParts = splitOutsideQuotes(raw, " or ");
    if (orParts.length > 1) {
      let any = false;
      for (const part of orParts) {
        const res = this.evaluateStatement(file, part, schema);
        warnings.push(...res.warnings);
        if (res.ok) any = true;
      }
      return { ok: any, warnings };
    }
    const orParts2 = splitOutsideQuotes(raw, "||");
    if (orParts2.length > 1) {
      let any = false;
      for (const part of orParts2) {
        const res = this.evaluateStatement(file, part, schema);
        warnings.push(...res.warnings);
        if (res.ok) any = true;
      }
      return { ok: any, warnings };
    }

    const andParts = splitOutsideQuotes(raw, " and ");
    if (andParts.length > 1) {
      for (const part of andParts) {
        const res = this.evaluateStatement(file, part, schema);
        warnings.push(...res.warnings);
        if (!res.ok) return { ok: false, warnings };
      }
      return { ok: true, warnings };
    }
    const andParts2 = splitOutsideQuotes(raw, "&&");
    if (andParts2.length > 1) {
      for (const part of andParts2) {
        const res = this.evaluateStatement(file, part, schema);
        warnings.push(...res.warnings);
        if (!res.ok) return { ok: false, warnings };
      }
      return { ok: true, warnings };
    }

    // Unary not
    if (raw.startsWith("not ")) {
      const res = this.evaluateStatement(file, raw.slice(4), schema);
      warnings.push(...res.warnings);
      return { ok: !res.ok, warnings };
    }
    if (raw.startsWith("!")) {
      const res = this.evaluateStatement(file, raw.slice(1), schema);
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
      const folder = stripQuotes(inFolderMatch[1]).replace(/\\/g, "/").replace(/\/+$/g, "");
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
      let needle = this.getValueForRef(file, needleRef, schema);
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
    const folderStartsWithMatch = raw.match(/^file\.folder\.startsWith\((.+)\)$/);
    if (folderStartsWithMatch) {
      const prefix = stripQuotes(folderStartsWithMatch[1]).replace(/\\/g, "/").replace(/\/+$/g, "");
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
      /^list\(([\p{L}\p{N}_-]+)\)\.contains\(link\((.+)\)\)$/u
    );
    if (listPropContainsLinkMatch) {
      const key = listPropContainsLinkMatch[1];
      const targetRaw = stripQuotes(listPropContainsLinkMatch[2]);
      const want = normalizeLinkish(targetRaw);
      const v = this.getValueForRef(file, key, schema);
      const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
      const ok = arr.some((x) => normalizeLinkish(String(x)) === want);
      return { ok, warnings };
    }
    const propContainsLinkMatch = raw.match(/^([\p{L}\p{N}_-]+)\.contains\(link\((.+)\)\)$/u);
    if (propContainsLinkMatch) {
      const key = propContainsLinkMatch[1];
      const targetRaw = stripQuotes(propContainsLinkMatch[2]);
      const want = normalizeLinkish(targetRaw);
      const v = this.getValueForRef(file, key, schema);
      const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
      const ok = arr.some((x) => normalizeLinkish(String(x)) === want);
      return { ok, warnings };
    }

    // Generic contains/startsWith on simple file.* fields
    const fileFieldOpMatch = raw.match(/^file\.(path|name|folder|ext)\.(contains|startsWith)\((.+)\)$/);
    if (fileFieldOpMatch) {
      const field = `file.${fileFieldOpMatch[1]}`;
      const op = fileFieldOpMatch[2];
      const needle = stripQuotes(fileFieldOpMatch[3]);
      const hay = String(this.getValueForRef(file, field, schema) ?? "");
      if (op === "contains") return { ok: hay.includes(needle), warnings };
      return { ok: hay.startsWith(needle), warnings };
    }

    // Comparisons: support ==, =, !=, >=, <=, >, <
    const opMatch = raw.match(/^(.*?)\s*(==|=|!=|>=|<=|>|<)\s*(.*?)\s*$/);
    if (opMatch) {
      const leftRef = opMatch[1].trim();
      const op = opMatch[2];
      const rightRaw = opMatch[3].trim();

      const left = this.getValueForRef(file, leftRef, schema);
      let right: any = stripQuotes(rightRaw);
      if (/^(true|false)$/i.test(rightRaw)) right = /^true$/i.test(rightRaw);
      else if (/^-?\d+(\.\d+)?$/.test(rightRaw)) right = Number(rightRaw);

      const leftNum = typeof left === "number" ? left : Number(left);
      const rightNum = typeof right === "number" ? right : Number(right);
      const bothNumeric = Number.isFinite(leftNum) && Number.isFinite(rightNum);
      const numericOp = op === ">" || op === "<" || op === ">=" || op === "<=";
      if (numericOp && typeof right === "number" && !Number.isFinite(leftNum)) {
        return { ok: false, warnings };
      }

      switch (op) {
        case "==":
        case "=":
          return { ok: bothNumeric ? leftNum === rightNum : String(left) === String(right), warnings };
        case "!=":
          return { ok: bothNumeric ? leftNum !== rightNum : String(left) !== String(right), warnings };
        case ">":
          return { ok: bothNumeric ? leftNum > rightNum : String(left) > String(right), warnings };
        case "<":
          return { ok: bothNumeric ? leftNum < rightNum : String(left) < String(right), warnings };
        case ">=":
          return { ok: bothNumeric ? leftNum >= rightNum : String(left) >= String(right), warnings };
        case "<=":
          return { ok: bothNumeric ? leftNum <= rightNum : String(left) <= String(right), warnings };
      }
    }

    // Bare identifier: treat as "truthy" frontmatter key (used a lot in Bases configs)
    // Ex: `- groupe_réunion` or `- sas_statut`
    if (/^[\p{L}\p{N}_-]+$/u.test(raw)) {
      const v = this.getValueForRef(file, raw, schema);
      const ok =
        v === true ||
        (typeof v === "string" && v.trim().length > 0) ||
        (typeof v === "number" && Number.isFinite(v)) ||
        (Array.isArray(v) && v.length > 0) ||
        (v && typeof v === "object" && Object.keys(v).length > 0);
      return { ok, warnings };
    }

    warnings.push(`Filter non reconnu: ${raw}`);
    return { ok: true, warnings };
  }

  private evaluateFilter(file: TFile, filter: any, schema?: BaseSchemaResponse): { ok: boolean; warnings: string[] } {
    if (!filter) return { ok: true, warnings: [] };
    if (typeof filter === "string") return this.evaluateStatement(file, filter, schema);

    if (typeof filter === "object" && !Array.isArray(filter)) {
      if (Array.isArray((filter as any).and)) {
        const warnings: string[] = [];
        for (const part of (filter as any).and) {
          const res = this.evaluateFilter(file, part, schema);
          warnings.push(...res.warnings);
          if (!res.ok) return { ok: false, warnings };
        }
        return { ok: true, warnings };
      }
      if (Array.isArray((filter as any).or)) {
        const warnings: string[] = [];
        let any = false;
        for (const part of (filter as any).or) {
          const res = this.evaluateFilter(file, part, schema);
          warnings.push(...res.warnings);
          if (res.ok) any = true;
        }
        return { ok: any, warnings };
      }
      if ((filter as any).not) {
        const res = this.evaluateFilter(file, (filter as any).not, schema);
        return { ok: !res.ok, warnings: res.warnings };
      }
    }

    // Unknown filter shape: accept but warn.
    return { ok: true, warnings: ["Filter non supporté (shape inconnu)."] };
  }

  private buildRowProps(file: TFile, schema: BaseSchemaResponse): Record<string, any> {
    const props: Record<string, any> = {};
    for (const p of schema.properties) {
      if (p.kind === "formula") {
        // Best-effort: évaluer un sous-ensemble de formules (utile sans engine)
        props[p.key] = this.getValueForRef(file, `formula.${p.key}`, schema);
        continue;
      }
      props[p.key] = this.getValueForRef(file, p.key, schema);
    }
    return props;
  }

  private async registerRestExtension(): Promise<void> {
    await new Promise<void>((resolve) => this.app.workspace.onLayoutReady(() => resolve()));
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

      if (typeof getPublicApi === "function") {
        const api = getPublicApi(this.manifest);
        if (!api || typeof api.addRoute !== "function") return;

        console.log(`[bases-bridge] Registered API extension via Local REST API (prefix=${REST_PREFIX})`);

        api.addRoute(`${REST_PREFIX}/ping`).get((_req: any, res: any) =>
          res.json({
            ok: true,
            id: this.manifest.id,
            version: this.manifest.version,
            engineEnabled: this.settings.engineEnabled,
            engineReady: this.settings.engineEnabled && ENGINE_CACHE.size > 0,
            cacheSize: ENGINE_CACHE.size,
          }),
        );

        api.addRoute(`${REST_PREFIX}/debug/engine-keys`).get((_req: any, res: any) =>
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
        api.addRoute(`${REST_PREFIX}/bases`).get(listBases);
        api.addRoute(`/bases`).get(listBases);

        const getBaseConfig = async (req: any, res: any) => {
          const id = normBaseId(req.params?.id);
          const config = await this.readBaseConfig(id);
          const response: BaseConfigResponse = { id: config.id, yaml: config.yaml, json: config.json };
          res.json(response);
        };

        api.addRoute(`${REST_PREFIX}/bases/:id(*)/config`).get(getBaseConfig);
        api.addRoute(`/bases/:id(*)/config`).get(getBaseConfig);

        const putBaseConfig = async (req: any, res: any) => {
          const id = normBaseId(req.params?.id);
          const path = ensureBaseExt(id);
          const body: BaseConfigUpsertRequest = (req.body ?? {}) as any;
          const validateOnly = !!body?.validateOnly;

          let nextYaml = "";
          const warnings: string[] = [];

          if (typeof body?.yaml === "string" && body.yaml.trim()) {
            const parsed = parseYaml(body.yaml);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              const response: BaseConfigUpsertResponse = {
                ok: false,
                id: path,
                warnings: ["YAML invalide: root doit être un objet."],
              };
              res.json(response);
              return;
            }
            nextYaml = body.yaml;
          } else if (body?.json && typeof body.json === "object" && !Array.isArray(body.json)) {
            nextYaml = stringifyYaml(body.json);
          } else {
            const response: BaseConfigUpsertResponse = {
              ok: false,
              id: path,
              warnings: ["Payload requis: yaml ou json."],
            };
            res.json(response);
            return;
          }

          if (validateOnly) {
            const response: BaseConfigUpsertResponse = { ok: true, id: path, warnings };
            res.json(response);
            return;
          }

          await this.ensureFoldersFor(path);
          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile) await this.app.vault.modify(existing, nextYaml);
          else await this.app.vault.create(path, nextYaml);

          const response: BaseConfigUpsertResponse = { ok: true, id: path, warnings };
          res.json(response);
        };

        api.addRoute(`${REST_PREFIX}/bases/:id(*)/config`).put(putBaseConfig);
        api.addRoute(`/bases/:id(*)/config`).put(putBaseConfig);

        const createBase = async (req: any, res: any) => {
          const body: BaseCreateRequest = (req.body ?? {}) as any;
          const path = ensureBaseExt(String(body?.path ?? ""));
          if (!path || path === ".base") {
            const response: BaseCreateResponse = { ok: false, id: path || "", warnings: ["path requis."] };
            res.json(response);
            return;
          }
          if (!body?.spec || typeof body.spec !== "object" || Array.isArray(body.spec)) {
            const response: BaseCreateResponse = { ok: false, id: path, warnings: ["spec doit être un objet."] };
            res.json(response);
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
              warnings: [`spec non sérialisable: ${String(e?.message ?? e)}`],
            };
            res.json(response);
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
            const response: BaseCreateResponse = { ok: true, id: path, created: false, overwritten: false };
            res.json(response);
            return;
          }

          await this.ensureFoldersFor(path);
          if (existing instanceof TFile) {
            await this.app.vault.modify(existing, yaml);
            const response: BaseCreateResponse = { ok: true, id: path, created: false, overwritten: true };
            res.json(response);
            return;
          }
          await this.app.vault.create(path, yaml);
          const response: BaseCreateResponse = { ok: true, id: path, created: true, overwritten: false };
          res.json(response);
        };

        api.addRoute(`${REST_PREFIX}/bases`).post(createBase);
        api.addRoute(`/bases`).post(createBase);

        const getBaseSchema = async (req: any, res: any) => {
          const id = normBaseId(req.params?.id);
          const config = await this.readBaseConfig(id);
          const schema = this.extractSchema(config.id, config.json);
          res.json(schema);
        };

        api.addRoute(`${REST_PREFIX}/bases/:id(*)/schema`).get(getBaseSchema);
        api.addRoute(`/bases/:id(*)/schema`).get(getBaseSchema);

        const queryBase = async (req: any, res: any) => {
          const id = normBaseId(req.params?.id);
          await this.ensureEngineForBase(id);
          const body: BaseQueryRequest = (req.body ?? {}) as any;
          const config = await this.readBaseConfig(id);
          const schema = this.extractSchema(config.id, config.json);

          const viewName = typeof body?.view === "string" ? body.view : undefined;
          const view = viewName ? schema.views.find((v) => v.name === viewName) : schema.views[0];

          const limit = clampInt(body?.limit ?? view?.limit ?? 20, 20, 1, 500);
          const page = clampInt(body?.page ?? 1, 1, 1, 1_000_000);

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
          const combinedFilter = { and: [schema.filters, view?.filters, body?.filter].filter(Boolean) };

          const files = this.app.vault
            .getFiles()
            .filter((f) => !f.path.startsWith(".obsidian/") && f.extension !== "base");

          const matches: TFile[] = [];
          for (const f of files) {
            if (!(f instanceof TFile)) continue;
            const r = this.evaluateFilter(f, combinedFilter, schema);
            addWarnings(r.warnings);
            if (r.ok) matches.push(f);
          }

          const sortSpecs: Array<{ prop: string; dir: "asc" | "desc" }> = [];
          if (Array.isArray(body?.sort) && body.sort.length > 0) {
            for (const s of body.sort) {
              if (!s || typeof s !== "object") continue;
              const prop = String((s as any).prop ?? "").trim();
              if (!prop) continue;
              const dir =
                String((s as any).dir ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";
              sortSpecs.push({ prop, dir });
            }
          } else if (Array.isArray(view?.order)) {
            for (const raw of view.order) {
              const str = String(raw);
              const dir: "asc" | "desc" = str.trim().startsWith("-") ? "desc" : "asc";
              const prop = str.trim().startsWith("-") ? str.trim().slice(1) : str.trim();
              if (prop) sortSpecs.push({ prop, dir });
            }
          }

          if (sortSpecs.length > 0) {
            matches.sort((a, b) => {
              for (const { prop, dir } of sortSpecs) {
                const av = this.getValueForRef(a, prop, schema);
                const bv = this.getValueForRef(b, prop, schema);
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

          const total = matches.length;
          const start = (page - 1) * limit;
          const slice = matches.slice(start, start + limit);

          const rows: BaseQueryRow[] = slice.map((file) => ({
            file: { path: file.path, name: file.basename },
            props: this.buildRowProps(file, schema),
            computed: body?.evaluate ? this.buildComputed(file, schema) : undefined,
          }));

          const evaluate = !!body?.evaluate;
          const shouldEngine = evaluate && this.settings.engineEnabled;
          let snap = shouldEngine ? ENGINE_CACHE.get(ensureBaseExt(id)) : undefined;
          if (shouldEngine && !snap) {
            const engineRows: BaseQueryRow[] = matches.map((file) => ({
              file: { path: file.path, name: file.basename },
              props: this.buildRowProps(file, schema),
              computed: this.buildComputed(file, schema),
            }));
            snap = { ts: Date.now(), rows: engineRows as any, total: engineRows.length };
            ENGINE_CACHE.set(ensureBaseExt(id), snap);
          }
          const warnings = Array.from(warningsSet).sort((a, b) => a.localeCompare(b));
          if (warningsTruncated) warnings.push("Warnings tronqués (max 200).");

          if (evaluate && shouldEngine && snap) {
            const cachedRowsByPath = new Map<string, any>();
            for (const rawRow of snap.rows ?? []) {
              const rowPath = this.getEngineRowPath(rawRow);
              if (!rowPath || cachedRowsByPath.has(rowPath)) continue;
              cachedRowsByPath.set(rowPath, rawRow);
            }

            const alignedRows: BaseQueryRow[] = matches.map((file) => {
              const cached = cachedRowsByPath.get(file.path);
              if (cached && cached.file && cached.props) return cached as BaseQueryRow;
              if (cached) {
                const inferredPath = this.getEngineRowPath(cached) ?? file.path;
                const inferredName =
                  typeof cached?.file?.name === "string" && cached.file.name.trim().length > 0
                    ? cached.file.name
                    : file.basename;
                return {
                  file: { path: inferredPath, name: inferredName },
                  props:
                    cached?.props && typeof cached.props === "object"
                      ? cached.props
                      : this.buildRowProps(file, schema),
                  computed:
                    cached?.computed && typeof cached.computed === "object"
                      ? cached.computed
                      : this.buildComputed(file, schema),
                };
              }
              return {
                file: { path: file.path, name: file.basename },
                props: this.buildRowProps(file, schema),
                computed: this.buildComputed(file, schema),
              };
            });

            const startEngine = (page - 1) * limit;
            const engineRows = alignedRows.slice(startEngine, startEngine + limit);
            const response: BaseQueryResponse = {
              total: alignedRows.length,
              page,
              rows: engineRows as any,
              evaluate,
              source: "engine",
              warnings,
            };
            res.json(response);
            return;
          }

          const response: BaseQueryResponse = {
            total,
            page,
            rows,
            evaluate,
            source: "fallback",
            warnings,
          };
          res.json(response);
        };

        api.addRoute(`${REST_PREFIX}/bases/:id(*)/query`).post(queryBase);
        api.addRoute(`/bases/:id(*)/query`).post(queryBase);

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
                error: { code: "validation_error", message: "Opération sans champ 'file'." },
              });
              if (!continueOnError) break;
              continue;
            }

            const abstract = this.app.vault.getAbstractFileByPath(filePath);
            if (!(abstract instanceof TFile)) {
              results.push({
                file: filePath,
                mtime: 0,
                error: { code: "not_found", message: `Note introuvable: ${filePath}` },
              });
              if (!continueOnError) break;
              continue;
            }

            const expected = typeof op?.expected_mtime === "number" ? op.expected_mtime : undefined;
            if (expected && abstract.stat.mtime !== expected) {
              results.push({
                file: filePath,
                mtime: abstract.stat.mtime,
                error: { code: "mtime_conflict", message: `Conflit mtime (expected=${expected}, actual=${abstract.stat.mtime}).` },
              });
              if (!continueOnError) break;
              continue;
            }

            const setObj =
              op?.set && typeof op.set === "object" && !Array.isArray(op.set) ? (op.set as Record<string, any>) : {};
            const unsetArr = Array.isArray(op?.unset) ? (op.unset.filter((k: any) => typeof k === "string") as string[]) : [];
            const forbiddenKeys = validateUpsertKeys(setObj, unsetArr);
            if (forbiddenKeys.length > 0) {
              results.push({
                file: filePath,
                mtime: abstract.stat.mtime,
                error: {
                  code: "forbidden_key",
                  message: `Clés non modifiables via Bases Bridge: ${forbiddenKeys.join(", ")}`,
                },
              });
              if (!continueOnError) break;
              continue;
            }

            try {
              const changedKeys: string[] = [];
              for (const k of Object.keys(setObj)) changedKeys.push(k);

              if (!dryRun) {
                await (this.app as any).fileManager.processFrontMatter(abstract, (fm: any) => {
                  for (const [k, v] of Object.entries(setObj)) {
                    fm[k] = v;
                  }
                  for (const k of unsetArr) {
                    if (k in fm) delete fm[k];
                  }
                });
              }

              results.push({
                file: filePath,
                mtime: abstract.stat.mtime,
                changed: { keys: changedKeys, unset: unsetArr.length ? unsetArr : undefined },
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
          res.json(response);
        };

        api.addRoute(`${REST_PREFIX}/bases/:id(*)/upsert`).post(upsertBase);
        api.addRoute(`/bases/:id(*)/upsert`).post(upsertBase);

        this.register(() => {
          try {
            api.unregister?.();
          } catch {}
        });

        mounted = true;
      }
    };
    tryMount();
    if (!mounted) {
      const interval = window.setInterval(tryMount, 500);
      const timeout = window.setTimeout(() => {
        if (!mounted) {
          console.warn("[bases-bridge] Local REST API extension API not available; skipping extension mount");
          console.warn("[bases-bridge] Conseil: vérifiez que 'obsidian-local-rest-api' est actif (v3.x) et relancez Obsidian.");
        }
        window.clearInterval(interval);
      }, 30000);
      this.register(() => {
        window.clearInterval(interval);
        window.clearTimeout(timeout);
      });
    }
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
      .setName("Activer l’engine v2 (évaluations natives)")
      .setDesc(
        "ON: queries renvoient source:\"engine\" (cache auto + headless si dispo). OFF: fallback disque.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.engineEnabled)
          .onChange(async (value) => {
            await (this.plugin as any).setEngineEnabled(value);
          }),
      );
  }
}
