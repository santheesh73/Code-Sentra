// GitHub App manifest + env verification for CodeSentra (Section 16).
//
// The manifest flow lets GitHub create the App with the exact permissions, events and URLs
// CodeSentra needs, so an operator does not hand-configure a dozen checkboxes. buildManifest()
// renders that manifest from one base URL; verifyAppEnv() checks a configured environment
// against the same contract the server enforces (packages/config). Both are pure so the CLI
// (setup.mjs) and its --self-test can share them.

/**
 * The least-privilege permissions and the webhook events the API actually consumes
 * (packages/github/src/webhooks.ts): installation, installation_repositories, pull_request,
 * deployment_status, push.
 */
export const APP_PERMISSIONS = {
  contents: "read",
  checks: "write",
  pull_requests: "read",
  deployments: "read",
  metadata: "read",
};

export const APP_EVENTS = [
  "installation",
  "installation_repositories",
  "pull_request",
  "deployment_status",
  "push",
];

/** The env vars the API requires for the github_app integration (packages/config). */
export const REQUIRED_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
];

function normalizeBase(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`--base-url is not a URL: ${baseUrl}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost"))
    throw new Error(`--base-url must be https (or http://localhost for dev): ${baseUrl}`);
  return u.origin;
}

/**
 * Builds the GitHub App manifest. `baseUrl` is the public origin of the API (e.g.
 * https://app.example.com); webhook, setup and callback URLs are derived from it and must
 * match the API's routes exactly.
 */
export function buildManifest({ name = "CodeSentra", baseUrl }) {
  const origin = normalizeBase(baseUrl);
  return {
    name,
    url: origin,
    hook_attributes: { url: `${origin}/v1/webhooks/github`, active: true },
    redirect_url: `${origin}/v1/github/setup`,
    callback_urls: [`${origin}/v1/github/setup`],
    setup_url: `${origin}/v1/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

/**
 * Verifies a configured environment against the github_app contract. Returns
 * { ok, problems: string[] } — problems is empty when the env is complete and well-formed.
 * Mirrors the shape checks in packages/config (numeric id, PEM key, secret lengths) without
 * importing the server, so it runs standalone during setup.
 */
export function verifyAppEnv(env) {
  const problems = [];
  const need = (k) => {
    if (!env[k] || !String(env[k]).trim()) problems.push(`${k} is missing`);
    return env[k];
  };

  const id = need("GITHUB_APP_ID");
  if (id && !/^\d+$/.test(String(id))) problems.push("GITHUB_APP_ID must be the numeric App id");

  const pem = need("GITHUB_APP_PRIVATE_KEY");
  // packages/config un-escapes \n before checking; mirror that here.
  if (pem && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(pem).replace(/\\n/g, "\n")))
    problems.push("GITHUB_APP_PRIVATE_KEY must be a PEM private key");

  const hook = need("GITHUB_WEBHOOK_SECRET");
  if (hook && String(hook).length < 16)
    problems.push("GITHUB_WEBHOOK_SECRET must be at least 16 characters");

  need("GITHUB_APP_CLIENT_ID");
  const cs = need("GITHUB_APP_CLIENT_SECRET");
  if (cs && String(cs).length < 8)
    problems.push("GITHUB_APP_CLIENT_SECRET must be at least 8 characters");

  const slug = need("GITHUB_APP_SLUG");
  if (slug && !/^[a-z0-9-]+$/.test(String(slug)))
    problems.push(
      "GITHUB_APP_SLUG must be the App's URL slug (lowercase letters, digits, hyphens)",
    );

  return { ok: problems.length === 0, problems };
}
