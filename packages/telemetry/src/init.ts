import { propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import * as Sentry from "@sentry/node";
import { setErrorReporter } from "./index.js";

export interface TelemetryOptions {
  service: string;
  version?: string;
  environment: string;
  /** OTEL_EXPORTER_OTLP_ENDPOINT, e.g. https://otlp.example:4318 (traces go to /v1/traces). */
  otlpEndpoint?: string;
  sentryDsn?: string;
  /** Extra span processors (tests use an in-memory exporter). */
  spanProcessors?: SpanProcessor[];
}

export interface Telemetry {
  tracing: boolean;
  errors: boolean;
  shutdown(): Promise<void>;
}

const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-hub-signature-256"]);

/** Sentry never receives request bodies, cookies, auth or webhook signature headers. */
export function scrubEvent<
  E extends {
    request?: { data?: unknown; cookies?: unknown; headers?: Record<string, string> };
  },
>(event: E): E {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers)
      for (const k of Object.keys(event.request.headers))
        if (SECRET_HEADERS.has(k.toLowerCase())) delete event.request.headers[k];
  }
  return event;
}

/**
 * Starts tracing (OTLP over HTTP) and error reporting (Sentry) when configured; both are
 * optional (Section 20 env list). Sentry gets no request bodies, cookies or auth headers.
 */
export function initTelemetry(o: TelemetryOptions): Telemetry {
  const processors = [...(o.spanProcessors ?? [])];
  if (o.otlpEndpoint)
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${o.otlpEndpoint.replace(/\/+$/, "")}/v1/traces` }),
      ),
    );
  let provider: NodeTracerProvider | null = null;
  if (processors.length) {
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": o.service,
        "service.version": o.version ?? "0.0.0",
        "deployment.environment.name": o.environment,
      }),
      spanProcessors: processors,
    });
    provider.register();
  }
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  if (o.sentryDsn) {
    Sentry.init({
      dsn: o.sentryDsn,
      environment: o.environment,
      release: o.version,
      // Our own provider owns tracing; Sentry only reports errors.
      skipOpenTelemetrySetup: true,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      defaultIntegrations: false,
      beforeSend: (event) => scrubEvent(event),
    });
    setErrorReporter((error, tags) => {
      Sentry.captureException(error, { tags: { service: o.service, ...tags } });
    });
  }

  return {
    tracing: provider !== null,
    errors: Boolean(o.sentryDsn),
    async shutdown() {
      await provider?.shutdown();
      if (o.sentryDsn) await Sentry.close(2000);
    },
  };
}
