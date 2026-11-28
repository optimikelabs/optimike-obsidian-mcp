
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { parseToolInput } from "../../utils/internal/toolInputValidation.js";
import { requestContextService } from "../../utils/index.js";
import type { VaultCacheService } from "../obsidianRestAPI/vaultCache/index.js";
import { VaultFileService } from "../vaultFileService.js";
import {
  OPERON_CONTRACT_VERSION, OPERON_PUBLIC_INPUT_MESSAGES, OPERON_SNAPSHOT_SCHEMA_VERSION,
  OperonCapabilitiesSchema, OperonQuerySchema, OperonTaskFinderSchema, OperonRelationshipsSchema,
  OperonFilterQuerySchema, queryOperonSnapshot, resolveOperonPriorityStableId, parseOperonCursor, stripOperonTaskProperties,
  type OperonSnapshotEnvelope, type OperonTask, type OperonRelationships,
} from "./contract.js";
import {
  digest, object, parseOperonMarkdown, projectFilesystemConfiguration,
  projectFilesystemTask, splitOperonList, type FilesystemConfiguration,
} from "./filesystemFormat.js";
import { compileSavedFilter, localDate } from "./filesystemFilters.js";

const baseLimitations = [
  "Reads reflect the synchronized copy and the shared cache, not Obsidian Desktop.",
  "Filesystem revisions cannot authorize native mutations. Templates, active timers, native ranking and inferred runtime relationships are unavailable.",
];
const matchesPath = (path: string, scope: string) => path === scope || path.startsWith(scope + "/");

type ParsedFile = {
  hash: string;
  mtime: number;
  ctime: number;
  invalidFrontmatter: boolean;
  sourceDigest: string;
  tasks: { task: OperonTask; tierExpiresAt: number }[];
};

function unavailable(reasonCode: string, message: string): never {
  throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, message, { reasonCode });
}

const readers = new WeakMap<VaultCacheService, FilesystemOperonService>();
export function filesystemOperonService(cache?: VaultCacheService): FilesystemOperonService {
  if (!cache) return new FilesystemOperonService();
  let reader = readers.get(cache);
  if (!reader) {
    reader = new FilesystemOperonService(cache);
    readers.set(cache, reader);
  }
  return reader;
}

export class FilesystemOperonService {
  private files = new Map<string, ParsedFile>();
  private configurationSignature: string | null = null;
  private sequence = 0;
  private readonly sessionId = randomUUID();
  private pending: ReturnType<FilesystemOperonService["read"]> | undefined;

  constructor(private readonly cache?: VaultCacheService) {}

  provenance() {
    const stats = this.cache?.getStats();
    return {
      source: "filesystem" as const,
      freshness: stats?.freshness ?? "unknown",
      cacheStatus: stats?.status ?? "empty",
      lastRefreshAt: stats?.lastRefreshAt ?? null,
      lastRefreshCompletedAt: stats?.lastRefreshCompletedAt ?? null,
      partial: !this.cache?.isReady(),
    };
  }

  private async pluginData(name: string): Promise<Record<string, unknown> | null> {
    if (!config.obsidianVaultPath) return null;
    try {
      const file = await new VaultFileService().read(
        ".obsidian/plugins/operon/" + name,
        requestContextService.createRequestContext({ operation: "readFilesystemOperonConfiguration" }),
      );
      const parsed: unknown = JSON.parse(file.content.replace(/^\uFEFF/u, ""));
      if (parsed !== object(parsed)) throw new Error("invalid object");
      return object(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return unavailable("operon_filesystem_configuration_invalid", "The Operon plugin data could not be read as a JSON object inside this vault.");
    }
  }

  private async read(forceRefresh: boolean) {
    if (!this.cache) return unavailable("operon_filesystem_cache_unavailable", "Headless Operon reads require the shared vault cache.");
    if (forceRefresh) await this.cache.refreshCache(true);
    const [data, manifest] = await Promise.all([this.pluginData("data.json"), this.pluginData("manifest.json")]);
    const version = typeof manifest?.version === "string" ? manifest.version : "unknown";
    let configuration: FilesystemConfiguration;
    try {
      if (data && "taxonomy" in data && data.schemaVersion !== 2 && data.schemaVersion !== 3) {
        throw new Error("Unsupported package version");
      }
      configuration = projectFilesystemConfiguration(data ?? {});
    } catch {
      return unavailable("operon_filesystem_configuration_invalid", "The Operon settings package uses an unsupported format.");
    }
    const settingsSignature = "filesystem-sha256:" + digest(JSON.stringify([configuration, version]));
    const previous = this.configurationSignature === settingsSignature ? this.files : new Map<string, ParsedFile>();
    const next = new Map<string, ParsedFile>();
    const paths = configuration.indexing.excludedFolders.map(p => p.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, ""));
    const now = Date.now();
    const tasks: OperonTask[] = [];
    const sourceDigests = new Map<OperonTask, string>();
    const invalidFrontmatter: string[] = [];
    let missingEntry = false;
    const start = this.provenance();
    for (const entry of this.cache.getEntriesByPrefix()) {
      const path = entry.path.replace(/^\//u, "");
      if (paths.some(excluded => excluded && matchesPath(path, excluded))) continue;
      let parsed = previous.get(path);
      if (parsed?.hash !== entry.hash || parsed.mtime !== entry.mtime || parsed.ctime !== entry.ctime) {
        const content = await this.cache.getEntry(entry.path);
        if (!content || content.hash !== entry.hash || content.mtime !== entry.mtime || content.ctime !== entry.ctime) {
          missingEntry = true;
          continue;
        }
        const markdown = parseOperonMarkdown(content.content, path, configuration);
        parsed = { hash: entry.hash, mtime: entry.mtime, ctime: entry.ctime,
          invalidFrontmatter: markdown.invalidFrontmatter,
          sourceDigest: markdown.tasks.length ? digest(content.content) : "",
          tasks: markdown.tasks.map(raw => {
          const task = { ...projectFilesystemTask(raw, path, entry, configuration, now), operonVersion: version };
          const terminalDate = task.dates.completed ?? task.dates.cancelled;
          return {
            task,
            tierExpiresAt: terminalDate && task.tier === "warm" ? Date.parse(terminalDate) + 90 * 86_400_000 : Infinity,
          };
        }) };
      }
      next.set(path, parsed);
      if (parsed.invalidFrontmatter) invalidFrontmatter.push(path);
      for (const item of parsed.tasks) {
        const task = now > item.tierExpiresAt ? { ...item.task, tier: "cold" as const } : item.task;
        tasks.push(task);
        sourceDigests.set(task, parsed.sourceDigest);
      }
    }
    const changed = previous !== this.files || next.size !== previous.size ||
      [...next].some(([path, parsed]) => previous.get(path) !== parsed);
    this.files = next;
    this.configurationSignature = settingsSignature;
    if (changed) this.sequence++;
    const provenance = this.provenance();
    if (missingEntry || start.partial || start.lastRefreshAt !== provenance.lastRefreshAt) {
      provenance.partial = true;
      provenance.freshness = "uncertain";
    }
    const limitations = [...baseLimitations];
    if (!data) limitations.push("Operon data.json is absent. Only canonical fields can be decoded; workflow and saved-filter definitions are unavailable.");
    const timestamp = typeof provenance.lastRefreshAt === "number" ? provenance.lastRefreshAt : now;
    const snapshot: OperonSnapshotEnvelope = {
      source: "filesystem", stale: provenance.partial,
      snapshotAt: new Date(timestamp).toISOString(), snapshotAgeMs: Math.max(0, now - timestamp),
      operonVersion: version, bridgeVersion: "unavailable", contractVersion: OPERON_CONTRACT_VERSION,
      snapshotSchemaVersion: OPERON_SNAPSHOT_SCHEMA_VERSION, settingsSignature, generation: this.sequence,
      capabilities: OperonCapabilitiesSchema.parse({
        status: true, configuration: Boolean(data), list: true, get: true, query: true, validate: true,
        finder: true, relationships: true, filterQuery: configuration.views.filters.length > 0,
        create: false, update: false, transition: false, convert: false,
      }),
      tasks, limitations,
    };
    const pinData = object(object(data?.state).pinnedTasks);
    const pinItems = pinData.itemsById ?? (await this.pluginData("state/pinned-tasks.json"))?.itemsById;
    const settings = object(data?.settings ?? data);
    const recent = settings.taskFinderRecentModifiedDays ?? object(object(data?.ui).taskUiPreferences).taskFinderRecentModifiedDays;
    const recentDays = typeof recent === "number" && Number.isFinite(recent) ? Math.max(1, Math.min(7, Math.round(recent))) : 3;
    return { snapshot, configuration, provenance, invalidFrontmatter, sourceDigests, recentDays,
      pinned: pinItems ? new Set(Object.entries(object(pinItems)).filter(([, item]) => object(item).pinned === true).map(([id]) => id)) : null };
  }

  private async view(forceRefresh = false) {
    if (forceRefresh && this.pending) await this.pending.catch(() => undefined);
    if (this.pending) return this.pending;
    const pending = this.read(forceRefresh);
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  async query(input: unknown, signal?: AbortSignal) {
    const query = parseToolInput(OperonQuerySchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    const view = await this.view(query.forceRefresh);
    signal?.throwIfAborted();
    return { ...queryOperonSnapshot(view.snapshot, query), ...view.provenance };
  }

  async getTask(options: { operonId: string; includeProperties?: boolean; forceRefresh?: boolean }, signal?: AbortSignal) {
    const page = await this.query({ ...options, operonIds: [options.operonId], limit: 2 }, signal);
    const { tasks, total, count: _count, cursor: _cursor, nextCursor: _next, hasMore: _more, snapshotSchemaVersion: _schema, ...metadata } = page;
    if (total > 1) throw new McpError(BaseErrorCode.CONFLICT, "Multiple sources declare this Operon ID.", { reasonCode: "operon_filesystem_duplicate_id" });
    if (total === 0) {
      if (page.partial) return unavailable("operon_filesystem_cache_partial", "The shared vault cache is incomplete. Retry when it is ready.");
      throw new McpError(BaseErrorCode.NOT_FOUND, "The requested Operon task does not exist in the shared cache.");
    }
    return { ...metadata, task: tasks[0] };
  }

  async status(forceRefresh = false) {
    const { snapshot, provenance } = await this.view(forceRefresh);
    const { tasks, source: _source, stale, limitations, ...metadata } = snapshot;
    return { ok: !provenance.partial, ...provenance, stale, snapshot: { ...metadata, taskCount: tasks.length }, limitations };
  }

  async configuration(forceRefresh = false) {
    const { snapshot, configuration, provenance } = await this.view(forceRefresh);
    if (!snapshot.capabilities.configuration) return unavailable("operon_filesystem_configuration_missing", "Operon data.json is absent from this vault copy.");
    const { contractVersion, stale, operonVersion, bridgeVersion, settingsSignature, limitations } = snapshot;
    return { ok: true, ...provenance, contractVersion, stale, operonVersion, bridgeVersion, settingsSignature, configuration, limitations };
  }

  async querySavedFilter(input: unknown) {
    const query = parseToolInput(OperonFilterQuerySchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    const { snapshot, provenance, configuration, pinned } = await this.view();
    const filter = configuration.views.filters.find(item => item.id === query.filterSetId);
    if (!snapshot.capabilities.configuration) return unavailable("operon_filesystem_configuration_missing", "Operon data.json is absent from this vault copy.");
    if (!filter) throw new McpError(BaseErrorCode.NOT_FOUND, "No saved Operon filter has this ID in the synchronized settings.");
    let compiled: ReturnType<typeof compileSavedFilter>;
    try { compiled = compileSavedFilter(filter.definition, pinned, configuration, new Date()); }
    catch { return unavailable("operon_filesystem_filter_unsupported", "This saved filter uses semantics unavailable in headless mode. Query it through the Desktop Bridge."); }
    const scope = query.scopePath;
    const tasks = snapshot.tasks.filter(task => (!scope || matchesPath(task.path, scope)) && compiled.predicate(task)).sort(compiled.compare);
    const offset = parseOperonCursor(query.cursor);
    const page = tasks.slice(offset, offset + query.limit);
    const next = offset + page.length;
    const { tasks: _full, source: _source, ...metadata } = snapshot;
    return { ok: true, ...metadata, ...provenance, total: tasks.length, count: page.length, cursor: String(offset),
      hasMore: next < tasks.length, ...(next < tasks.length ? { nextCursor: String(next) } : {}),
      tasks: query.includeProperties ? page : page.map(stripOperonTaskProperties) };
  }

  async validate(forceRefresh = false) {
    const { snapshot, invalidFrontmatter, provenance } = await this.view(forceRefresh);
    const ids = new Set<string>();
    const violations: { severity: "P0" | "P1" | "P2"; code: string; operonId?: string; path?: string; target?: string }[] = [];
    for (const task of snapshot.tasks) {
      if (ids.has(task.operonId)) violations.push({ severity: "P0", code: "duplicate_operon_id", operonId: task.operonId, path: task.path });
      ids.add(task.operonId);
      if (snapshot.capabilities.configuration && task.status && !task.pipeline) {
        violations.push({ severity: "P1", code: "unknown_workflow_status", operonId: task.operonId });
      }
    }
    if (!provenance.partial) for (const task of snapshot.tasks) {
      const targets = [
        ...(task.parentTask ? [["missing_parent_task", task.parentTask]] : []),
        ...task.blockedBy.map(id => ["missing_blocker_task", id]),
        ...task.blocking.map(id => ["missing_blocked_task", id]),
      ];
      for (const [code, target] of targets) if (!ids.has(target)) violations.push({ severity: "P2", code, operonId: task.operonId, target });
    }
    for (const path of invalidFrontmatter) violations.push({ severity: "P2", code: "invalid_frontmatter", path });
    const summary = { P0: 0, P1: 0, P2: 0 };
    for (const violation of violations) summary[violation.severity]++;
    const { contractVersion, stale, snapshotAt, snapshotAgeMs, operonVersion, bridgeVersion, capabilities, limitations, generation, settingsSignature } = snapshot;
    return { ok: summary.P0 === 0 && !provenance.partial, ...provenance,
      contractVersion, stale, snapshotAt, snapshotAgeMs, operonVersion, bridgeVersion, capabilities,
      limitations, generation, settingsSignature, taskCount: snapshot.tasks.length, summary, violations };
  }

  private native(view: Awaited<ReturnType<FilesystemOperonService["read"]>>, operation: "finder" | "relationships", result: object) {
    const { stale, contractVersion, capabilities, limitations, operonVersion, bridgeVersion, generation, settingsSignature } = view.snapshot;
    return {
      ok: true, operation, ...view.provenance, stale, contractVersion, capabilities, limitations, operonVersion, bridgeVersion,
      result: {
        ok: true, kind: operation === "finder" ? "task-finder-result" : "relationship-result",
        contractVersion: 1, requestId: randomUUID(), freshness: {
          source: "source-file", coherence: view.provenance.partial ? "settling" : "unverified",
          observedAt: view.snapshot.snapshotAt, settled: !view.provenance.partial,
        },
        warnings: [], provenance: [], truncations: [],
        contextRevision: this.contextRevision(generation, settingsSignature),
        ...result,
      },
    };
  }

  private contextRevision(generation: number | null, settingsSignature: string | null) {
    return {
      index: { sessionId: this.sessionId, ramGeneration: generation, durable: { status: "unavailable" } },
      settingsFingerprint: settingsSignature, pinnedGeneration: null, activeTrackerGeneration: null,
      repeatSeriesRevision: null, projectSerialGeneration: null, projectSerialSignature: null,
    };
  }

  private context(view: Awaited<ReturnType<FilesystemOperonService["read"]>>, graph: TaskGraph, task: OperonTask) {
    const optional = (values: Record<string, string | null>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
    const { datetimeStart, datetimeEnd, created, modified, ...dates } = task.dates;
    const priorityId = resolveOperonPriorityStableId(task.priority, view.configuration.priorities.items);
    return {
      identity: { operonId: task.operonId, validity: graph.duplicates.has(task.operonId) ? "duplicate" : "canonical", mutationAllowed: false },
      description: task.description, representation: task.source,
      locator: { representation: task.source, filePath: task.path, ...(task.line === null ? {} : { lineNumber: task.line - 1 }) },
      checkbox: task.checkbox,
      ...(task.pipelineId && task.statusId ? { workflow: {
        pipeline: { id: task.pipelineId, label: task.pipeline },
        status: { id: task.statusId, label: task.statusLabel },
      } } : {}),
      ...(priorityId ? { priority: { id: priorityId, label: task.priority } } : {}),
      dates: optional(dates), datetimes: optional({ start: datetimeStart, end: datetimeEnd, created, modified }),
      relationships: {
        ...(task.parentTask ? { parentOperonId: task.parentTask } : {}),
        childOperonIds: (graph.children.get(task.operonId) ?? []).slice(0, 100),
        blockingOperonIds: graph.targets(task.operonId, "blocking").slice(0, 100),
        blockedByOperonIds: graph.targets(task.operonId, "blocked-by").slice(0, 100),
        relatedOperonIds: graph.targets(task.operonId, "related").slice(0, 100),
      },
      recurrence: { repeating: task.recurrence?.repeating ?? false,
        ...optional({ seriesId: task.recurrence?.seriesId ?? null, occurrenceDate: task.recurrence?.occurrenceDate ?? null }) },
      tracker: { active: null, sessionCount: splitOperonList(task.fields.trackers).length },
      pinned: view.pinned?.has(task.operonId) ?? null,
      sourceRevision: { algorithm: "sha256", contentDigest: view.sourceDigests.get(task) },
      contextRevision: this.contextRevision(view.snapshot.generation, view.snapshot.settingsSignature),
    };
  }

  async findTasks(input: unknown) {
    const q = parseToolInput(OperonTaskFinderSchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    const view = await this.view();
    const { snapshot, configuration } = view;
    const graph = new TaskGraph(snapshot.tasks);
    const f = q.filters;
    const needle = q.text?.toLowerCase();
    const now = new Date();
    const today = localDate(now);
    const includes = (values: readonly (string | null)[] | undefined, value: string | null) => !values?.length || values.includes(value);
    const candidates = snapshot.tasks.filter(task => {
      if (!includes(q.representations, task.source) || !includes(f?.checkbox, task.checkbox) ||
          !includes(f?.pipelineIds, task.pipelineId) || !includes(f?.statusIds, task.statusId) ||
          !includes(f?.tiers, task.tier) || !includes(f?.priorityIds, resolveOperonPriorityStableId(task.priority, configuration.priorities.items))) return false;
      const { due, scheduled, started, modified } = task.dates;
      if (f?.due?.from && (!due || due < f.due.from)) return false;
      if (f?.due?.to && (!due || due > f.due.to)) return false;
      if (q.scope === "overdue") return [due, scheduled].some(date => date && /^\d{4}-\d{2}-\d{2}$/u.test(date) && date < today);
      if (q.scope === "happens-today") return [due, scheduled, started].includes(today);
      if (q.scope === "recent") return Date.parse(modified ?? "") >= now.getTime() - view.recentDays * 86_400_000;
      return true;
    });
    const visible = new Set(candidates.map(task => task.operonId));
    const root = q.project?.rootOperonId;
    const scoped = root ? new Set(q.project?.mode === "tree" ? graph.descendants(root) : graph.children.get(root) ?? []) : null;
    const rows = candidates
      .filter(task => (!scoped || scoped.has(task.operonId)) && (root || !q.project || graph.children.has(task.operonId)))
      .map(task => {
        const title = task.description.toLowerCase();
        const score = !needle ? 0 : task.operonId === needle || title === needle ? 3 :
          title.startsWith(needle) ? 2 : title.includes(needle) || task.path.toLowerCase().includes(needle) ? 1 : -1;
        return { task, score };
      })
      .filter(row => row.score >= 0)
      .sort((a, b) => b.score - a.score ||
        (q.scope === "recent" ? (b.task.dates.modified ?? "").localeCompare(a.task.dates.modified ?? "") : 0) ||
        a.task.path.localeCompare(b.task.path) || (a.task.line ?? 0) - (b.task.line ?? 0));
    const { cursor, ...cursorInput } = q;
    const binding = digest(JSON.stringify([this.sessionId, snapshot.generation, snapshot.settingsSignature, today, cursorInput])).slice(0, 24);
    const match = cursor && /^filesystem:([0-9a-f]{24}):(\d+)$/u.exec(cursor);
    if (cursor && (!match || match[1] !== binding || !Number.isSafeInteger(Number(match[2])))) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Use a finder cursor from the same filesystem query and cache generation.");
    }
    const offset = match ? Number(match[2]) : 0;
    const page = rows.slice(offset, offset + q.limit);
    const next = offset + page.length;
    return this.native(view, "finder", {
      rows: page.map(({ task, score }) => {
        const context = this.context(view, graph, task);
        if (!q.project || root) return { kind: "task", task: context, score };
        const direct = graph.children.get(task.operonId) ?? [];
        const tree = graph.descendants(task.operonId);
        return { kind: "project", task: context, score, directTaskCount: direct.length, treeTaskCount: tree.length,
          visibleDirectTaskCount: direct.filter(id => visible.has(id)).length, visibleTreeTaskCount: tree.filter(id => visible.has(id)).length };
      }),
      page: { actualCount: rows.length, returnedCount: page.length, truncated: next < rows.length,
        asOf: now.toISOString(), ...(next < rows.length ? { nextCursor: "filesystem:" + binding + ":" + next } : {}) },
    });
  }

  async relationships(input: unknown) {
    const q = parseToolInput(OperonRelationshipsSchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    const view = await this.view();
    const graph = new TaskGraph(view.snapshot.tasks);
    if (graph.duplicates.has(q.operonId)) throw new McpError(BaseErrorCode.CONFLICT, "Multiple sources declare this Operon ID.", { reasonCode: "operon_filesystem_duplicate_id" });
    if (!graph.tasks.has(q.operonId)) {
      if (view.provenance.partial) return unavailable("operon_filesystem_cache_partial", "Retry when the shared vault cache is ready.");
      throw new McpError(BaseErrorCode.NOT_FOUND, "The requested Operon task does not exist in the shared cache.");
    }
    const edges = graph.walk(q);
    const limited = edges.slice(0, q.limit);
    const ids = [...new Set([q.operonId, ...limited.flatMap(edge => [edge.sourceOperonId, edge.targetOperonId])])].slice(0, q.limit);
    return this.native(view, "relationships", {
      relationships: { explicit: limited.filter(edge => edge.provenanceClass === "explicit"),
        derived: limited.filter(edge => edge.provenanceClass === "derived"), inferred: [] },
      tasks: [...ids].flatMap(id => {
        const task = graph.tasks.get(id);
        return task && !graph.duplicates.has(id) ? [this.context(view, graph, task)] : [];
      }),
      truncations: edges.length > limited.length ? [{ path: "relationships", actualCount: edges.length, returnedCount: limited.length, limit: q.limit }] : [],
    });
  }

  async timers() {
    return unavailable("operon_filesystem_live_required", "Active timer state requires the live Obsidian Desktop Bridge.");
  }
}

type EdgeKind = NonNullable<OperonRelationships["kinds"]>[number];
type Edge = {
  kind: EdgeKind; sourceOperonId: string; targetOperonId: string;
  provenanceClass: "explicit" | "derived"; reason: string;
};

class TaskGraph {
  readonly tasks = new Map<string, OperonTask>();
  readonly duplicates = new Set<string>();
  readonly children = new Map<string, string[]>();
  private readonly edges = new Map<string, Edge[]>();

  constructor(tasks: OperonTask[]) {
    for (const task of tasks) {
      if (this.tasks.has(task.operonId)) this.duplicates.add(task.operonId);
      this.tasks.set(task.operonId, task);
    }
    for (const task of tasks) {
      const id = task.operonId;
      if (this.duplicates.has(id)) continue;
      if (task.parentTask) {
        const siblings = this.children.get(task.parentTask) ?? [];
        siblings.push(id);
        this.children.set(task.parentTask, siblings);
        this.add("parent", id, task.parentTask, "parentTask");
      }
      for (const target of task.blocking) this.add("blocking", id, target, "blocking");
      for (const target of task.blockedBy) this.add("blocked-by", id, target, "blockedBy");
      for (const target of splitOperonList(task.fields.related)) this.add("related", id, target, "related");
    }
    const inverses = { parent: "child", blocking: "blocked-by", "blocked-by": "blocking" } as const;
    for (const edges of [...this.edges.values()].map(edges => [...edges])) for (const edge of edges) {
      const inverse = inverses[edge.kind as keyof typeof inverses];
      if (inverse) this.add(inverse, edge.targetOperonId, edge.sourceOperonId, edge.reason, "derived");
    }
  }

  private add(kind: EdgeKind, sourceOperonId: string, targetOperonId: string, reason: string, provenanceClass: Edge["provenanceClass"] = "explicit") {
    const edges = this.edges.get(sourceOperonId) ?? [];
    if (edges.some(edge => edge.kind === kind && edge.targetOperonId === targetOperonId)) return;
    edges.push({ kind, sourceOperonId, targetOperonId, provenanceClass, reason });
    this.edges.set(sourceOperonId, edges);
  }

  targets(id: string, kind: EdgeKind) {
    return (this.edges.get(id) ?? []).filter(edge => edge.kind === kind).map(edge => edge.targetOperonId);
  }

  descendants(id: string) {
    const seen = new Set([id]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) for (const child of this.children.get(queue[i]) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
    return queue.slice(1);
  }

  walk(query: OperonRelationships) {
    const kinds = new Set(query.kinds);
    const edges: Edge[] = [];
    const seen = new Set([query.operonId]);
    let layer = [query.operonId];
    for (let depth = 0; depth < query.depth && layer.length; depth++) {
      const next = [];
      for (const id of layer) for (const edge of this.edges.get(id) ?? []) {
        if (!kinds.size || kinds.has(edge.kind)) edges.push(edge);
        if (seen.has(edge.targetOperonId) || this.duplicates.has(edge.targetOperonId)) continue;
        seen.add(edge.targetOperonId);
        next.push(edge.targetOperonId);
      }
      layer = next;
    }
    const root = query.operonId;
    const addDerived = (kind: EdgeKind, targetOperonId: string, reason: string) => {
      if (!kinds.size || kinds.has(kind)) edges.push({ kind, sourceOperonId: root, targetOperonId, provenanceClass: "derived", reason });
    };
    const parents = new Set([root]);
    let parent = this.tasks.get(root)?.parentTask;
    for (let depth = 0; depth < query.depth && parent && !parents.has(parent); depth++) {
      parents.add(parent);
      addDerived("ancestor", parent, "parentTask");
      parent = this.tasks.get(parent)?.parentTask;
    }
    let descendants = [root];
    const members = new Set(descendants);
    for (let depth = 0; depth < query.depth && descendants.length; depth++) {
      descendants = descendants.flatMap(id => this.children.get(id) ?? []).filter(id => {
        if (members.has(id)) return false;
        members.add(id);
        addDerived("project-member", id, "parentTask");
        return true;
      });
    }
    return edges;
  }
}
