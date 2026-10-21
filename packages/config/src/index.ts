import { z } from "zod";

/**
 * Values that indicate an unconfigured secret. The process refuses to start with
 * any of these (Section 17).
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^change[-_ ]?me$/i,
  /^changeme/i,
  /^replace[-_ ]?me/i,
  /^your[-_ ]/i,
  /^todo$/i,
  /^x{3,}$/i,
  /^secret$/i,
  /^password$/i,
  /^placeholder$/i,
  /^dummy$/i,
  /^test$/i,
  /^<.*>$/,
];

export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return v.length === 0 || PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

const secret = (minLength = 1) =>
  z
    .string()
    .min(minLength, `must be at least ${minLength} characters`)
    .refine((v) => !isPlaceholder(v), "is a placeholder value; set a real secret");

const url = () =>
  z
    .string()
    .refine((v) => !isPlaceholder(v), "is a placeholder value")
    .pipe(z.url());

const postgresUrl = () =>
  url().refine((v) => /^postgres(?:ql)?:\/\//.test(v), "must be a postgres:// URL");

/** 32 random bytes, base64-encoded (libsodium secretbox key size). */
const encryptionKey = () =>
  secret().refine((v) => {
    try {
      return Buffer.from(v, "base64").length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
    } catch {
      return false;
    }
  }, "must be 32 bytes encoded as base64 (generate with: openssl rand -base64 32)");

const pemKey = () =>
  secret()
    .transform((v) => v.replace(/\\n/g, "\n"))
    .refine((v) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v), "must be a PEM private key");

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: postgresUrl(),
  SESSION_SECRET: secret(32),
  ENCRYPTION_KEY: encryptionKey(),
  S3_ENDPOINT: url(),
  S3_BUCKET: secret(3),
  S3_ACCESS_KEY_ID: secret(3),
  S3_SECRET_ACCESS_KEY: secret(8),
  ANTHROPIC_API_KEY: secret(10),
  ANTHROPIC_MODEL: secret(1),
  GITHUB_OAUTH_CLIENT_ID: secret(1),
  GITHUB_OAUTH_CLIENT_SECRET: secret(10),
  GITHUB_APP_ID: z.string().regex(/^\d+$/, "must be the numeric GitHub App id"),
  GITHUB_APP_PRIVATE_KEY: pemKey(),
  GITHUB_WEBHOOK_SECRET: secret(16),
  EMAIL_FROM: z.email(),
  EMAIL_PROVIDER_API_KEY: secret(8),
  SLACK_CLIENT_ID: secret(1),
  SLACK_CLIENT_SECRET: secret(8),
  PUBLIC_APP_URL: url(),
  SANDBOX_RUNTIME: z.enum(["runsc", "runc"]),
  SENTRY_DSN: url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof Env;

const ALWAYS: EnvKey[] = ["NODE_ENV", "SENTRY_DSN", "OTEL_EXPORTER_OTLP_ENDPOINT"];

/**
 * Variables each service needs. A service validates exactly these at startup, so a
 * scan worker does not need Slack credentials (ADR 0003). The union covers every
 * variable in `.env.example`.
 */
export const SERVICE_ENV = {
  api: [
    "DATABASE_URL",
    "SESSION_SECRET",
    "ENCRYPTION_KEY",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "EMAIL_FROM",
    "EMAIL_PROVIDER_API_KEY",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "PUBLIC_APP_URL",
  ],
  web: ["PUBLIC_APP_URL", "SESSION_SECRET"],
  "worker-scan": [
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "SANDBOX_RUNTIME",
  ],
  "worker-pulse": [
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ],
  "worker-link": [
    "DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "EMAIL_FROM",
    "EMAIL_PROVIDER_API_KEY",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "PUBLIC_APP_URL",
  ],
} as const satisfies Record<string, readonly EnvKey[]>;

export type Service = keyof typeof SERVICE_ENV;
export type ServiceEnv<S extends Service> = Pick<
  Env,
  (typeof SERVICE_ENV)[S][number] | (typeof ALWAYS)[number]
>;

export class ConfigError extends Error {
  constructor(
    readonly service: string,
    readonly problems: { key: string; message: string }[],
  ) {
    super(
      `Invalid configuration for ${service}:\n${problems.map((p) => `  - ${p.key}: ${p.message}`).join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

/**
 * Validates the variables a service needs. Throws ConfigError listing every
 * problem at once; never substitutes defaults for secrets. Values are never
 * included in error messages.
 */
export function loadConfig<S extends Service>(
  service: S,
  env: Record<string, string | undefined> = process.env,
): ServiceEnv<S> {
  const keys = [...SERVICE_ENV[service], ...ALWAYS];
  const mask = Object.fromEntries(keys.map((k) => [k, true])) as { [K in EnvKey]?: true };
  const schema = EnvSchema.pick(mask);
  const input = Object.fromEntries(
    keys.map((k) => {
      const v = env[k];
      return [k, v === "" ? undefined : v];
    }),
  );
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => ({
      key: String(i.path[0] ?? "(root)"),
      message: i.code === "invalid_type" && i.input === undefined ? "is required" : i.message,
    }));
    throw new ConfigError(service, problems);
  }
  return parsed.data as ServiceEnv<S>;
}

/** Every variable name, for `.env.example` drift checks. */
export const ALL_ENV_KEYS = Object.keys(EnvSchema.shape) as EnvKey[];
