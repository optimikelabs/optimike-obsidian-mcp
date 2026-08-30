export type RestExtensionLifecycleState =
  | "unavailable"
  | "probing"
  | "mounting"
  | "ready"
  | "degraded";

export interface RestExtensionLifecycleSnapshot {
  state: RestExtensionLifecycleState;
  running: boolean;
  mountGeneration: number;
  unloadGeneration: number;
  consecutiveFailures: number;
  nextProbeDelayMs: number | null;
}

export interface RestExtensionLifecycleOptions<Provider extends object> {
  probe: () => Provider | null;
  mount: (provider: Provider) => (() => void) | null;
  initialRetryMs?: number;
  maximumRetryMs?: number;
  readyProbeMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  onCleanupError?: () => void;
}

/**
 * Permanently supervises one Local REST API extension registration.
 *
 * Provider object identity is the generation fence: the same provider is
 * never mounted twice, while a disabled/reloaded provider is unregistered
 * before its replacement is mounted. Retries are recursive (one timer only),
 * bounded, and continue until stop() instead of expiring after 30 seconds.
 */
export class RestExtensionLifecycle<Provider extends object> {
  private readonly initialRetryMs: number;
  private readonly maximumRetryMs: number;
  private readonly readyProbeMs: number;
  private readonly scheduleTimer: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  private readonly cancelTimer: (timer: unknown) => void;
  private readonly onCleanupError: () => void;
  private timer: unknown | null = null;
  private provider: Provider | null = null;
  private cleanup: (() => void) | null = null;
  private cleanupPending = false;
  private running = false;
  private probing = false;
  private state: RestExtensionLifecycleState = "unavailable";
  private mountGeneration = 0;
  private unloadGeneration = 0;
  private consecutiveFailures = 0;
  private nextProbeDelayMs: number | null = null;

  constructor(
    private readonly options: RestExtensionLifecycleOptions<Provider>,
  ) {
    this.initialRetryMs = Math.max(
      50,
      Math.floor(options.initialRetryMs ?? 250),
    );
    this.maximumRetryMs = Math.max(
      this.initialRetryMs,
      Math.floor(options.maximumRetryMs ?? 5_000),
    );
    this.readyProbeMs = Math.max(
      100,
      Math.floor(options.readyProbeMs ?? 1_000),
    );
    this.scheduleTimer =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = globalThis.setTimeout(callback, delayMs);
        if (
          typeof timer === "object" &&
          timer !== null &&
          "unref" in timer &&
          typeof timer.unref === "function"
        ) {
          timer.unref();
        }
        return timer;
      });
    this.cancelTimer =
      options.cancel ??
      ((timer) =>
        globalThis.clearTimeout(
          timer as ReturnType<typeof globalThis.setTimeout>,
        ));
    this.onCleanupError = options.onCleanupError ?? (() => undefined);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.probeNow();
  }

  stop(): void {
    if (!this.running && !this.cleanup) return;
    this.running = false;
    this.clearTimer();
    this.state = this.disposeMount() ? "unavailable" : "degraded";
    this.nextProbeDelayMs = null;
  }

  probeNow(): void {
    if (!this.running || this.probing) return;
    this.clearTimer();
    this.probing = true;
    this.state = "probing";
    try {
      const provider = this.options.probe();
      if (!provider) {
        if (!this.disposeMount()) {
          this.state = "degraded";
          this.consecutiveFailures += 1;
          this.scheduleRetry();
          return;
        }
        this.state = "unavailable";
        this.consecutiveFailures += 1;
        this.scheduleRetry();
        return;
      }

      if (provider === this.provider && this.cleanup && !this.cleanupPending) {
        this.state = "ready";
        this.consecutiveFailures = 0;
        this.scheduleNext(this.readyProbeMs);
        return;
      }

      if (!this.disposeMount()) {
        this.state = "degraded";
        this.consecutiveFailures += 1;
        this.scheduleRetry();
        return;
      }
      this.state = "mounting";
      const cleanup = this.options.mount(provider);
      if (!cleanup) {
        this.state = "unavailable";
        this.consecutiveFailures += 1;
        this.scheduleRetry();
        return;
      }

      this.provider = provider;
      this.cleanup = cleanup;
      this.cleanupPending = false;
      this.mountGeneration += 1;
      this.consecutiveFailures = 0;
      this.state = "ready";
      this.scheduleNext(this.readyProbeMs);
    } catch {
      this.disposeMount();
      this.state = "degraded";
      this.consecutiveFailures += 1;
      this.scheduleRetry();
    } finally {
      this.probing = false;
    }
  }

  snapshot(): RestExtensionLifecycleSnapshot {
    return {
      state: this.state,
      running: this.running,
      mountGeneration: this.mountGeneration,
      unloadGeneration: this.unloadGeneration,
      consecutiveFailures: this.consecutiveFailures,
      nextProbeDelayMs: this.nextProbeDelayMs,
    };
  }

  private disposeMount(): boolean {
    const cleanup = this.cleanup;
    if (!cleanup) {
      this.provider = null;
      this.cleanupPending = false;
      return true;
    }
    try {
      cleanup();
      this.cleanup = null;
      this.provider = null;
      this.cleanupPending = false;
      this.unloadGeneration += 1;
      return true;
    } catch {
      this.cleanupPending = true;
      this.onCleanupError();
      return false;
    }
  }

  private scheduleRetry(): void {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const delay = Math.min(
      this.maximumRetryMs,
      this.initialRetryMs * 2 ** Math.min(exponent, 20),
    );
    this.scheduleNext(delay);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) {
      this.nextProbeDelayMs = null;
      return;
    }
    this.clearTimer();
    this.nextProbeDelayMs = delayMs;
    this.timer = this.scheduleTimer(() => {
      this.timer = null;
      this.nextProbeDelayMs = null;
      this.probeNow();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancelTimer(this.timer);
    this.timer = null;
    this.nextProbeDelayMs = null;
  }
}
