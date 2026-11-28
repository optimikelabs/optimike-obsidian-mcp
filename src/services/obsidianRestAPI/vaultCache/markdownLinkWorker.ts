import { DatabaseSync } from "node:sqlite";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { MarkdownLinkIndex } from "./markdownLinkIndex.js";

const entry = new URL(import.meta.url);
const workerKind = "filesystem-markdown-links";

/** One outstanding batch. Only paths cross the worker boundary. */
export class MarkdownLinkWorker {
  private readonly worker: Worker;
  private failure?: Error;
  private pending?: { resolve: () => void; reject: (error: Error) => void };
  private termination?: Promise<number>;

  constructor(databasePath: string) {
    this.worker = new Worker(entry, {
      workerData: { kind: workerKind, databasePath },
      resourceLimits: { maxOldGenerationSizeMb: 136, maxYoungGenerationSizeMb: 8 },
      env: {},
      execArgv: [],
    });
    this.worker.on("message", (ok: boolean) => {
      if (!ok) {
        this.fail(new Error("markdown_link_batch_failed"));
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      pending?.resolve();
    });
    this.worker.on("error", () => this.fail(new Error("markdown_link_worker_failed")));
    this.worker.on("exit", () => this.fail(new Error("markdown_link_worker_exited")));
  }

  readonly indexPaths = (paths: string[]): Promise<void> => {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(paths);
    });
  };

  async close(): Promise<void> {
    await (this.termination ??= this.worker.terminate());
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

if (parentPort && workerData?.kind === workerKind) {
  const port = parentPort;
  const db = new DatabaseSync(workerData.databasePath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -2048;");
  const links = new MarkdownLinkIndex(db);
  port.on("message", (paths: string[]) => {
    try {
      for (const filePath of paths) links.indexSource(filePath);
      port.postMessage(true);
    } catch {
      port.postMessage(false);
    }
  });
}
