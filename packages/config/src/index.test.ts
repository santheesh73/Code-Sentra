import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_ENV_KEYS, ConfigError, isPlaceholder, loadConfig, SERVICE_ENV } from "./index.js";

function validEnv(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://cs:pw@localhost:5432/cs",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "codesentra",
    S3_ACCESS_KEY_ID: "minio-access",
    S3_SECRET_ACCESS_KEY: randomBytes(16).toString("hex"),
    ANTHROPIC_API_KEY: `sk-ant-${randomBytes(16).toString("hex")}`,
    ANTHROPIC_MODEL: "model-id-from-env",
    GITHUB_OAUTH_CLIENT_ID: "Iv1.abc",
    GITHUB_OAUTH_CLIENT_SECRET: randomBytes(20).toString("hex"),
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    GITHUB_WEBHOOK_SECRET: randomBytes(20).toString("hex"),
    EMAIL_FROM: "alerts@codesentra.dev",
    EMAIL_PROVIDER_API_KEY: randomBytes(12).toString("hex"),
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: randomBytes(12).toString("hex"),
    PUBLIC_APP_URL: "http://localhost:3000",
    SANDBOX_RUNTIME: "runsc",
  };
}

describe("loadConfig", () => {
  it("loads a valid environment for every service", () => {
    const env = validEnv();
    for (const service of Object.keys(SERVICE_ENV) as (keyof typeof SERVICE_ENV)[]) {
      expect(() => loadConfig(service, env)).not.toThrow();
    }
  });

  it("restores escaped newlines in the PEM key", () => {
    const cfg = loadConfig("api", validEnv());
    expect(cfg.GITHUB_APP_PRIVATE_KEY).toContain("\n");
    expect(cfg.GITHUB_APP_PRIVATE_KEY).not.toContain("\\n");
  });

  it("only exposes the service's variables", () => {
    const cfg = loadConfig("worker-pulse", validEnv()) as Record<string, unknown>;
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.DATABASE_URL).toBeDefined();
  });

  it("does not require variables a service does not use", () => {
    const env = validEnv();
    delete env.ANTHROPIC_API_KEY;
    expect(() => loadConfig("worker-pulse", env)).not.toThrow();
    expect(() => loadConfig("worker-link", env)).toThrow(ConfigError);
  });

  it("reports every missing variable at once", () => {
    try {
      loadConfig("api", {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const keys = (e as ConfigError).problems.map((p) => p.key);
      expect(keys).toContain("DATABASE_URL");
      expect(keys).toContain("SESSION_SECRET");
      expect((e as ConfigError).problems.find((p) => p.key === "DATABASE_URL")?.message).toBe(
        "is required",
      );
    }
  });

  it("refuses placeholder secrets", () => {
    for (const bad of [
      "change-me",
      "changeme",
      "CHANGE_ME",
      "your-secret-here",
      "xxxx",
      "<secret>",
    ]) {
      expect(isPlaceholder(bad), bad).toBe(true);
      expect(() => loadConfig("api", { ...validEnv(), SLACK_CLIENT_SECRET: bad }), bad).toThrow(
        /SLACK_CLIENT_SECRET/,
      );
    }
    expect(() =>
      loadConfig("api", { ...validEnv(), GITHUB_WEBHOOK_SECRET: "changeme-webhook-secret" }),
    ).toThrow(/placeholder/);
    expect(isPlaceholder("a8f3c9e1d2b7")).toBe(false);
    expect(() => loadConfig("api", { ...validEnv(), S3_SECRET_ACCESS_KEY: "change-me" })).toThrow(
      /placeholder/,
    );
  });

  it("validates key formats", () => {
    expect(() => loadConfig("api", { ...validEnv(), ENCRYPTION_KEY: "short" })).toThrow(
      /ENCRYPTION_KEY/,
    );
    expect(() => loadConfig("api", { ...validEnv(), SESSION_SECRET: "too-short" })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => loadConfig("api", { ...validEnv(), DATABASE_URL: "mysql://x/y" })).toThrow(
      /postgres/,
    );
    expect(() =>
      loadConfig("api", { ...validEnv(), GITHUB_APP_PRIVATE_KEY: "not a pem key" }),
    ).toThrow(/PEM/);
    expect(() => loadConfig("worker-scan", { ...validEnv(), SANDBOX_RUNTIME: "docker" })).toThrow(
      /SANDBOX_RUNTIME/,
    );
  });

  it("never includes secret values in error messages", () => {
    const env = { ...validEnv(), ENCRYPTION_KEY: "super-sensitive-value-123" };
    try {
      loadConfig("api", env);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("super-sensitive-value-123");
    }
  });

  it("treats empty strings as missing", () => {
    expect(() => loadConfig("web", { ...validEnv(), PUBLIC_APP_URL: "" })).toThrow(/is required/);
  });

  it("accepts optional observability variables when absent", () => {
    const cfg = loadConfig("api", validEnv());
    expect(cfg.SENTRY_DSN).toBeUndefined();
  });
});

describe(".env.example", () => {
  it("documents exactly the variables the schema knows", () => {
    const path = fileURLToPath(new URL("../../../.env.example", import.meta.url));
    const documented = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1])
      .filter((k): k is string => Boolean(k))
      .sort();
    const composeOnly = ["POSTGRES_PASSWORD"];
    const known = [...ALL_ENV_KEYS.filter((k) => k !== "NODE_ENV"), ...composeOnly].sort();
    expect(documented).toEqual(known);
  });

  it("every schema variable is used by at least one service or is optional", () => {
    const used = new Set<string>(Object.values(SERVICE_ENV).flat());
    for (const k of ALL_ENV_KEYS) {
      if (["NODE_ENV", "SENTRY_DSN", "OTEL_EXPORTER_OTLP_ENDPOINT"].includes(k)) continue;
      expect(used.has(k), k).toBe(true);
    }
  });
});
