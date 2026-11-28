import { DatabaseSync } from "node:sqlite";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { MarkdownLinkIndex, type LinkIndexSource } from "./markdownLinkIndex.js";
import type { LinkExtractionOptions } from "./boundedLinkReferences.js";

const entry = new URL(import.meta.url);
const workerKind = "filesystem-markdown-links";
const batchFailed = "markdown_link_batch_failed";
const SOURCE_TIMEOUT_MS = 10_000;
type Batch = { sources: LinkIndexSource[]; active: SharedArrayBuffer };
type Progress = { ordinal: number; generation: number };
type WorkerMessage = Progress | boolean;

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

  readonly indexPaths = (paths: string[]): Promise<void> => this.indexBatch(this.index.describeSources(paths));

  private async indexBatch(sources: LinkIndexSource[]): Promise<void> {
    const active = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    let retriedBatch = false;
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
        if (error instanceof Error && error.message === batchFailed) {
          if (!retriedBatch) {
            retriedBatch = true;
            continue;
          }
          if (sources.length > 1) {
            const middle = Math.floor(sources.length / 2);
            await this.indexBatch(sources.slice(0, middle));
            await this.indexBatch(sources.slice(middle));
            return;
          }
          const source = sources[0];
          if (!source.skipParse) await this.indexBatch([{ ...source, skipParse: true }]);
          else this.index.markSourceLimited(source);
          return;
        }

        const timedOut = error instanceof SourceTimeout;
        const ordinal = timedOut ? error.ordinal : Atomics.load(active, 0);
        const source = sources[ordinal];
        if (!source || (!timedOut && (error as NodeJS.ErrnoException).code !== "ERR_WORKER_OUT_OF_MEMORY")) throw error;
        await this.stopWorker();
        if (this.closed) return;
        if (timedOut) {
          if (!source.skipParse) {
            // A shorter pass can still collect possible backlink targets.
            // It has the same deadline and never publishes extracted links.
            await this.indexBatch([{ ...source, skipParse: true }]);
          } else {
            this.index.markSourceLimited(source);
          }
        } else if (sources.length > 1) {
          // Retry an OOM source in isolation before blaming it for the heap
          // used by its batch. A timed-out parse needs no full retry.
          await this.indexBatch([source]);
        } else if (!source.skipParse) {
          source.skipParse = true;
          retriedBatch = false;
          continue;
        } else {
          this.index.markSourceLimited(source);
        }
        sources.splice(ordinal, 1);
        retriedBatch = false;
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
            deadline = setTimeout(() => {
              // The worker can already have advanced while its next progress
              // message is queued on the main thread.
              if (Atomics.load(active, 1) === generation) reject(new SourceTimeout(ordinal));
            }, SOURCE_TIMEOUT_MS);
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
      if (typeof message !== "boolean") pending?.progress(message);
      else if (message) pending?.resolve();
      else pending?.reject(new Error(batchFailed));
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(error);
    };
    worker.on("error", failed);
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
  const links = new MarkdownLinkIndex(db, workerData.options as LinkExtractionOptions);
  port.on("message", ({ sources, active }: Batch) => {
    try {
      const state = new Int32Array(active);
      links.indexSources(sources, (ordinal) => {
        Atomics.store(state, 0, ordinal);
        const generation = Atomics.add(state, 1, 1) + 1;
        port.postMessage({ ordinal, generation } satisfies Progress);
      });
      port.postMessage(true);
    } catch {
      port.postMessage(false);
    }
  });
}
