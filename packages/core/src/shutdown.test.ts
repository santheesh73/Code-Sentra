import { describe, expect, it, vi } from "vitest";
import { installShutdown } from "./shutdown.js";

function harness(drain: (signal: string) => Promise<void>, timeoutMs?: number) {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const shutdown = installShutdown({
    drain,
    timeoutMs,
    exit: (c) => exits.push(c),
    register: (s, h) => handlers.set(s, h),
  });
  return { shutdown, handlers, exits };
}

describe("installShutdown", () => {
  it("registers SIGTERM and SIGINT and exits 0 after a clean drain", async () => {
    const drained: string[] = [];
    const { handlers, exits } = harness(async (sig) => {
      drained.push(sig);
    });
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(drained).toEqual(["SIGTERM"]);
  });

  it("is idempotent: a second signal while draining is ignored", async () => {
    let calls = 0;
    const { shutdown, exits } = harness(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
    });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT"), shutdown("SIGTERM")]);
    expect(calls).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("forces exit 1 when the drain hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const exits: number[] = [];
      const shutdown = installShutdown({
        drain: () => new Promise<void>(() => {}), // never resolves
        timeoutMs: 1000,
        exit: (c) => exits.push(c),
        register: () => {},
      });
      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(1000);
      expect(exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits 1 when the drain throws", async () => {
    const { shutdown, exits } = harness(async () => {
      throw new Error("drain failed");
    });
    await shutdown("SIGTERM");
    expect(exits).toEqual([1]);
  });

  it("registers real process signal handlers and calls process.exit by default", async () => {
    const onSpy = vi.spyOn(process, "on").mockReturnValue(process as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      // No injected register/exit: exercise the production defaults.
      const shutdown = installShutdown({ drain: async () => {} });
      expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      await shutdown("SIGTERM");
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      onSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
