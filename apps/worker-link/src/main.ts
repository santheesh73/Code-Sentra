import { PULSE_GROUPS } from "@codesentra/checks";
import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { GithubApp } from "@codesentra/github";
import { linkHandler } from "@codesentra/link/job";
import {
  type EmailTransport,
  isSlackWebhookUrl,
  outboxTransport,
  resendTransport,
} from "@codesentra/notify";
import { runDueSchedules, startQueueClient, startWorker } from "@codesentra/queue";
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

let email: EmailTransport | null = null;
if (config.EMAIL_TRANSPORT === "outbox" && config.NODE_ENV !== "production")
  email = outboxTransport(config.EMAIL_OUTBOX_DIR);
else if (config.integrations.email && config.EMAIL_PROVIDER_API_KEY && config.EMAIL_FROM)
  email = resendTransport(config.EMAIL_PROVIDER_API_KEY, config.EMAIL_FROM);

// Slack webhooks live on one fixed public host: the URL is checked again before every
// post and redirects are refused, so a stored destination cannot be turned at another host.
const testHosts = new Set(
  (config.PULSE_TEST_ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
);
const slackFetch = (url: string, init: RequestInit) => {
  if (!isSlackWebhookUrl(url, testHosts))
    return Promise.reject(new Error("not a Slack webhook URL"));
  return fetch(url, { ...init, redirect: "error" });
};

// Link reads stored evidence and code facts and writes issues, check runs and alerts; it
// never fetches or runs the user's code.
const worker = await startWorker({
  db,
  queue,
  log,
  handlers: {
    "link.run": linkHandler({
      github,
      appUrl: config.PUBLIC_APP_URL,
      notifier: { encryptionKey: config.ENCRYPTION_KEY, email, slackFetch },
    }),
  },
});

// Recurring Pulses (schedule.tick): any number of replicas may tick; claims SKIP LOCKED.
let ticking = false;
const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    const r = await runDueSchedules({ db, queue, pulseSteps: PULSE_GROUPS });
    if (r.started.length || r.failed.length) log.info(r, "schedules fired");
  } catch (e) {
    log.error({ err: (e as Error).message }, "schedule tick failed");
  } finally {
    ticking = false;
  }
};
const scheduler =
  config.SCHEDULER_INTERVAL_SECONDS > 0
    ? setInterval(() => void tick(), config.SCHEDULER_INTERVAL_SECONDS * 1000)
    : null;
log.info(
  { email: email?.kind ?? null, scheduler_seconds: config.SCHEDULER_INTERVAL_SECONDS },
  "worker-link ready",
);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  if (scheduler) clearInterval(scheduler);
  await worker.stop();
  await queue.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
