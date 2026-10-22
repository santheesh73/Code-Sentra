import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { GithubApp } from "@codesentra/github";
import { linkHandler } from "@codesentra/link/job";
import { startQueueClient, startWorker } from "@codesentra/queue";
import pino from "pino";

const config = loadConfig("worker-link");
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker-link" } });

const db = createDatabase(config.DATABASE_URL, { applicationName: "codesentra-worker-link" });
const queue = await startQueueClient(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "queue error"),
});
const github =
  config.integrations.github_app && config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY
    ? new GithubApp({
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_APP_PRIVATE_KEY,
        apiBaseUrl: config.GITHUB_API_BASE_URL,
      })
    : null;
// Link reads stored evidence and code facts and writes issues and GitHub check runs; it
// never fetches or runs the user's code.
const worker = await startWorker({
  db,
  queue,
  log,
  handlers: { "link.run": linkHandler({ github, appUrl: config.PUBLIC_APP_URL }) },
});
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
