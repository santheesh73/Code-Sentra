/**
 * Per-host politeness: at most `concurrency` requests in flight per host, and at least
 * `minIntervalMs` between request starts to the same host.
 */
export class HostLimiter {
  private readonly active = new Map<string, number>();
  private readonly lastStart = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();

  constructor(
    private readonly concurrency = 4,
    private readonly minIntervalMs = 50,
  ) {}

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const key = host.toLowerCase();
    while ((this.active.get(key) ?? 0) >= this.concurrency) {
      await new Promise<void>((r) => {
        const q = this.waiters.get(key) ?? [];
        q.push(r);
        this.waiters.set(key, q);
      });
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    const wait = (this.lastStart.get(key) ?? 0) + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastStart.set(key, Date.now());
    try {
      return await fn();
    } finally {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      this.waiters.get(key)?.shift()?.();
    }
  }
}
