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

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: postgresUrl(),
  SESSION_SECRET: secret(32),
  ENCRYPTION_KEY: encryptionKey(),
  PUBLIC_APP_URL: url(),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: port(4000),
  API_INTERNAL_URL: url().default("http://127.0.0.1:4000"),
  S3_ENDPOINT: url(),
  S3_BUCKET: secret(3),
  S3_ACCESS_KEY_ID: secret(3),
  S3_SECRET_ACCESS_KEY: secret(8),
  ANTHROPIC_API_KEY: secret(10),
  ANTHROPIC_MODEL: secret(1),
  GITHUB_OAUTH_CLIENT_ID: secret(1),
  GITHUB_OAUTH_CLIENT_SECRET: secret(10),
  GITHUB_OAUTH_BASE_URL: url().default("https://github.com"),
  GITHUB_API_BASE_URL: url().default("https://api.github.com"),
  /** Where worker-scan clones repositories from (`<base>/<owner>/<repo>.git`). */
  GITHUB_GIT_BASE_URL: url().default("https://github.com"),
  /** Slack OAuth (oauth.v2.access); tests point it at a local fake. */
  SLACK_API_BASE_URL: url().default("https://slack.com"),
  /** The App's URL name (github.com/apps/<slug>), for the install link in Settings. */
  GITHUB_APP_SLUG: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  GITHUB_APP_ID: z.string().regex(/^\d+$/, "must be the numeric GitHub App id"),
  /** The App's own OAuth client (not the sign-in OAuth app): proves who installed it. */
  GITHUB_APP_CLIENT_ID: secret(1),
  GITHUB_APP_CLIENT_SECRET: secret(8),
  GITHUB_APP_PRIVATE_KEY: pemKey(),
  GITHUB_WEBHOOK_SECRET: secret(16),
  EMAIL_TRANSPORT: z.enum(["resend", "outbox"]).default("resend"),
  EMAIL_OUTBOX_DIR: z.string().min(1).default(".outbox"),
  EMAIL_FROM: z.email(),
  EMAIL_PROVIDER_API_KEY: secret(8),
  SLACK_CLIENT_ID: secret(1),
  SLACK_CLIENT_SECRET: secret(8),
  SANDBOX_RUNTIME: z.enum(["runsc", "runc"]),
  /** Image the probes run in (infra/sandbox). */
  SANDBOX_IMAGE: z.string().min(1).default("codesentra/sandbox:latest"),
  /** Docker network for dependency downloads only (ADR 0016); "host" where egress needs a host proxy. */
  SANDBOX_FETCH_NETWORK: z.string().min(1).default("bridge"),
  SANDBOX_FETCH_PROXY: url().optional(),
  SANDBOX_FETCH_CA_FILE: z.string().optional(),
  /** Directory with an OSV dump (osv-scanner offline format); unset uses the OSV API. */
  OSV_OFFLINE_DIR: z.string().optional(),
  SCAN_MAX_COMMITS: z.coerce.number().int().min(1).max(50_000).default(2000),
  /** How often worker-link looks for due schedules (Section 6 `schedules`); 0 turns it off. */
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  /** Largest accepted zip upload (compressed), bytes. */
  SCAN_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(200 * 1024 * 1024),
  /** Test only: "fixture" uses the scripted fixture-repo model instead of Anthropic (ADR 0017). */
  SCAN_TEST_MODEL: z.enum(["fixture"]).optional(),
  PULSE_SLOW_THRESHOLD_MS: z.coerce.number().int().min(100).max(60_000).default(3000),
  /** Test only (fixture harness on loopback): comma-separated hosts exempt from the SSRF address check. */
  PULSE_TEST_ALLOW_HOSTS: z.string().optional(),
  /** Test only: PEM file of the fixture harness's throwaway CA. */
  PULSE_TEST_CA_FILE: z.string().optional(),
  SENTRY_DSN: url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof Env;

/**
 * External integrations. In production every integration a service declares is
 * required. Elsewhere an integration may be entirely absent: it is then reported as
 * disabled and the feature it powers answers 501 "not configured" (ADR 0007). A
 * partially configured integration is always an error.
 */
export const INTEGRATIONS = {
  s3: ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
  github_oauth: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
  github_app: [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
  ],
  email: ["EMAIL_FROM", "EMAIL_PROVIDER_API_KEY"],
  slack: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
} as const satisfies Record<string, readonly EnvKey[]>;
export type Integration = keyof typeof INTEGRATIONS;

/** Non-secret settings with safe defaults; validated when present. */
const ALWAYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "SENTRY_DSN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const satisfies readonly EnvKey[];

interface ServiceSpec {
  required: readonly EnvKey[];
  settings: readonly EnvKey[];
  integrations: readonly Integration[];
}

/**
 * What each service validates at startup (ADR 0003). A scan worker never sees Slack
 * credentials; a Pulse worker never sees the Anthropic key.
 */
export const SERVICE_ENV = {
  api: {
    required: ["DATABASE_URL", "SESSION_SECRET", "ENCRYPTION_KEY", "PUBLIC_APP_URL"],
    settings: [
      "API_HOST",
      "API_PORT",
      "GITHUB_OAUTH_BASE_URL",
      "GITHUB_API_BASE_URL",
      "GITHUB_APP_SLUG",
      "SLACK_API_BASE_URL",
      "EMAIL_TRANSPORT",
      "EMAIL_OUTBOX_DIR",
      "PULSE_TEST_ALLOW_HOSTS",
      "SCAN_MAX_UPLOAD_BYTES",
    ],
    integrations: ["s3", "github_oauth", "github_app", "email", "slack"],
  },
  web: {
    required: ["PUBLIC_APP_URL"],
    settings: ["API_INTERNAL_URL"],
    integrations: [],
  },
  "worker-scan": {
    required: ["DATABASE_URL", "ENCRYPTION_KEY", "SANDBOX_RUNTIME"],
    settings: [
      "SANDBOX_IMAGE",
      "SANDBOX_FETCH_NETWORK",
      "SANDBOX_FETCH_PROXY",
      "SANDBOX_FETCH_CA_FILE",
      "OSV_OFFLINE_DIR",
      "SCAN_MAX_COMMITS",
      "SCAN_TEST_MODEL",
      "PULSE_TEST_ALLOW_HOSTS",
      "GITHUB_API_BASE_URL",
      "GITHUB_GIT_BASE_URL",
      "SCAN_MAX_UPLOAD_BYTES",
    ],
    integrations: ["s3", "github_app", "anthropic"],
  },
  "worker-pulse": {
    required: ["DATABASE_URL", "ENCRYPTION_KEY"],
    settings: ["PULSE_SLOW_THRESHOLD_MS", "PULSE_TEST_ALLOW_HOSTS", "PULSE_TEST_CA_FILE"],
    integrations: ["s3"],
  },
  "worker-link": {
    required: ["DATABASE_URL", "PUBLIC_APP_URL", "ENCRYPTION_KEY"],
    settings: [
      "EMAIL_TRANSPORT",
      "EMAIL_OUTBOX_DIR",
      "GITHUB_API_BASE_URL",
      "PULSE_TEST_ALLOW_HOSTS",
      "SCHEDULER_INTERVAL_SECONDS",
    ],
    integrations: ["anthropic", "github_app", "email", "slack"],
  },
} as const satisfies Record<string, ServiceSpec>;

export type Service = keyof typeof SERVICE_ENV;

type IntegrationKeysOf<S extends Service> =
  (typeof INTEGRATIONS)[(typeof SERVICE_ENV)[S]["integrations"][number]][number];

export type ServiceEnv<S extends Service> = Pick<
  Env,
  | (typeof SERVICE_ENV)[S]["required"][number]
  | (typeof SERVICE_ENV)[S]["settings"][number]
  | (typeof ALWAYS)[number]
> &
  Partial<Pick<Env, IntegrationKeysOf<S>>> & {
    /** Which declared integrations are configured. Undeclared ones are always false. */
    integrations: Record<Integration, boolean>;
  };

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

const present = (env: Record<string, string | undefined>, k: string) =>
  env[k] !== undefined && env[k] !== "";

/**
 * Validates the variables a service needs. Throws ConfigError listing every problem
 * at once; never substitutes defaults for secrets; never includes values in errors.
 */
export function loadConfig<S extends Service>(
  service: S,
  env: Record<string, string | undefined> = process.env,
): ServiceEnv<S> {
  const spec: ServiceSpec = SERVICE_ENV[service];
  const production = env.NODE_ENV === "production";
  const problems: { key: string; message: string }[] = [];
  const integrations = Object.fromEntries(
    Object.keys(INTEGRATIONS).map((k) => [k, false]),
  ) as Record<Integration, boolean>;

  const keys = new Set<EnvKey>([...spec.required, ...spec.settings, ...ALWAYS]);
  for (const k of ["PULSE_TEST_ALLOW_HOSTS", "PULSE_TEST_CA_FILE"] as const) {
    if (present(env, k) && env.NODE_ENV !== "test") {
      problems.push({
        key: k,
        message: "is only allowed when NODE_ENV=test (it weakens SSRF protection)",
      });
    }
  }
  if (present(env, "SCAN_TEST_MODEL") && env.NODE_ENV !== "test") {
    problems.push({
      key: "SCAN_TEST_MODEL",
      message:
        "is only allowed when NODE_ENV=test (it replaces the report model with a scripted one)",
    });
  }
  const outbox = env.EMAIL_TRANSPORT === "outbox";
  if (production && outbox && spec.settings.includes("EMAIL_TRANSPORT")) {
    problems.push({ key: "EMAIL_TRANSPORT", message: "outbox is not allowed in production" });
  }

  for (const name of spec.integrations) {
    const groupKeys: readonly EnvKey[] = INTEGRATIONS[name];
    // The outbox transport needs no provider key; email is then "configured" locally.
    if (name === "email" && outbox && !production) {
      integrations.email = true;
      if (present(env, "EMAIL_FROM")) keys.add("EMAIL_FROM");
      continue;
    }
    const set = groupKeys.filter((k) => present(env, k));
    if (production || set.length > 0) {
      for (const k of groupKeys) keys.add(k);
      integrations[name] = true;
      if (!production && set.length < groupKeys.length) {
        const missing = groupKeys.filter((k) => !present(env, k));
        for (const k of missing) {
          problems.push({
            key: k,
            message: `is required because ${name} is partially configured (set all of ${groupKeys.join(", ")} or none)`,
          });
        }
      }
    }
  }

  const mask = Object.fromEntries([...keys].map((k) => [k, true])) as { [K in EnvKey]?: true };
  const schema = EnvSchema.pick(mask);
  const input = Object.fromEntries(
    [...keys].map((k) => {
      const v = env[k];
      return [k, v === "" ? undefined : v];
    }),
  );
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const key = String(i.path[0] ?? "(root)");
      if (problems.some((p) => p.key === key)) continue;
      problems.push({
        key,
        message: i.code === "invalid_type" && i.input === undefined ? "is required" : i.message,
      });
    }
  }
  if (problems.length > 0) throw new ConfigError(service, problems);
  return { ...(parsed.data as object), integrations } as ServiceEnv<S>;
}

/** Every variable name, for `.env.example` drift checks. */
export const ALL_ENV_KEYS = Object.keys(EnvSchema.shape) as EnvKey[];
