import { loadConfig } from "@codesentra/config";
import { createDatabase } from "@codesentra/db";
import { createRunEventListener, startQueueClient } from "@codesentra/queue";
import { objectStoreFromEnv } from "@codesentra/storage";
import pino from "pino";
import { buildApp } from "./app.js";
import { createAuthService } from "./auth/service.js";
import { createAuthz } from "./authz.js";
import { type EmailTransport, outboxTransport, resendTransport } from "./email.js";

const config = loadConfig("api");
const log = pino({
  level: config.LOG_LEVEL,
  redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
});

const db = createDatabase(config.DATABASE_URL, { applicationName: "codesentra-api" });
const queue = await startQueueClient(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "queue error"),
});
const events = await createRunEventListener(config.DATABASE_URL, {
  onError: (e) => log.error({ err: e.message }, "run event listener error"),
});

let email: EmailTransport | null = null;
if (config.EMAIL_TRANSPORT === "outbox" && config.NODE_ENV !== "production") {
  email = outboxTransport(config.EMAIL_OUTBOX_DIR);
  log.warn(
    { dir: config.EMAIL_OUTBOX_DIR },
    "email outbox transport: sign-in links are written to disk, not sent",
  );
} else if (config.integrations.email && config.EMAIL_PROVIDER_API_KEY && config.EMAIL_FROM) {
  email = resendTransport(config.EMAIL_PROVIDER_API_KEY, config.EMAIL_FROM);
}

for (const [name, on] of Object.entries(config.integrations)) {
  if (!on && ["s3", "github_oauth", "github_app", "email", "slack"].includes(name)) {
    log.warn({ integration: name }, "integration not configured; dependent features answer 501");
  }
}

const auth = createAuthService(db);
const { app } = await buildApp(
  {
    config,
    db,
    auth,
    authz: createAuthz(db),
    queue,
    events,
    email,
    store: objectStoreFromEnv(config),
    cookie: { secure: new URL(config.PUBLIC_APP_URL).protocol === "https:" },
    fetch,
  },
  { logger: log },
);

const purge = setInterval(() => {
  auth.purgeExpired().catch((e) => log.error({ err: (e as Error).message }, "purge failed"));
}, 3_600_000);
purge.unref();

await app.listen({ host: config.API_HOST, port: config.API_PORT });

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  clearInterval(purge);
  await app.close();
  await events.close();
  await queue.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
