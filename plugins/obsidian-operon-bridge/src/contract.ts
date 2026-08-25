export const OPERON_BRIDGE_CONTRACT_VERSION = "1" as const;
export const OPERON_BRIDGE_TESTED_VERSION = "3.2.1" as const;
export const OPERON_BRIDGE_DEVELOPER_API_VERSIONS = [
	"3.0.1",
	"3.1.0",
	"3.1.1",
	"3.2.0",
	OPERON_BRIDGE_TESTED_VERSION,
] as const;
export const OPERON_BRIDGE_LEGACY_VERSIONS = {
	operon: ["2.4.0", "2.5.0"],
	kairelys: ["2.5.1", "2.5.2", "2.5.3", "2.6.1", "2.6.2", "2.6.3"],
} as const;

export const OPERON_BRIDGE_SUPPORTED_VERSIONS = {
	operon: [
		...OPERON_BRIDGE_LEGACY_VERSIONS.operon,
		...OPERON_BRIDGE_DEVELOPER_API_VERSIONS,
	],
	kairelys: OPERON_BRIDGE_LEGACY_VERSIONS.kairelys,
} as const;

export const OPERON_BRIDGE_DEVELOPER_API_CONTRACT = {
	contractVersion: 1,
	runtimeApi: { min: 1, max: 1 },
} as const;

export const OPERON_BRIDGE_DENIED_DEVELOPER_API_VERSIONS: Readonly<
	Record<string, string>
> = {
	"3.0.0":
		"Operon 3.0.0 predates the accepted Developer API V1 integration baseline.",
};

export type OperonCompatibilityState =
	| "certified"
	| "compatible-provisional"
	| "incompatible";

export type OperonCompatibilityAdmission =
	| "developer-api-v1"
	| "legacy-version"
	| "none";

export interface OperonCompatibilityDecision {
	state: OperonCompatibilityState;
	admission: OperonCompatibilityAdmission;
	reason: string;
}

// Fail closed only for upstream mutation paths that have not produced a
// trustworthy terminal or durable recovery result in live acceptance.
// Operon 3.1.1 is enabled after the inline settlement path was corrected and
// revalidated with a modified-time frontmatter integration.
export const OPERON_BRIDGE_BLOCKED_MUTATIONS = {
	"3.0.1": ["transition"],
	"3.1.0": [],
	"3.1.1": [],
	"3.2.0": [],
	"3.2.1": [],
} as const;

export function isCertifiedDeveloperApiVersion(version: string): boolean {
	return (OPERON_BRIDGE_DEVELOPER_API_VERSIONS as readonly string[]).includes(
		version.trim(),
	);
}

export function resolveOperonCompatibility(options: {
	pluginId: "kairelys" | "operon";
	version: string;
	hasDeveloperApiV1: boolean;
}): OperonCompatibilityDecision {
	const version = options.version.trim();
	if (options.pluginId === "operon" && options.hasDeveloperApiV1) {
		const deniedReason = OPERON_BRIDGE_DENIED_DEVELOPER_API_VERSIONS[version];
		if (deniedReason) {
			return {
				state: "incompatible",
				admission: "none",
				reason: deniedReason,
			};
		}
		if (isCertifiedDeveloperApiVersion(version)) {
			return {
				state: "certified",
				admission: "developer-api-v1",
				reason: `Operon ${version} is certified against Developer API V1.`,
			};
		}
		return {
			state: "compatible-provisional",
			admission: "developer-api-v1",
			reason:
				"The loaded Operon version is not yet certified, but it exposes the negotiated Developer API V1 boundary; runtime capability and schema checks remain mandatory.",
		};
	}

	if (
		(
			OPERON_BRIDGE_LEGACY_VERSIONS[options.pluginId] as readonly string[]
		).includes(version)
	) {
		return {
			state: "certified",
			admission: "legacy-version",
			reason: `${options.pluginId} ${version} is certified on the bounded legacy adapter.`,
		};
	}

	return {
		state: "incompatible",
		admission: "none",
		reason:
			options.pluginId === "operon"
				? "Operon does not expose the accepted Developer API V1 boundary and is not a certified legacy version."
				: "The loaded Kairélys version is outside the certified legacy compatibility set.",
	};
}

export function isCanonicalVaultRelativePath(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value !== value.trim() ||
		/[\\\r\n\0]/u.test(value) ||
		/^(?:\/|[a-z]:\/)/iu.test(value) ||
		value.endsWith("/")
	) {
		return false;
	}
	const segments = value.split("/");
	return segments.every(
		(segment) =>
			segment.length > 0 &&
			segment === segment.trim() &&
			segment !== "." &&
			segment !== "..",
	);
}

export function isCanonicalVaultMarkdownPath(value: unknown): value is string {
	return (
		isCanonicalVaultRelativePath(value) &&
		value.toLocaleLowerCase().endsWith(".md")
	);
}

export function mutationPathValidationError(
	capability:
		| "create"
		| "update"
		| "transition"
		| "relationships"
		| "recurrence"
		| "convert"
		| "relocate",
	requested: Record<string, unknown>,
): string | null {
	const has = (key: string): boolean =>
		Object.prototype.hasOwnProperty.call(requested, key);
	if (capability === "create") {
		if (requested.source !== "inline" && requested.source !== "file") {
			return "source must be either inline or file.";
		}
		if (
			has("targetPath") &&
			!isCanonicalVaultMarkdownPath(requested.targetPath)
		) {
			return "targetPath must be an exact canonical vault-relative Markdown path.";
		}
		if (
			has("targetFolder") &&
			!isCanonicalVaultRelativePath(requested.targetFolder)
		) {
			return "targetFolder must be an exact canonical vault-relative folder path.";
		}
		if (requested.source === "file" && has("targetPath")) {
			return "targetPath is supported only for inline task creation.";
		}
		if (requested.source === "inline" && has("targetFolder")) {
			return "targetFolder is supported only for file task creation.";
		}
	}
	if (capability === "convert") {
		if (requested.target !== "inline" && requested.target !== "file") {
			return "target must be either inline or file.";
		}
		if (
			has("targetPath") &&
			!isCanonicalVaultMarkdownPath(requested.targetPath)
		) {
			return "targetPath must be an exact canonical vault-relative Markdown path.";
		}
		if (
			has("targetFolder") &&
			!isCanonicalVaultRelativePath(requested.targetFolder)
		) {
			return "targetFolder must be an exact canonical vault-relative folder path.";
		}
		if (requested.target === "inline" && !has("targetPath")) {
			return "targetPath is required for file-to-inline conversion.";
		}
		if (requested.target === "inline" && has("targetFolder")) {
			return "targetFolder is supported only for inline-to-file conversion.";
		}
		if (requested.target === "file" && has("targetPath")) {
			return "targetPath is supported only for file-to-inline conversion.";
		}
	}
	if (
		capability === "relocate" &&
		!isCanonicalVaultMarkdownPath(requested.targetPath)
	) {
		return "targetPath must be an exact canonical vault-relative Markdown path.";
	}
	return null;
}

export interface CachedMutation {
	signature: string;
	payload: Record<string, unknown>;
	httpStatus?: number;
}

export interface MutationReservation {
	signature: string;
	operationId: string;
	requested: Record<string, unknown>;
	startedAt: string;
	promise: Promise<Record<string, unknown>>;
	resolve: (payload: Record<string, unknown>) => void;
}

export type MutationReservationDecision =
	| { kind: "reserved"; reservation: MutationReservation }
	| { kind: "join"; reservation: MutationReservation }
	| { kind: "conflict"; reservation: MutationReservation };

export class MutationReservationRegistry {
	private readonly active = new Map<string, MutationReservation>();

	reserve(options: {
		idempotencyKey: string;
		signature: string;
		operationId: string;
		requested: Record<string, unknown>;
		startedAt: string;
	}): MutationReservationDecision {
		const current = this.active.get(options.idempotencyKey);
		if (current) {
			return current.signature === options.signature
				? { kind: "join", reservation: current }
				: { kind: "conflict", reservation: current };
		}
		let resolve!: (payload: Record<string, unknown>) => void;
		const promise = new Promise<Record<string, unknown>>((done) => {
			resolve = done;
		});
		const reservation: MutationReservation = {
			signature: options.signature,
			operationId: options.operationId,
			requested: structuredClone(options.requested),
			startedAt: options.startedAt,
			promise,
			resolve,
		};
		this.active.set(options.idempotencyKey, reservation);
		return { kind: "reserved", reservation };
	}

	complete(
		idempotencyKey: string,
		signature: string,
		payload: Record<string, unknown>,
	): void {
		const current = this.active.get(idempotencyKey);
		if (!current || current.signature !== signature) return;
		this.active.delete(idempotencyKey);
		current.resolve(payload);
	}

	get(idempotencyKey: string): MutationReservation | undefined {
		return this.active.get(idempotencyKey);
	}

	entries(): IterableIterator<[string, MutationReservation]> {
		return this.active.entries();
	}
}

export function interruptedMutationPayload(options: {
	idempotencyKey: string;
	operationId: string;
	requested: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		ok: false,
		contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
		operationId: options.operationId,
		idempotencyKey: options.idempotencyKey,
		status: "outcome-unknown",
		before: null,
		requested: options.requested,
		after: null,
		error: {
			code: "interrupted_in_progress",
			message:
				"The Bridge restarted while this mutation was in progress; inspect Operon pending recoveries and recover the same native plan before retrying.",
		},
		retryable: false,
		mutationMayHaveApplied: true,
		recoveryRequired: true,
		source: "operon-live",
		stale: false,
	};
}

export type MutationPreflightDecision =
	| {
			kind: "response";
			response: { httpStatus: number; payload: Record<string, unknown> };
	  }
	| { kind: "validation-error"; message: string }
	| { kind: "continue" };

export function resolveMutationPreflight(options: {
	cached: CachedMutation | undefined;
	idempotencyKey: string;
	signature: string;
	requested: Record<string, unknown>;
	validate: () => string | null;
	operationId: () => string;
}): MutationPreflightDecision {
	const { cached, idempotencyKey, signature, requested } = options;
	if (cached?.signature === signature) {
		return {
			kind: "response",
			response: {
				httpStatus: cached.httpStatus ?? 200,
				payload: { ...cached.payload, replayed: true },
			},
		};
	}
	if (cached) {
		return {
			kind: "response",
			response: {
				httpStatus: 409,
				payload: {
					ok: false,
					contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
					operationId: options.operationId(),
					idempotencyKey,
					status: "conflict",
					before: null,
					requested,
					after: null,
					error: {
						code: "idempotency_key_reused",
						message:
							"idempotencyKey was already used for a different mutation request.",
					},
					retryable: false,
					source: "operon-live",
					stale: false,
				},
			},
		};
	}
	const validationError = options.validate();
	return validationError
		? { kind: "validation-error", message: validationError }
		: { kind: "continue" };
}

export type OperonTaskSource = "inline" | "file";
export type OperonCheckboxState = "open" | "done" | "cancelled";
export type OperonTier = "hot" | "warm" | "cold";
export type SortDirection = "asc" | "desc";
export type OperonFieldValue = string | string[];

export interface RuntimeTaskLocation {
	filePath: string;
	lineNumber: number;
	format: "inline" | "yaml";
}

export interface RuntimeIndexedTask {
	operonId: string;
	description: string;
	checkbox: OperonCheckboxState;
	fieldValues: Record<string, OperonFieldValue>;
	tags: string[];
	primary: RuntimeTaskLocation;
	datetimeModified: string;
	tier: OperonTier;
	plainCheckboxProgress?: {
		total: number;
		completed: number;
	};
	recurrence?: {
		repeating: boolean;
		seriesId: string | null;
		occurrenceDate: string | null;
	};
}

export interface RuntimeStatusDefinition {
	id?: string;
	label: string;
	isFinished?: boolean;
	isCancelled?: boolean;
	isScheduledTarget?: boolean;
	isTrackingTarget?: boolean;
}

export interface RuntimePipeline {
	id?: string;
	name: string;
	description?: string;
	statuses: RuntimeStatusDefinition[];
}

export interface RuntimePriorityDefinition {
	id?: string;
	label: string;
	color?: string;
	description?: string;
}

export function resolvePriorityStableId(
	value: unknown,
	priorities: readonly RuntimePriorityDefinition[],
): string | null {
	const normalized = String(value ?? "").trim();
	if (!normalized) return null;
	const matches = priorities
		.filter(
			(priority) => priority.id === normalized || priority.label === normalized,
		)
		.map((priority) => priority.id)
		.filter((id): id is string => Boolean(id));
	const unique = [...new Set(matches)];
	return unique.length === 1 ? (unique[0] ?? null) : null;
}

export interface ResolvedWorkflowStatus {
	pipeline: string;
	label: string;
	value: string;
	id: string | null;
}

export function resolveWorkflowStatus(
	value: unknown,
	pipelines: readonly RuntimePipeline[],
): ResolvedWorkflowStatus | null {
	const normalized = String(value ?? "").trim();
	if (!normalized) return null;
	const matches = pipelines.flatMap((pipeline) =>
		(pipeline.statuses ?? [])
			.filter(
				(status) =>
					status.id === normalized ||
					status.label === normalized ||
					`${pipeline.name}.${status.label}` === normalized,
			)
			.map((status) => ({
				pipeline: pipeline.name,
				label: status.label,
				value: `${pipeline.name}.${status.label}`,
				id: status.id?.trim() || null,
			})),
	);
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function workflowStatusMatches(
	actual: Pick<
		OperonBridgeTask,
		"status" | "statusId" | "statusLabel" | "pipeline" | "pipelineId"
	>,
	requested: unknown,
	pipelines: readonly RuntimePipeline[],
): boolean {
	const normalized = String(requested ?? "").trim();
	if (!normalized) return false;
	const resolved = resolveWorkflowStatus(normalized, pipelines);
	if (!resolved) {
		return actual.status === normalized || actual.statusId === normalized;
	}
	return (
		actual.status === resolved.value ||
		(resolved.id !== null && actual.statusId === resolved.id) ||
		(actual.pipeline === resolved.pipeline &&
			actual.statusLabel === resolved.label)
	);
}

export interface RuntimeFileTaskTemplate {
	id: string;
	name: string;
	path: string | null;
	kind: string;
	pipelineId?: string;
	description?: string;
}

export interface OperonWorkflowTaxonomy {
	language: string;
	defaultPipelineName: string | null;
	pipelines: Array<{
		id: string | null;
		name: string;
		description: string | null;
		statuses: Array<{
			id: string | null;
			label: string;
			value: string;
			isFinished: boolean;
			isCancelled: boolean;
			isScheduledTarget: boolean;
			isTrackingTarget: boolean;
		}>;
	}>;
}

export interface OperonSemanticConfiguration {
	language: string;
	workflow: OperonWorkflowTaxonomy;
	priorities: {
		defaultPriority: string | null;
		items: Array<{
			id: string | null;
			label: string;
			color: string | null;
			description: string | null;
		}>;
	};
	keys: Array<{
		canonicalKey: string;
		visiblePropertyName: string;
		type: string | null;
		sync: string | null;
		enabled: boolean;
		isSystem: boolean;
		isInternal: boolean;
	}>;
	creation: {
		fileTasksFolder: string;
		inlineTaskSaveMode: string;
		inlineTaskUseDailyNote: boolean;
		inlineTaskTargetFile: string;
		inlineTaskHeading: string;
		inlineTaskDailyNoteAddStartDate: boolean;
		inlineTaskDailyNoteAddScheduledDate: boolean;
		taskCreatorDefaultToFileTask: boolean;
		taskCreatorDefaultFileTemplateId: string | null;
		fileTaskTemplateFolder: string;
		fileTaskParentInlineTargetMode: string;
		fileTaskParentFileTargetMode: string;
		availableFileTaskTemplates: Array<{
			id: string;
			name: string;
			path: string | null;
			kind: string;
			pipelineId: string | null;
			description: string | null;
		}>;
	};
	automation: {
		autoCompleteParentWhenAllChildrenTerminal: boolean;
		cascadeCancelToDescendants: boolean;
		fileTaskAutoArchiveEnabled: boolean;
		fileTaskArchiveFolder: string;
		fileTaskArchiveDelaySeconds: number;
		fileTaskArchiveOnlyFromFileTasksFolder: boolean;
		fileRepeatDestination: string;
		fileRepeatCustomFolder: string;
	};
	indexing: {
		excludedFolders: string[];
		fullReindexOnStartup: boolean;
		indexEventDebounceMs: number;
	};
	docs: {
		folder: string;
		autoUpdateEnabled: boolean;
	};
	views: {
		filters: Array<{
			id: string;
			name: string;
			icon: string | null;
			definition: Record<string, unknown>;
		}>;
	};
}

export interface OperonBridgeConfiguration {
	ok: true;
	contractVersion: typeof OPERON_BRIDGE_CONTRACT_VERSION;
	source: "operon-runtime";
	stale: false;
	operonVersion: string;
	bridgeVersion: string;
	settingsSignature: string;
	configuration: OperonSemanticConfiguration;
	limitations: string[];
}

export interface RuntimeKeyMapping {
	canonicalKey: string;
	visiblePropertyName: string;
	type?: string;
	sync?: string;
	enabled?: boolean;
	isSystem?: boolean;
	isInternal?: boolean;
	source?: "built-in" | "custom";
	mappingStatus?: "mapped" | "unmapped" | "collision" | "reserved";
	mutationClass?: "general-update" | "semantic-capability" | "runtime-owned";
	mutationOwner?: string;
}

export interface OperonTaskDates {
	due: string | null;
	scheduled: string | null;
	started: string | null;
	completed: string | null;
	cancelled: string | null;
	datetimeStart: string | null;
	datetimeEnd: string | null;
	created: string | null;
	modified: string | null;
}

export interface OperonBridgeTask {
	operonId: string;
	source: OperonTaskSource;
	path: string;
	line: number | null;
	sourceMtime: number | null;
	description: string;
	checkbox: OperonCheckboxState;
	status: string | null;
	statusId: string | null;
	statusLabel: string | null;
	pipeline: string | null;
	pipelineId: string | null;
	priority: string | null;
	tier: OperonTier;
	tags: string[];
	parentTask: string | null;
	blocking: string[];
	blockedBy: string[];
	dates: OperonTaskDates;
	fields: Record<string, OperonFieldValue>;
	properties?: Record<string, unknown>;
	plainCheckboxProgress?: {
		total: number;
		completed: number;
	};
	recurrence?: {
		repeating: boolean;
		seriesId: string | null;
		occurrenceDate: string | null;
	};
	revision: string;
	sourceKind: "operon-index";
	operonVersion: string;
	bridgeVersion: string;
}

export interface OperonTaskSort {
	field:
		| "description"
		| "status"
		| "pipeline"
		| "priority"
		| "due"
		| "scheduled"
		| "path"
		| "line"
		| "datetimeModified"
		| "tier";
	direction?: SortDirection;
}

export interface OperonDateFilter {
	field:
		| "due"
		| "scheduled"
		| "started"
		| "completed"
		| "cancelled"
		| "datetimeStart"
		| "datetimeEnd"
		| "created"
		| "modified";
	before?: string;
	after?: string;
	on?: string;
}

export interface OperonTaskQuery {
	operonIds?: string[];
	search?: string;
	sources?: OperonTaskSource[];
	checkboxes?: OperonCheckboxState[];
	statuses?: string[];
	statusIds?: string[];
	pipelines?: string[];
	pipelineIds?: string[];
	priorities?: string[];
	tiers?: OperonTier[];
	pathIncludes?: string[];
	pathExcludes?: string[];
	tagsAny?: string[];
	tagsAll?: string[];
	parentTask?: string | null;
	dates?: OperonDateFilter[];
	fieldEquals?: Record<string, OperonFieldValue>;
	propertyEquals?: Record<string, unknown>;
	sort?: OperonTaskSort[];
	includeProperties?: boolean;
	cursor?: string;
	limit?: number;
}

export interface OperonTaskPage {
	ok: true;
	contractVersion: typeof OPERON_BRIDGE_CONTRACT_VERSION;
	source: "operon-live";
	stale: false;
	generation: number;
	settingsSignature: string;
	total: number;
	count: number;
	cursor: string;
	nextCursor?: string;
	hasMore: boolean;
	tasks: OperonBridgeTask[];
	limitations: string[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function isVersionCompatible(
	pluginId: "kairelys" | "operon",
	version: string,
): boolean {
	return (
		OPERON_BRIDGE_SUPPORTED_VERSIONS[pluginId] as readonly string[]
	).includes(version.trim());
}

export interface RuntimeIndexDiagnostics {
	health?: string;
	runtimePhase?: string;
	verifiedThisSession?: boolean;
	taskCount?: number;
	dirtySourceCount?: number;
}

export function shouldAttemptIndexValidation(options: {
	compatible: boolean;
	generation: number | null;
	diagnostics: RuntimeIndexDiagnostics | null;
	hasValidator: boolean;
}): boolean {
	const { compatible, generation, diagnostics, hasValidator } = options;
	return Boolean(
		compatible &&
			hasValidator &&
			Number.isInteger(generation) &&
			(generation ?? 0) > 0 &&
			diagnostics?.health === "healthy" &&
			diagnostics.runtimePhase === "idle" &&
			diagnostics.verifiedThisSession === false &&
			(diagnostics.dirtySourceCount ?? 0) === 0,
	);
}

export function isIndexReady(options: {
	compatible: boolean;
	generation: number | null;
	diagnostics: RuntimeIndexDiagnostics | null;
}): boolean {
	const { compatible, generation, diagnostics } = options;
	return Boolean(
		compatible &&
			Number.isInteger(generation) &&
			(generation ?? 0) > 0 &&
			diagnostics?.health === "healthy" &&
			diagnostics.runtimePhase === "idle" &&
			diagnostics.verifiedThisSession === true &&
			(diagnostics.dirtySourceCount ?? 0) === 0,
	);
}

export function parseListValue(value: OperonFieldValue | undefined): string[] {
	if (Array.isArray(value))
		return value.map((item) => item.trim()).filter(Boolean);
	if (!value?.trim()) return [];
	return value
		.split(/[;,]/u)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function normalizeExpectedManagedFieldValue(
	value: unknown,
): OperonFieldValue | null {
	if (value === null || value === undefined) return null;
	return Array.isArray(value) ? value.map(String) : String(value);
}

export function managedFieldOutcomeMatches(
	actual: OperonFieldValue | undefined,
	requested: unknown,
): boolean {
	return (
		stableStringify(actual ?? null) ===
		stableStringify(normalizeExpectedManagedFieldValue(requested))
	);
}

export function stablePriorityOutcomeMatches(
	actualPriorityId: string | null,
	requestedPriorityId: unknown,
): boolean {
	return (
		typeof requestedPriorityId !== "string" ||
		actualPriorityId === requestedPriorityId.trim()
	);
}

function scalarFieldValue(
	value: OperonFieldValue | undefined,
): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function resolveWorkflow(
	statusValue: string | undefined,
	pipelines: RuntimePipeline[],
): {
	pipeline: string | null;
	pipelineId: string | null;
	statusLabel: string | null;
	statusId: string | null;
} {
	const value = statusValue?.trim();
	if (!value)
		return {
			pipeline: null,
			pipelineId: null,
			statusLabel: null,
			statusId: null,
		};
	for (const pipeline of pipelines) {
		for (const status of pipeline.statuses ?? []) {
			if (`${pipeline.name}.${status.label}` === value) {
				return {
					pipeline: pipeline.name,
					pipelineId: pipeline.id?.trim() || null,
					statusLabel: status.label,
					statusId: status.id?.trim() || null,
				};
			}
		}
	}
	return {
		pipeline: null,
		pipelineId: null,
		statusLabel: null,
		statusId: null,
	};
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, stableValue(record[key])]),
		);
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	return String(value ?? "");
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

export function fnv1a32(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function normalizeProperties(
	frontmatter: Record<string, unknown> | undefined,
	keyMappings: RuntimeKeyMapping[],
): Record<string, unknown> | undefined {
	if (!frontmatter) return undefined;
	const managedNames = new Set<string>(["tags", "cssclasses", "position"]);
	for (const mapping of keyMappings) {
		managedNames.add(mapping.canonicalKey);
		managedNames.add(mapping.visiblePropertyName);
	}
	const entries = Object.entries(frontmatter)
		.filter(([key]) => !managedNames.has(key))
		.filter(([key]) => !key.startsWith("_"))
		.map(([key, value]) => [key, stableValue(value)] as const);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeTask(options: {
	task: RuntimeIndexedTask;
	pipelines: RuntimePipeline[];
	keyMappings: RuntimeKeyMapping[];
	frontmatter?: Record<string, unknown>;
	sourceMtime?: number | null;
	operonVersion: string;
	bridgeVersion: string;
	includeProperties: boolean;
}): OperonBridgeTask {
	const { task } = options;
	const fields = Object.fromEntries(
		Object.entries(task.fieldValues).map(([key, value]) => [
			key,
			Array.isArray(value) ? [...value] : value,
		]),
	) as Record<string, OperonFieldValue>;
	const status = scalarFieldValue(fields.status)?.trim() || null;
	const workflow = resolveWorkflow(status ?? undefined, options.pipelines);
	const canonicalProperties = normalizeProperties(
		options.frontmatter,
		options.keyMappings,
	);
	const properties = options.includeProperties
		? canonicalProperties
		: undefined;
	const normalized: Omit<OperonBridgeTask, "revision"> = {
		operonId: task.operonId,
		source: task.primary.format === "yaml" ? "file" : "inline",
		path: task.primary.filePath,
		line: task.primary.format === "inline" ? task.primary.lineNumber + 1 : null,
		sourceMtime: options.sourceMtime ?? null,
		description: task.description,
		checkbox: task.checkbox,
		status,
		statusId: workflow.statusId,
		statusLabel: workflow.statusLabel,
		pipeline: workflow.pipeline,
		pipelineId: workflow.pipelineId,
		priority: scalarFieldValue(fields.priority)?.trim() || null,
		tier: task.tier,
		tags: [
			...new Set(
				task.tags.map((tag) => tag.replace(/^#/u, "").trim()).filter(Boolean),
			),
		].sort(),
		parentTask: scalarFieldValue(fields.parentTask)?.trim() || null,
		blocking: parseListValue(fields.blocking),
		blockedBy: parseListValue(fields.blockedBy),
		dates: {
			due: scalarFieldValue(fields.dateDue)?.trim() || null,
			scheduled: scalarFieldValue(fields.dateScheduled)?.trim() || null,
			started: scalarFieldValue(fields.dateStarted)?.trim() || null,
			completed: scalarFieldValue(fields.dateCompleted)?.trim() || null,
			cancelled: scalarFieldValue(fields.dateCancelled)?.trim() || null,
			datetimeStart: scalarFieldValue(fields.datetimeStart)?.trim() || null,
			datetimeEnd: scalarFieldValue(fields.datetimeEnd)?.trim() || null,
			created: scalarFieldValue(fields.datetimeCreated)?.trim() || null,
			modified:
				scalarFieldValue(fields.datetimeModified)?.trim() ||
				task.datetimeModified?.trim() ||
				null,
		},
		fields,
		...(properties ? { properties } : {}),
		...(task.plainCheckboxProgress
			? { plainCheckboxProgress: { ...task.plainCheckboxProgress } }
			: {}),
		...(task.recurrence ? { recurrence: { ...task.recurrence } } : {}),
		sourceKind: "operon-index",
		operonVersion: options.operonVersion,
		bridgeVersion: options.bridgeVersion,
	};
	const revisionPayload = {
		...normalized,
		properties: canonicalProperties ?? null,
	};
	return {
		...normalized,
		revision: `fnv1a32:${fnv1a32(stableStringify(revisionPayload))}`,
	};
}

function normalizeNeedle(value: unknown): string {
	return String(value ?? "")
		.trim()
		.toLocaleLowerCase();
}

function fieldValueMatches(
	actual: OperonFieldValue | undefined,
	expected: OperonFieldValue,
): boolean {
	if (Array.isArray(actual) || Array.isArray(expected)) {
		if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
		return (
			stableStringify(actual.map(normalizeNeedle)) ===
			stableStringify(expected.map(normalizeNeedle))
		);
	}
	return normalizeNeedle(actual) === normalizeNeedle(expected);
}

function includesEvery(haystack: string[], needles: string[]): boolean {
	const normalized = new Set(haystack.map(normalizeNeedle));
	return needles.every((needle) => normalized.has(normalizeNeedle(needle)));
}

function includesAny(haystack: string[], needles: string[]): boolean {
	const normalized = new Set(haystack.map(normalizeNeedle));
	return needles.some((needle) => normalized.has(normalizeNeedle(needle)));
}

function matchesDate(value: string | null, filter: OperonDateFilter): boolean {
	if (!value) return false;
	if (filter.on && value.slice(0, filter.on.length) !== filter.on) return false;
	if (filter.before && !(value < filter.before)) return false;
	if (filter.after && !(value > filter.after)) return false;
	return true;
}

function propertyValue(task: OperonBridgeTask, key: string): unknown {
	return task.properties?.[key];
}

export function filterTasks(
	tasks: OperonBridgeTask[],
	query: OperonTaskQuery,
): OperonBridgeTask[] {
	const search = normalizeNeedle(query.search);
	const operonIds = new Set(query.operonIds ?? []);
	const sources = new Set(query.sources ?? []);
	const checkboxes = new Set(query.checkboxes ?? []);
	const statuses = new Set((query.statuses ?? []).map(normalizeNeedle));
	const statusIds = new Set((query.statusIds ?? []).map(normalizeNeedle));
	const pipelines = new Set((query.pipelines ?? []).map(normalizeNeedle));
	const pipelineIds = new Set((query.pipelineIds ?? []).map(normalizeNeedle));
	const priorities = new Set((query.priorities ?? []).map(normalizeNeedle));
	const tiers = new Set(query.tiers ?? []);

	return tasks.filter((task) => {
		if (operonIds.size > 0 && !operonIds.has(task.operonId)) return false;
		if (sources.size > 0 && !sources.has(task.source)) return false;
		if (checkboxes.size > 0 && !checkboxes.has(task.checkbox)) return false;
		if (statuses.size > 0 && !statuses.has(normalizeNeedle(task.status)))
			return false;
		if (statusIds.size > 0 && !statusIds.has(normalizeNeedle(task.statusId)))
			return false;
		if (pipelines.size > 0 && !pipelines.has(normalizeNeedle(task.pipeline)))
			return false;
		if (
			pipelineIds.size > 0 &&
			!pipelineIds.has(normalizeNeedle(task.pipelineId))
		)
			return false;
		if (priorities.size > 0 && !priorities.has(normalizeNeedle(task.priority)))
			return false;
		if (tiers.size > 0 && !tiers.has(task.tier)) return false;
		if (
			(query.pathIncludes ?? []).some(
				(needle) =>
					!normalizeNeedle(task.path).includes(normalizeNeedle(needle)),
			)
		) {
			return false;
		}
		if (
			(query.pathExcludes ?? []).some((needle) =>
				normalizeNeedle(task.path).includes(normalizeNeedle(needle)),
			)
		) {
			return false;
		}
		if (
			(query.tagsAny?.length ?? 0) > 0 &&
			!includesAny(task.tags, query.tagsAny ?? [])
		)
			return false;
		if (
			(query.tagsAll?.length ?? 0) > 0 &&
			!includesEvery(task.tags, query.tagsAll ?? [])
		)
			return false;
		if (query.parentTask !== undefined && task.parentTask !== query.parentTask)
			return false;
		if (
			(query.dates ?? []).some(
				(filter) => !matchesDate(task.dates[filter.field], filter),
			)
		)
			return false;
		for (const [key, expected] of Object.entries(query.fieldEquals ?? {})) {
			if (!fieldValueMatches(task.fields[key], expected)) return false;
		}
		for (const [key, expected] of Object.entries(query.propertyEquals ?? {})) {
			if (
				stableStringify(propertyValue(task, key)) !== stableStringify(expected)
			)
				return false;
		}
		if (search) {
			const searchable = [
				task.operonId,
				task.description,
				task.path,
				task.status,
				task.statusId,
				task.statusLabel,
				task.pipeline,
				task.pipelineId,
				task.priority,
				task.parentTask,
				...task.tags,
				...Object.values(task.fields).flatMap((value) =>
					Array.isArray(value) ? value : [value],
				),
				...(task.properties ? [stableStringify(task.properties)] : []),
			]
				.map(normalizeNeedle)
				.join("\n");
			if (!searchable.includes(search)) return false;
		}
		return true;
	});
}

function sortValue(
	task: OperonBridgeTask,
	field: OperonTaskSort["field"],
): string | number {
	switch (field) {
		case "description":
			return task.description;
		case "status":
			return task.status ?? "";
		case "pipeline":
			return task.pipeline ?? "";
		case "priority":
			return task.priority ?? "";
		case "due":
			return task.dates.due ?? "";
		case "scheduled":
			return task.dates.scheduled ?? "";
		case "path":
			return task.path;
		case "line":
			return task.line ?? 0;
		case "datetimeModified":
			return task.dates.modified ?? "";
		case "tier":
			return task.tier;
	}
}

export function sortTasks(
	tasks: OperonBridgeTask[],
	sort: OperonTaskSort[] | undefined,
): OperonBridgeTask[] {
	const rules: OperonTaskSort[] = sort?.length
		? sort
		: [
				{ field: "path", direction: "asc" as const },
				{ field: "line", direction: "asc" as const },
			];
	return [...tasks].sort((left, right) => {
		for (const rule of rules) {
			const direction = rule.direction === "desc" ? -1 : 1;
			const leftValue = sortValue(left, rule.field);
			const rightValue = sortValue(right, rule.field);
			const comparison =
				typeof leftValue === "number" && typeof rightValue === "number"
					? leftValue - rightValue
					: String(leftValue).localeCompare(String(rightValue));
			if (comparison !== 0) return comparison * direction;
		}
		return left.operonId.localeCompare(right.operonId);
	});
}

export function parseCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	const value = Number(cursor);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`Invalid cursor '${cursor}'.`);
	}
	return value;
}

export function paginateTasks(
	tasks: OperonBridgeTask[],
	query: Pick<OperonTaskQuery, "cursor" | "limit">,
): Omit<
	OperonTaskPage,
	| "contractVersion"
	| "source"
	| "stale"
	| "generation"
	| "settingsSignature"
	| "limitations"
	| "ok"
> {
	const offset = parseCursor(query.cursor);
	const limit = Math.max(1, Math.min(MAX_LIMIT, query.limit ?? DEFAULT_LIMIT));
	const page = tasks.slice(offset, offset + limit);
	const nextOffset = offset + page.length;
	return {
		total: tasks.length,
		count: page.length,
		cursor: String(offset),
		nextCursor: nextOffset < tasks.length ? String(nextOffset) : undefined,
		hasMore: nextOffset < tasks.length,
		tasks: page,
	};
}

export function queryTasks(
	tasks: OperonBridgeTask[],
	query: OperonTaskQuery,
): Omit<
	OperonTaskPage,
	| "contractVersion"
	| "source"
	| "stale"
	| "generation"
	| "settingsSignature"
	| "limitations"
	| "ok"
> {
	return paginateTasks(sortTasks(filterTasks(tasks, query), query.sort), query);
}

export function settingsSignature(
	configuration: OperonSemanticConfiguration,
): string {
	return `fnv1a32:${fnv1a32(stableStringify(configuration))}`;
}
