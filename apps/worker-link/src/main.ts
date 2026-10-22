import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { linkHandler } from "@codesentra/link/job";
import { startQueueClient, startWorker } from "@codesentra/queue";
import pino from "pino";

const config = loadConfig("worker-link");
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker-link" } });

const db = createDatabase(config.DATABASE_URL, { applicationName: "codesentra-worker-link" });
const queue = await startQueueClient(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "queue error"),
});
// Link reads stored evidence and code facts and writes issues; it never fetches or runs code.
const worker = await startWorker({ db, queue, log, handlers: { "link.run": linkHandler() } });
log.info("worker-link ready");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.stop();
  await queue.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
