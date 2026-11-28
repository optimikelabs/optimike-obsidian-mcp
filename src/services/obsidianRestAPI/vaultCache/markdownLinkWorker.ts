import { DatabaseSync } from "node:sqlite";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { LinkParseFailure, MarkdownLinkIndex, type LinkIndexSource } from "./markdownLinkIndex.js";
import type { LinkExtractionOptions } from "./boundedLinkReferences.js";

const entry = new URL(import.meta.url);
const workerKind = "filesystem-markdown-links";
type Batch = { sources: LinkIndexSource[]; active: SharedArrayBuffer };
type Progress = { ordinal: number; generation: number };
type StorageFailureKind = "busy" | "storage";
type WorkerMessage = Progress | true | { kind: "parse"; ordinal: number } | { kind: StorageFailureKind };
export class LinkStorageFailure extends Error {
  constructor(readonly kind: StorageFailureKind = "storage") { super("markdown_link_storage_failed"); }
}

function storageFailureKind(error: unknown): StorageFailureKind {
  const code = (error as { errcode?: number } | null)?.errcode ?? 0;
  return (code & 255) === 5 || (code & 255) === 6 ? "busy" : "storage";
}

class SourceTimeout extends Error {
  constructor(readonly ordinal: number) {
    super("markdown_link_source_timed_out");
  }
}

/** At most one worker and one outstanding batch per cache service. */
export class MarkdownLinkWorker {
  private worker?: Worker;
  private closed = false;
  private pending?: { resolve: () => void; reject: (error: Error) => void; progress: (message: Progress) => void };
  private termination?: Promise<number>;

  constructor(
    private readonly databasePath: string,
    private readonly options: LinkExtractionOptions,
    private readonly index: MarkdownLinkIndex,
  ) {}

  readonly indexPaths = (paths: string[]): Promise<void> => this.indexBatch(
    this.index.describeSources(paths).map((source) => source.attempts > 0 ? { ...source, bounded: true } : source),
  );

  private async indexBatch(sources: LinkIndexSource[]): Promise<void> {
    const active = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    while (sources.length && !this.closed) {
      Atomics.store(active, 0, sources.length === 1 ? 0 : -1);
      Atomics.store(active, 1, 0);
      const worker = this.worker ??= this.startWorker();
      worker.ref();
      try {
        await this.runBatch(worker, sources, active);
        return;
      } catch (error) {
        if (this.closed) throw error;
        const timedOut = error instanceof SourceTimeout;
        const parseFailed = error instanceof LinkParseFailure;
        const oom = (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY";
        const ordinal = timedOut || parseFailed ? error.ordinal : Atomics.load(active, 0);
        const source = sources[ordinal];
        if (!source || (!timedOut && !oom && !parseFailed) || source.skipHints) throw error;
        if (!parseFailed) await this.stopWorker();
        if (this.closed) return;
        if (oom && sources.length > 1) {
          await this.indexBatch([source]);
        } else if (timedOut && !source.bounded && !source.skipReason) {
          await this.indexBatch([{ ...source, bounded: true }]);
        } else {
          const skipReason = source.skipReason ?? (timedOut ? "timeout" : oom ? "oom" : "region");
          await this.indexBatch([{ ...source, skipReason, ...(source.skipReason && { skipHints: true }) }]);
        }
        sources.splice(ordinal, 1);
      } finally {
        worker.unref();
      }
    }
  }

  private async runBatch(worker: Worker, sources: LinkIndexSource[], active: Int32Array<SharedArrayBuffer>): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.pending = {
          resolve,
          reject,
          progress: ({ ordinal, generation }) => {
            clearTimeout(deadline);
            const source = sources[ordinal];
            if (!source) return;
            const base = this.options.parseTimeoutMs ?? 10_000;
            const budget = Math.min(120_000,
              base * (1 + Math.min(source.attempts, 3)) + Math.min(3 * base, Math.floor(source.size / 1024) * 25));
            deadline = setTimeout(() => {
              // The worker can already have advanced while its next progress
              // message is queued on the main thread.
              if (Atomics.load(active, 1) === generation) reject(new SourceTimeout(ordinal));
            }, source.bounded ? Math.max(budget, 5_000) : budget);
          },
        };
        worker.postMessage({ sources, active: active.buffer } satisfies Batch);
      });
    } finally {
      clearTimeout(deadline);
      this.pending = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopWorker();
  }

  private startWorker(): Worker {
    const worker = new Worker(entry, {
      workerData: { kind: workerKind, databasePath: this.databasePath, options: this.options },
      resourceLimits: { maxOldGenerationSizeMb: 152, maxYoungGenerationSizeMb: 8 },
      env: {},
      execArgv: [],
    });
    worker.on("message", (message: WorkerMessage) => {
      if (this.worker !== worker) return;
      const pending = this.pending;
      if (message === true) pending?.resolve();
      else if ("generation" in message) pending?.progress(message);
      else if (message.kind === "parse") pending?.reject(new LinkParseFailure(message.ordinal));
      else pending?.reject(new LinkStorageFailure(message.kind));
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(error);
    };
    worker.on("error", (error: NodeJS.ErrnoException) =>
      failed(error.code === "ERR_SQLITE_ERROR" ? new LinkStorageFailure(storageFailureKind(error)) : error));
    worker.on("exit", () => {
      failed(new Error("markdown_link_worker_exited"));
      if (this.worker === worker) this.worker = undefined;
    });
    return worker;
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    if (worker) this.termination ??= worker.terminate();
    const termination = this.termination;
    if (!termination) return;
    await termination;
    if (this.termination === termination) this.termination = undefined;
  }
}

if (parentPort && workerData?.kind === workerKind) {
  const port = parentPort;
  const db = new DatabaseSync(workerData.databasePath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -2048;");
  const links = new MarkdownLinkIndex(db, workerData.options as LinkExtractionOptions, false);
  port.on("message", ({ sources, active }: Batch) => {
    try {
      const state = new Int32Array(active);
      links.indexSources(sources, (ordinal) => {
        Atomics.store(state, 0, ordinal);
        const generation = Atomics.add(state, 1, 1) + 1;
        port.postMessage({ ordinal, generation } satisfies Progress);
      });
      port.postMessage(true);
    } catch (error) {
      port.postMessage(error instanceof LinkParseFailure
        ? { kind: "parse", ordinal: error.ordinal } satisfies WorkerMessage
        : { kind: storageFailureKind(error) } satisfies WorkerMessage);
    }
  });
}
