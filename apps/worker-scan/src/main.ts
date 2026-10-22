import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { startQueueClient, startWorker } from "@codesentra/queue";
import { createSandbox, detectRuntime, dockerAvailable } from "@codesentra/sandbox";
import { anthropicModel, apiSource, offlineSource, type ReportModel } from "@codesentra/scan";
import { scanHandler } from "@codesentra/scan/job";
import { defaultPolicy, type FetchPolicy, testPolicy } from "@codesentra/ssrf";
import { objectStoreFromEnv } from "@codesentra/storage";
import pino from "pino";

const config = loadConfig("worker-scan");
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
    // TEST ONLY (packages/config refuses it unless NODE_ENV=test; ADR 0017).
    const { fixtureReportModel } = await import("@codesentra/fixture-harness");
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

const db = createDatabase(config.DATABASE_URL, { applicationName: "codesentra-worker-scan" });
const queue = await startQueueClient(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "queue error"),
});
const worker = await startWorker({
  db,
  queue,
  log,
  concurrency: 1,
  handlers: {
    "scan.run": scanHandler({
      store,
      sandbox,
      osv,
      secrets: docker ? { enabled: false, reason: docker } : { enabled: true },
      model,
      gitPolicy,
      allowHttpGit: config.NODE_ENV === "test" && !!config.PULSE_TEST_ALLOW_HOSTS,
      maxCommits: config.SCAN_MAX_COMMITS,
    }),
  },
});
log.info({ osv: osv.source.description, model: model.model?.name ?? null }, "worker-scan ready");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.stop();
  await queue.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
