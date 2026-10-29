import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { GithubApp } from "@codesentra/github";
import { startQueueClient, startWorker } from "@codesentra/queue";
import { createSandbox, detectRuntime, dockerAvailable } from "@codesentra/sandbox";
import { anthropicModel, apiSource, offlineSource, type ReportModel } from "@codesentra/scan";
import { scanHandler } from "@codesentra/scan/job";
import { defaultPolicy, type FetchPolicy, testPolicy } from "@codesentra/ssrf";
import { objectStoreFromEnv } from "@codesentra/storage";
import { initTelemetry } from "@codesentra/telemetry/init";
import pino from "pino";

const config = loadConfig("worker-scan");
// Tracing (OTLP) and error reporting (Sentry), each only when configured (Section 19).
const telemetry = initTelemetry({
  service: "worker-scan",
  environment: config.NODE_ENV,
  otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  sentryDsn: config.SENTRY_DSN,
});
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker-scan" } });

const store = objectStoreFromEnv(config);
if (!store)
  log.warn("object storage not configured: snapshots cannot be stored, so scans fail at ingest");

// Git clones use the same SSRF rules as Pulse (ADR 0013); the loopback allowance is test only.
let gitPolicy: FetchPolicy = defaultPolicy();
if (config.PULSE_TEST_ALLOW_HOSTS) {
  const hosts = config.PULSE_TEST_ALLOW_HOSTS.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  gitPolicy = testPolicy(hosts);
  log.warn({ hosts }, "TEST ONLY: SSRF address check disabled for these hosts (git)");
}

/** The sandbox, or why it is unavailable (probes are then recorded as gaps). */
async function sandbox() {
  const missing = await dockerAvailable();
  if (missing) return { sandbox: null, reason: missing } as const;
  const runtime = await detectRuntime();
  if (config.SANDBOX_RUNTIME === "runsc" && runtime !== "runsc")
    return {
      sandbox: null,
      reason: "SANDBOX_RUNTIME=runsc but Docker has no runsc (gVisor) runtime",
    } as const;
  return {
    sandbox: await createSandbox({
      network: config.SANDBOX_FETCH_NETWORK,
      proxy: config.SANDBOX_FETCH_PROXY ?? null,
      caFile: config.SANDBOX_FETCH_CA_FILE ?? null,
    }),
    image: config.SANDBOX_IMAGE,
  };
}

async function reportModel(): Promise<{ model: ReportModel } | { model: null; reason: string }> {
  if (config.SCAN_TEST_MODEL === "fixture") {
    // TEST ONLY (packages/config refuses it unless NODE_ENV=test; ADR 0017). The harness is
    // a devDependency, absent from the production image, so the specifier is not a literal:
    // the production build must not need its types.
    const harness = "@codesentra/fixture-harness";
    const { fixtureReportModel } = (await import(harness)) as {
      fixtureReportModel(): ReportModel;
    };
    log.warn("TEST ONLY: the scripted fixture model writes reports");
    return { model: fixtureReportModel() };
  }
  if (!config.integrations.anthropic || !config.ANTHROPIC_API_KEY || !config.ANTHROPIC_MODEL)
    return {
      model: null,
      reason: "the Anthropic integration is not configured (ANTHROPIC_API_KEY, ANTHROPIC_MODEL)",
    };
  return {
    model: anthropicModel({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }),
  };
}

const osv = config.OSV_OFFLINE_DIR
  ? { source: await offlineSource(config.OSV_OFFLINE_DIR) }
  : { source: apiSource() };
const docker = await dockerAvailable();
const model = await reportModel();
if (!model.model)
  log.warn({ reason: model.reason }, "no report model: inventory and explain will be gaps");

const db = createDatabase(config.DATABASE_URL, {
  applicationName: "codesentra-worker-scan",
  onError: (e) => log.error({ err: e.message }, "database connection error"),
});
const queue = await startQueueClient(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "queue error"),
});
// GitHub snapshots (pull requests, pushes) are fetched with the App's installation token.
const github =
  config.integrations.github_app && config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY
    ? new GithubApp({
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_APP_PRIVATE_KEY,
        apiBaseUrl: config.GITHUB_API_BASE_URL,
        gitBaseUrl: config.GITHUB_GIT_BASE_URL,
      })
    : null;
const scan = scanHandler({
  store,
  sandbox,
  osv,
  secrets: docker ? { enabled: false, reason: docker } : { enabled: true },
  model,
  gitPolicy,
  allowHttpGit: config.NODE_ENV === "test" && !!config.PULSE_TEST_ALLOW_HOSTS,
  maxCommits: config.SCAN_MAX_COMMITS,
  github,
  maxArchiveBytes: config.SCAN_MAX_UPLOAD_BYTES,
});
const worker = await startWorker({
  db,
  queue,
  log,
  concurrency: 1,
  handlers: {
    "scan.run": scan,
    // A pull request's head commit: the same Scan (cached by tree hash); Link narrows the
    // findings to the changed files and their blast radius (ADR 0021).
    "scan.incremental": scan,
  },
});
log.info({ osv: osv.source.description, model: model.model?.name ?? null }, "worker-scan ready");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.stop();
  await queue.stop();
  await db.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
