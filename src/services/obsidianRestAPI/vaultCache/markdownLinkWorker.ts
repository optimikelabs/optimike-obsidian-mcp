import { DatabaseSync } from "node:sqlite";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { MarkdownLinkIndex, type LinkIndexSource } from "./markdownLinkIndex.js";
import type { LinkExtractionOptions } from "./boundedLinkReferences.js";

const entry = new URL(import.meta.url);
const workerKind = "filesystem-markdown-links";
type Batch = { sources: LinkIndexSource[]; active: SharedArrayBuffer };

/** At most one worker and one outstanding batch per cache service. */
export class MarkdownLinkWorker {
  private worker?: Worker;
  private closed = false;
  private pending?: { resolve: () => void; reject: (error: Error) => void };
  private termination?: Promise<number>;

  constructor(
    private readonly databasePath: string,
    private readonly options: LinkExtractionOptions,
    private readonly index: MarkdownLinkIndex,
  ) {}

  readonly indexPaths = (paths: string[]): Promise<void> => this.indexBatch(this.index.describeSources(paths));

  private async indexBatch(sources: LinkIndexSource[]): Promise<void> {
    const active = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    while (sources.length && !this.closed) {
      Atomics.store(active, 0, sources.length === 1 ? 0 : -1);
      const worker = this.worker ??= this.startWorker();
      worker.ref();
      try {
        await new Promise<void>((resolve, reject) => {
          this.pending = { resolve, reject };
          worker.postMessage({ sources, active: active.buffer } satisfies Batch);
        });
        return;
      } catch (error) {
        const source = sources[Atomics.load(active, 0)];
        if ((error as NodeJS.ErrnoException).code !== "ERR_WORKER_OUT_OF_MEMORY" || !source || this.closed) throw error;
        await this.stopWorker();
        if (this.closed) return;
        // The worker can die before emitting a message. Its atomic ordinal
        // identifies the exact input version without transferring note text.
        if (sources.length > 1) {
          await this.indexBatch([source]);
        } else if (!source.skipParse) {
          source.skipParse = true;
          continue;
        } else {
          this.index.markSourceLimited(source);
        }
        sources.splice(sources.indexOf(source), 1);
      } finally {
        worker.unref();
      }
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
    worker.on("message", (ok: boolean) => {
      const pending = this.pending;
      this.pending = undefined;
      if (ok) pending?.resolve();
      else pending?.reject(new Error("markdown_link_batch_failed"));
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
      const ordinal = new Int32Array(active);
      links.indexSources(sources, (index) => Atomics.store(ordinal, 0, index));
      port.postMessage(true);
    } catch {
      port.postMessage(false);
    }
  });
}
