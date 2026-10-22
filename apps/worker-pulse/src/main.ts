import { readFileSync } from "node:fs";
import { launchPulseBrowser } from "@codesentra/checks";
import { pulseHandler } from "@codesentra/checks/job";
import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { diagnosticHandler, startQueueClient, startWorker } from "@codesentra/queue";
import { defaultPolicy, type FetchPolicy, testPolicy } from "@codesentra/ssrf";
import { objectStoreFromEnv } from "@codesentra/storage";
import pino from "pino";
import type { Browser } from "playwright-core";

const config = loadConfig("worker-pulse");
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker-pulse" } });

const store = objectStoreFromEnv(config);
if (!store)
  log.warn(
    "object storage not configured: screenshots are not stored; diagnostic storage step is skipped",
  );

// Test-only SSRF allowance (packages/config refuses it unless NODE_ENV=test).
let policy: FetchPolicy = defaultPolicy();
if (config.PULSE_TEST_ALLOW_HOSTS) {
  const hosts = config.PULSE_TEST_ALLOW_HOSTS.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const ca = config.PULSE_TEST_CA_FILE
    ? readFileSync(config.PULSE_TEST_CA_FILE, "utf8")
    : undefined;
  policy = testPolicy(hosts, { ca });
  log.warn({ hosts }, "TEST ONLY: SSRF address check disabled for these hosts");
}

// One browser per worker, relaunched if it crashes.
let browser: Browser | null = null;
let launching: Promise<{ browser: Browser } | { browser: null; reason: string }> | null = null;
async function getBrowser() {
  if (browser?.isConnected()) return { browser };
  launching ??= launchPulseBrowser().then((r) => {
    launching = null;
    if (r.browser) {
      browser = r.browser;
      log.info("chromium ready");
    } else {
      log.error(
        { reason: r.reason },
        "chromium unavailable; render checks will be recorded as gaps",
      );
    }
    return r;
  });
  return launching;
}

const db = createDatabase(config.DATABASE_URL, { applicationName: "codesentra-worker-pulse" });
const queue = await startQueueClient(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "queue error"),
});
const pulse = pulseHandler({
  policy,
  store,
  getBrowser,
  slowThresholdMs: config.PULSE_SLOW_THRESHOLD_MS,
});
const worker = await startWorker({
  db,
  queue,
  log,
  handlers: {
    "system.diagnostic": diagnosticHandler({ store }),
    "pulse.run": pulse,
    // Targeted re-checks (Section 10d) are Pulse runs of one check group.
    "issue.recheck": pulse,
  },
});
log.info("worker-pulse ready");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.stop();
  await queue.stop();
  await browser?.close().catch(() => {});
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
