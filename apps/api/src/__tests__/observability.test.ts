import { initTelemetry, type Telemetry } from "@codesentra/telemetry/init";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, signIn, startTestApi, type TestApi } from "./helpers.js";

/**
 * Section 19: one trace runs API → queue → worker. The request's span is the parent of
 * the job's span (via the traceparent in the job payload), and each step has its own.
 */
const exporter = new InMemorySpanExporter();
let telemetry: Telemetry;
let api: TestApi;

beforeAll(async () => {
  telemetry = initTelemetry({
    service: "api-test",
    environment: "test",
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  api = await startTestApi();
}, 120_000);
afterAll(async () => {
  await api?.close();
  await telemetry?.shutdown();
});

describe("tracing", () => {
  it("links the request, the job and its steps in one trace", async () => {
    const cookie = await signIn(api, "trace@example.com");
    const orgId = (
      await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })
    ).json().organizations[0].id;
    const project = (
      await api.app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: as(cookie),
        payload: { org_id: orgId, name: "traced" },
      })
    ).json();
    const res = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/diagnostic`,
      headers: as(cookie),
    });
    expect(res.statusCode, res.body).toBe(202);
    const runId = res.json().run_id;
    for (let i = 0; i < 100; i++) {
      const run = (
        await api.app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie } })
      ).json();
      if (run.status !== "queued" && run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const spans = exporter.getFinishedSpans();
    const request = spans.find((s) => s.name === "POST /v1/projects/:id/diagnostic");
    const job = spans.find(
      (s) => s.name === "job system.diagnostic" && s.attributes["codesentra.run_id"] === runId,
    );
    expect(request, spans.map((s) => s.name).join(", ")).toBeDefined();
    expect(job).toBeDefined();
    expect(job?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(job?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    const steps = spans.filter(
      (s) =>
        s.name.startsWith("step ") && s.parentSpanContext?.spanId === job?.spanContext().spanId,
    );
    expect(steps.map((s) => s.name).sort()).toEqual([
      "step database",
      "step object_storage",
      "step queue",
    ]);
    expect(
      steps.find((s) => s.name === "step object_storage")?.attributes["codesentra.step_status"],
    ).toBe("skipped");
  });
});
