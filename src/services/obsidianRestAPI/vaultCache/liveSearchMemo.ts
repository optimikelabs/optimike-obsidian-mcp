import type { LiveSearchScan } from "../../../mcp-server/tools/obsidianGlobalSearchTool/logic.js";

const TTL_MS = 30_000;
const MAX_ENTRIES = 4;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

export interface LiveSearchSnapshot {
  resultsJson: string;
  totalMatches: number;
  createdAt: number;
}

interface TimedSnapshot extends LiveSearchSnapshot {
  timer: ReturnType<typeof setTimeout>;
}

export class LiveSearchMemo {
  private generation?: string;
  private readonly entries = new Map<string, TimedSnapshot>();
  readonly inFlight = new Map<string, Promise<LiveSearchScan>>();

  useGeneration(generation: string | undefined): void {
    if (this.generation !== generation) {
      this.clear();
      this.generation = generation;
    }
  }

  get(key: string): LiveSearchSnapshot | undefined {
    const entry = this.entries.get(key);
    if (entry && performance.now() - entry.createdAt < TTL_MS) return entry;
    this.delete(key);
    return undefined;
  }

  save(key: string, rows: Iterable<unknown>, totalMatches: number): boolean {
    const encoded: string[] = [];
    let bytes = 4;
    for (const row of rows) {
      const json = JSON.stringify(row);
      bytes += 2 * (json.length + 1);
      if (bytes > MAX_RESULT_BYTES) return false;
      encoded.push(json);
    }
    this.delete(key);
    if (this.entries.size === MAX_ENTRIES) this.delete(this.entries.keys().next().value!);
    const timer = setTimeout(() => this.delete(key), TTL_MS);
    timer.unref();
    this.entries.set(key, {
      resultsJson: "[" + encoded.join(",") + "]",
      totalMatches,
      createdAt: performance.now(),
      timer,
    });
    return true;
  }

  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    this.inFlight.clear();
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) clearTimeout(entry.timer);
    this.entries.delete(key);
  }
}
