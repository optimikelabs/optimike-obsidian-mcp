import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalRestEventError, VAULT_CACHE_EVENTS, type VaultCacheEvent,
  type VaultEventNotice, type VaultEventSource, type EventStreamFailure } from "../eventStreams.js";

export interface EventCacheTarget {
  accepts(path: string, folder: boolean): boolean;
  update(path: string): Promise<{ok: boolean}>;
  reconcile(): Promise<boolean>;
  uncertain(): void;
}
export interface EventSupervisorOptions {
  maxPending?: number;
  batchSize?: number;
  debounceMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  reconcileIntervalMs?: number;
}

/** One instance per cache/process, not one per MCP request or transport session. */
export class CacheEventSupervisor {
  private running = false;
  private stopping: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private workers: Promise<void>[] = [];
  private connected = new Set<VaultCacheEvent>();
  private epochs = new Map<VaultCacheEvent, string>();
  private pending = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private pump: Promise<void> | null = null;
  private revision = 0;
  private reconciledRevision = -1;
  private nextReconcileAt = 0;
  private lastReason: EventStreamFailure | null = null;
  private lastEventAt: number | null = null;
  private lastReconciledAt: number | null = null;
  private attempts = 0;
  private reconnects = 0;
  private overflows = 0;
  private updateFailures = 0;
  private reconciliations = 0;
  private latencies: number[] = [];
  private readonly options: Required<EventSupervisorOptions>;

  constructor(private readonly source: VaultEventSource, private readonly target: EventCacheTarget,
    options: EventSupervisorOptions = {}) {
    this.options = {maxPending: 512, batchSize: 32, debounceMs: 50,
      retryMinMs: 1000, retryMaxMs: 60000, reconcileIntervalMs: 5000, ...options};
    for (const value of Object.values(this.options)) {
      if (!Number.isFinite(value) || value < 1 || value > 60000) throw new Error("invalid_event_limits");
    }
  }

  start(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.controller = new AbortController();
    this.requestReconciliation();
    const signal = this.controller.signal;
    this.workers = VAULT_CACHE_EVENTS.map(event => this.streamLoop(event, signal));
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopping = (async () => {
      await Promise.allSettled(this.workers);
      await this.pump?.catch(() => undefined);
      this.connected.clear();
      this.pending.clear();
      this.workers = [];
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  snapshot() {
    const ordered = [...this.latencies].sort((a,b) => a-b);
    const percentile = (p: number) => ordered.length ? ordered[Math.ceil(p * ordered.length) - 1] : null;
    const fresh = this.running && this.connected.size === VAULT_CACHE_EVENTS.length &&
      this.revision === this.reconciledRevision && this.pending.size === 0 && this.pump === null;
    return {
      state: !this.running ? "stopped" : fresh ? "ready" : this.connected.size ? "degraded" :
        this.lastReason === "unsupported" ? "unsupported" : "connecting",
      connectedStreams: this.connected.size, pendingPaths: this.pending.size,
      reconciledAndConnected: fresh, lastReason: this.lastReason,
      lastEventAt: this.lastEventAt, lastReconciledAt: this.lastReconciledAt,
      connectionAttempts: this.attempts, reconnects: this.reconnects,
      overflows: this.overflows, updateFailures: this.updateFailures,
      reconciliations: this.reconciliations, latencySampleCount: ordered.length,
      eventToCacheP50Ms: percentile(0.5), eventToCacheP95Ms: percentile(0.95),
    };
  }

  private requestReconciliation(): void {
    this.revision++;
    this.target.uncertain();
    this.schedule();
  }

  private receive(notice: VaultEventNotice): void {
    if (!this.running) return;
    this.lastEventAt = Date.now();
    if (notice.epoch) {
      const previous = this.epochs.get(notice.event);
      if (previous && previous !== notice.epoch) this.requestReconciliation();
      this.epochs.set(notice.event, notice.epoch);
    }
    if (notice.isFolder) {
      if (this.target.accepts(notice.path, true) || notice.oldPath && this.target.accepts(notice.oldPath, true)) {
        this.requestReconciliation();
      }
      return;
    }
    for (const candidate of [notice.oldPath, notice.path]) {
      if (!candidate || !this.target.accepts(candidate, false)) continue;
      if (!this.pending.has(candidate) && this.pending.size >= this.options.maxPending) {
        this.overflows++;
        this.pending.clear();
        this.requestReconciliation();
      }
      if (!this.pending.has(candidate)) this.pending.set(candidate, performance.now());
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.running || this.timer || this.pump) return;
    const dirty = this.revision !== this.reconciledRevision;
    if (!this.pending.size && !(dirty && this.connected.size === VAULT_CACHE_EVENTS.length)) return;
    const delay = this.pending.size ? this.options.debounceMs :
      Math.max(this.options.debounceMs, this.nextReconcileAt - performance.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump = this.flush().catch(() => {
        this.updateFailures++;
        this.requestReconciliation();
      }).finally(() => { this.pump = null; this.schedule(); });
    }, delay);
  }

  private async flush(): Promise<void> {
    if (!this.running) return;
    if (this.revision !== this.reconciledRevision && this.connected.size === VAULT_CACHE_EVENTS.length &&
        performance.now() >= this.nextReconcileAt) {
      const revision = this.revision;
      this.reconciliations++;
      this.nextReconcileAt = performance.now() + this.options.reconcileIntervalMs;
      const ok = await this.target.reconcile();
      if (ok) { this.reconciledRevision = revision; this.lastReconciledAt = Date.now(); }
      else this.target.uncertain();
    }
    // Remove before await: a newer event for this path must remain queued.
    for (let i = 0; this.running && i < this.options.batchSize; i++) {
      const first = this.pending.entries().next().value as [string, number] | undefined;
      if (!first) break;
      const [filePath, receivedAt] = first;
      this.pending.delete(filePath);
      const result = await this.target.update(filePath);
      if (!result.ok) { this.updateFailures++; this.requestReconciliation(); }
      else {
        this.latencies.push(Math.round(performance.now() - receivedAt));
        if (this.latencies.length > 128) this.latencies.shift();
      }
    }
  }

  private async streamLoop(event: VaultCacheEvent, signal: AbortSignal): Promise<void> {
    let delay = this.options.retryMinMs;
    let hasConnected = false;
    while (this.running && !signal.aborted) {
      this.attempts++;
      const started = performance.now();
      try {
        await this.source.consumeVaultEvents(event, signal, () => {
          if (!this.running || signal.aborted) return;
          if (hasConnected) this.reconnects++;
          hasConnected = true;
          this.connected.add(event);
          this.lastReason = null;
          this.requestReconciliation();
        }, notice => { if (!signal.aborted) this.receive(notice); });
        if (!signal.aborted) this.lastReason = "unavailable";
      } catch (error) {
        if (!signal.aborted) this.lastReason = error instanceof LocalRestEventError ? error.reason : "unavailable";
      } finally {
        this.connected.delete(event);
        if (this.running && !signal.aborted) this.requestReconciliation();
      }
      if (signal.aborted || !this.running) break;
      if (performance.now() - started >= 30000) delay = this.options.retryMinMs;
      await sleep(delay, undefined, {signal}).catch(() => undefined);
      delay = Math.min(this.options.retryMaxMs, delay * 2);
    }
  }
}
