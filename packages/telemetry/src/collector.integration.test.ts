import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSpan } from "./index.js";
import { initTelemetry } from "./init.js";

// Integration test: our OTLP-over-HTTP exporter must actually deliver spans to a real
// OpenTelemetry Collector. The in-memory test (telemetry.test.ts) proves span shape; this
// proves the wire path — initTelemetry({ otlpEndpoint }) → BatchSpanProcessor → OTLP/HTTP →
// collector receiver — end to end against the real collector binary.
//
// The collector runs with an OTLP/HTTP receiver and the `debug` exporter at detailed
// verbosity, so every received span (and its resource attributes) is printed to the
// collector's stdout, which we scrape to confirm delivery.

const COLLECTOR_IMAGE = "otel/opentelemetry-collector:0.96.0";
const CONFIG = `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  telemetry:
    logs:
      level: info
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;

let collector: StartedTestContainer;
let logs = "";

beforeAll(async () => {
  collector = await new GenericContainer(COLLECTOR_IMAGE)
    .withCopyContentToContainer([{ content: CONFIG, target: "/etc/otelcol/config.yaml" }])
    .withExposedPorts(4318)
    .withWaitStrategy(Wait.forLogMessage(/Everything is ready/))
    .start();
  const stream = await collector.logs();
  stream.on("data", (chunk: Buffer | string) => {
    logs += chunk.toString();
  });
}, 180_000);

afterAll(async () => {
  await collector?.stop();
});

async function waitForLog(needle: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (logs.includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe("OpenTelemetry collector integration", () => {
  it("exports spans over OTLP/HTTP to a real collector", async () => {
    const endpoint = `http://${collector.getHost()}:${collector.getMappedPort(4318)}`;
    const service = "codesentra-otel-test";
    const spanName = `probe-span-${Date.now()}`;

    const t = initTelemetry({ service, environment: "test", otlpEndpoint: endpoint });
    expect(t.tracing).toBe(true);

    await withSpan(spanName, { "codesentra.kind": "integration" }, async () => {
      await withSpan(`${spanName}-child`, {}, async () => {});
    });

    // shutdown() force-flushes the BatchSpanProcessor and waits for the OTLP POST to complete.
    await t.shutdown();

    // The collector's debug exporter prints each span's name and the resource's service.name.
    expect(await waitForLog(spanName), `collector never logged span "${spanName}"\n${logs}`).toBe(
      true,
    );
    expect(await waitForLog(`${spanName}-child`)).toBe(true);
    expect(await waitForLog(service), `collector never logged service.name "${service}"`).toBe(
      true,
    );
    expect(logs).toMatch(/codesentra\.kind/);
  }, 60_000);
});
