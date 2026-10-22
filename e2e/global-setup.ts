import { join } from "node:path";
import { runMigrations } from "@codesentra/db";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";
import { freePort, newEnvBase, ROOT, spawnService, stop, waitFor } from "./stack";

/**
 * Boots the real stack: Postgres 16 and MinIO in containers, migrations, the API and the
 * web app as production builds. worker-pulse is started by the tests themselves so they
 * can prove the run page updates live. Nothing here talks to the internet.
 */
export default async function globalSetup() {
  const minioUser = "cs-e2e";
  const minioPassword = `cs-e2e-${Math.random().toString(36).slice(2)}-password`;
  const [pg, minio] = await Promise.all([
    new PostgreSqlContainer("postgres:16.15-alpine").start(),
    new GenericContainer("pgsty/minio:RELEASE.2026-08-04T00-00-00Z")
      .withCommand(["server", "/data"])
      .withEnvironment({ MINIO_ROOT_USER: minioUser, MINIO_ROOT_PASSWORD: minioPassword })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
      .start(),
  ]);
  const mb = await minio.exec([
    "sh",
    "-c",
    `mc alias set l http://127.0.0.1:9000 ${minioUser} ${minioPassword} && mc mb l/codesentra`,
  ]);
  if (mb.exitCode !== 0) throw new Error(`bucket creation failed: ${mb.output}`);

  const databaseUrl = pg.getConnectionUri();
  await runMigrations(databaseUrl);

  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const appUrl = `http://localhost:${webPort}`;
  const env: Record<string, string> = {
    ...newEnvBase(),
    DATABASE_URL: databaseUrl,
    PUBLIC_APP_URL: appUrl,
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    S3_ENDPOINT: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
    S3_BUCKET: "codesentra",
    S3_ACCESS_KEY_ID: minioUser,
    S3_SECRET_ACCESS_KEY: minioPassword,
  };

  const api = spawnService("api", [join(ROOT, "apps/api/dist/server.js")], env);
  await waitFor(`http://127.0.0.1:${apiPort}/health`);
  const web = spawnService(
    "web",
    [
      join(ROOT, "apps/web/node_modules/next/dist/bin/next"),
      "start",
      "--port",
      String(webPort),
      "--hostname",
      "localhost",
    ],
    env,
    join(ROOT, "apps/web"),
  );
  await waitFor(`${appUrl}/signin`);

  process.env.CS_E2E_ENV = JSON.stringify(env);
  process.env.CS_E2E_APP_URL = appUrl;
  process.env.CS_E2E_OUTBOX = env.EMAIL_OUTBOX_DIR;

  return async () => {
    await Promise.all([stop(web), stop(api)]);
    await Promise.all([pg.stop(), minio.stop()]);
  };
}
