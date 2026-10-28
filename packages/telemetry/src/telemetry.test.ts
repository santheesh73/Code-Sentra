import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import {
  currentTraceparent,
  reportError,
  setErrorReporter,
  withSpan,
  withTraceparent,
} from "./index.js";
import { initTelemetry, scrubEvent } from "./init.js";

const exporter = new InMemorySpanExporter();
const t = initTelemetry({
  service: "test",
  environment: "test",
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
afterAll(() => t.shutdown());

describe("telemetry", () => {
  it("nests spans, marks failures and carries a traceparent across a boundary", async () => {
    let carried: string | undefined;
    await withSpan("parent", { a: 1 }, async () => {
      await withSpan("child", {}, async () => {});
      carried = currentTraceparent();
      await expect(
        withSpan("broken", {}, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });
    expect(carried).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    await withTraceparent(carried, () => withSpan("remote", {}, async () => {}));
    const spans = exporter.getFinishedSpans();
    const by = (n: string) => spans.find((s) => s.name === n);
    expect(by("child")?.parentSpanContext?.spanId).toBe(by("parent")?.spanContext().spanId);
    expect(by("broken")?.status.code).toBe(2);
    expect(by("broken")?.events[0]?.name).toBe("exception");
    expect(by("remote")?.spanContext().traceId).toBe(by("parent")?.spanContext().traceId);
    expect(by("remote")?.parentSpanContext?.spanId).toBe(by("parent")?.spanContext().spanId);
    // No traceparent: a new root, never someone else's trace.
    await withTraceparent(undefined, () => withSpan("root", {}, async () => {}));
    const root = exporter.getFinishedSpans().find((s) => s.name === "root");
    expect(root?.parentSpanContext).toBeUndefined();
  });

  it("reports errors only through the configured reporter, and never throws", () => {
    const seen: unknown[] = [];
    reportError(new Error("ignored"));
    setErrorReporter((e) => seen.push(e));
    reportError(new Error("kept"), { job: "x" });
    setErrorReporter(() => {
      throw new Error("reporter down");
    });
    expect(() => reportError(new Error("still fine"))).not.toThrow();
    setErrorReporter(null);
    expect(seen).toHaveLength(1);
  });

  it("strips bodies, cookies, auth and signatures from Sentry events", () => {
    const e = scrubEvent({
      request: {
        data: '{"token":"cs_x"}',
        cookies: "cs_session=1",
        headers: {
          Authorization: "Bearer cs_x",
          cookie: "cs_session=1",
          "x-hub-signature-256": "sha256=…",
          "user-agent": "curl",
        },
      },
    });
    expect(e.request).toEqual({ headers: { "user-agent": "curl" } });
  });
});
