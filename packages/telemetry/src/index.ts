import {
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanAttributes,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

/**
 * Tracing and error reporting for libraries (Section 19: every worker step emits a span).
 * Only @opentelemetry/api is used here, so without `initTelemetry` (./init) every span is
 * a no-op and nothing is exported. Traces cross the queue in the job payload as a W3C
 * `traceparent`, so one trace runs API → queue → worker.
 */
const tracer = () => trace.getTracer("codesentra");

type Reporter = (error: unknown, tags: Record<string, string>) => void;
let reporter: Reporter | null = null;

/** Set by initTelemetry when SENTRY_DSN is configured. */
export function setErrorReporter(r: Reporter | null): void {
  reporter = r;
}

/** Reports an unexpected error (Sentry when configured). Never throws. */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  try {
    reporter?.(error, tags);
  } catch {
    // reporting must never break the caller
  }
}

/** Runs `fn` in a child span of the active one; errors mark the span and propagate. */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** The active span's W3C traceparent, to carry across the queue; undefined when not tracing. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** Runs `fn` with the remote parent from a traceparent (a job's enqueuer) active. */
export function withTraceparent<T>(traceparent: string | undefined, fn: () => T): T {
  if (!traceparent) return context.with(ROOT_CONTEXT, fn);
  const ctx = propagation.extract(ROOT_CONTEXT, { traceparent });
  return context.with(ctx, fn);
}

export { type Span, SpanStatusCode } from "@opentelemetry/api";
