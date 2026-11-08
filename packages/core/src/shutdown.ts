export interface ShutdownLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ShutdownOptions {
  /** Release resources (stop workers, close the queue, DB, telemetry). */
  drain: (signal: string) => Promise<void>;
  log?: ShutdownLogger;
  /** Force exit if the drain has not finished in this long. Default 25s. */
  timeoutMs?: number;
  /** Injected for tests. */
  exit?: (code: number) => void;
  register?: (signal: NodeJS.Signals, handler: () => void) => void;
}

const silent: ShutdownLogger = { info() {}, error() {} };

/**
 * Installs idempotent, time-bounded graceful shutdown (resilience, Section 20). On the first
 * SIGTERM/SIGINT it runs `drain` and exits 0; a second signal while draining is ignored; and a
 * drain that hangs past `timeoutMs` forces exit 1 so a stuck in-flight job cannot block a
 * deploy forever. Returns the handler for direct testing.
 */
export function installShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const log = opts.log ?? silent;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const register =
    opts.register ??
    ((signal: NodeJS.Signals, handler: () => void) => {
      process.on(signal, handler);
    });
  const timeoutMs = opts.timeoutMs ?? 25_000;
  let started = false;

  const shutdown = async (signal: string) => {
    if (started) return;
    started = true;
    log.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      log.error({ timeoutMs }, "shutdown timed out; forcing exit");
      exit(1);
    }, timeoutMs);
    // Do not let the force-exit timer itself keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    try {
      await opts.drain(signal);
      clearTimeout(timer);
      exit(0);
    } catch (e) {
      clearTimeout(timer);
      log.error({ err: (e as Error).message }, "error during shutdown");
      exit(1);
    }
  };

  register("SIGTERM", () => void shutdown("SIGTERM"));
  register("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
