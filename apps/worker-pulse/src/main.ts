import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { diagnosticHandler, startQueueClient, startWorker } from "@codesentra/queue";
import { objectStoreFromEnv } from "@codesentra/storage";
import pino from "pino";

/**
 * Sentra Pulse worker. Phase 1 registers only the platform diagnostic job; the Pulse
 * check groups (`pulse.run`) arrive in Phase 2.
 */
const config = loadConfig("worker-pulse");
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker-pulse" } });

const store = objectStoreFromEnv(config);
if (!store)
  log.warn("object storage not configured: diagnostic object_storage step will be skipped");

const db = createDatabase(config.DATABASE_URL, { applicationName: "codesentra-worker-pulse" });
const queue = await startQueueClient(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "queue error"),
});
const worker = await startWorker({
  db,
  queue,
  log,
  handlers: { "system.diagnostic": diagnosticHandler({ store }) },
});
log.info("worker-pulse ready");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.stop();
  await queue.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
