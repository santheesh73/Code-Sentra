import type { PlatformIdentity } from "../types.js";

export type Headers = Record<string, string>;

export interface PlatformAdapter {
  name: Exclude<PlatformIdentity["name"], "unknown">;
  /** True when this platform served the response. */
  detect(url: URL, headers: Headers): boolean;
  environment(
    url: URL,
    headers: Headers,
  ): { environment: PlatformIdentity["environment"]; reason: string };
  /** True when the response is the platform's own authentication wall. */
  isAccessProtected(status: number, headers: Headers, finalUrl: URL): boolean;
  /** Where, on this platform, a user changes the thing a config_fix prompt names. */
  configHint(
    topic: "env_var" | "access_protection" | "production_domain" | "redirects" | "headers",
  ): string;
}

const host = (u: URL) => u.hostname.toLowerCase();
const has = (h: Headers, name: string) => name in h;
const serverIs = (h: Headers, re: RegExp) => re.test(h.server ?? "");

export const vercel: PlatformAdapter = {
  name: "vercel",
  detect: (u, h) =>
    has(h, "x-vercel-id") || serverIs(h, /^vercel/i) || host(u).endsWith(".vercel.app"),
  environment(u) {
    const hn = host(u);
    if (!hn.endsWith(".vercel.app"))
      return {
        environment: "unknown",
        reason: "custom domain; Vercel does not expose the deployment target in headers",
      };
    // <project>-<hash>-<scope>.vercel.app and <project>-git-<branch>-<scope>.vercel.app are deployment URLs.
    if (
      /-git-[a-z0-9-]+\.vercel\.app$/.test(hn) ||
      /-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/.test(hn)
    ) {
      return { environment: "preview", reason: "per-deployment or branch vercel.app URL" };
    }
    return { environment: "production", reason: "project vercel.app domain" };
  },
  isAccessProtected: (status, h, final) =>
    ((status === 401 || status === 403) && (has(h, "x-vercel-id") || serverIs(h, /^vercel/i))) ||
    (host(final) === "vercel.com" && final.pathname.startsWith("/sso-api")),
  configHint: (topic) =>
    ({
      env_var:
        "Vercel → Project → Settings → Environment Variables; set it for the Production (and Preview) environment, then redeploy (NEXT_PUBLIC_* values are inlined at build time).",
      access_protection:
        "Vercel → Project → Settings → Deployment Protection: disable it for this environment, or add a Protection Bypass for Automation secret and register it on the CodeSentra environment.",
      production_domain:
        "Vercel → Project → Settings → Domains: point the production domain at the Production deployment (Promote to Production).",
      redirects:
        "Check `redirects` in vercel.json / next.config and Vercel → Project → Settings → Domains redirects.",
      headers: "Add the header in `headers` of vercel.json or next.config.",
    })[topic],
};

export const netlify: PlatformAdapter = {
  name: "netlify",
  detect: (u, h) =>
    has(h, "x-nf-request-id") || serverIs(h, /^netlify/i) || host(u).endsWith(".netlify.app"),
  environment(u) {
    const hn = host(u);
    if (/^deploy-preview-\d+--/.test(hn))
      return { environment: "preview", reason: "deploy-preview URL" };
    if (/^[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/.test(hn))
      return { environment: "preview", reason: "branch or deploy URL (name--site)" };
    if (hn.endsWith(".netlify.app"))
      return { environment: "production", reason: "site netlify.app domain" };
    return { environment: "unknown", reason: "custom domain" };
  },
  isAccessProtected: (status, h) =>
    status === 401 && (has(h, "x-nf-request-id") || serverIs(h, /^netlify/i)),
  configHint: (topic) =>
    ({
      env_var:
        "Netlify → Site configuration → Environment variables; set the variable for the production context, then trigger a new deploy.",
      access_protection:
        "Netlify → Site configuration → Access & security → Visitor access: remove password/SSO protection for this context.",
      production_domain:
        "Netlify → Domain management: make sure the production domain serves the published deploy, not a branch deploy.",
      redirects: "Check `_redirects` / `[[redirects]]` in netlify.toml.",
      headers: "Add the header in `_headers` or `[[headers]]` in netlify.toml.",
    })[topic],
};

export const render: PlatformAdapter = {
  name: "render",
  detect: (u, h) =>
    has(h, "rndr-id") || has(h, "x-render-origin-server") || host(u).endsWith(".onrender.com"),
  environment(u) {
    const hn = host(u);
    if (/-pr-\d+\.onrender\.com$/.test(hn))
      return { environment: "preview", reason: "pull-request preview URL" };
    if (hn.endsWith(".onrender.com"))
      return { environment: "production", reason: "service onrender.com domain" };
    return { environment: "unknown", reason: "custom domain" };
  },
  isAccessProtected: () => false,
  configHint: (topic) =>
    ({
      env_var:
        "Render → Service → Environment: add the variable, then Manual Deploy → Deploy latest commit (build-time variables need a rebuild).",
      access_protection:
        "Render does not add an access wall; check the application's own authentication.",
      production_domain: "Render → Service → Settings → Custom Domains.",
      redirects: "Render → Static Site → Redirects/Rewrites, or the application's router.",
      headers: "Render → Static Site → Headers, or set the header in the application.",
    })[topic],
};

export const cloudflarePages: PlatformAdapter = {
  name: "cloudflare-pages",
  // Cloudflare's cf-ray header is on every Cloudflare-proxied site, so only the pages.dev
  // host identifies Pages itself; custom domains on Pages fall through to generic.
  detect: (u) => host(u).endsWith(".pages.dev"),
  environment(u) {
    const hn = host(u);
    // <hash|branch>.<project>.pages.dev is a deployment/branch alias; <project>.pages.dev is production.
    if (/^[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev$/.test(hn))
      return { environment: "preview", reason: "deployment or branch alias on pages.dev" };
    if (hn.endsWith(".pages.dev"))
      return { environment: "production", reason: "project pages.dev domain" };
    return { environment: "unknown", reason: "custom domain" };
  },
  isAccessProtected: (status, h, final) =>
    host(final).endsWith(".cloudflareaccess.com") ||
    ((status === 401 || status === 403) && has(h, "cf-access-domain")),
  configHint: (topic) =>
    ({
      env_var:
        "Cloudflare → Workers & Pages → project → Settings → Variables and Secrets (Production), then retry the deployment.",
      access_protection:
        "Cloudflare Zero Trust → Access → Applications: remove or adjust the policy covering this hostname.",
      production_domain:
        "Cloudflare → Workers & Pages → project → Custom domains; production serves the production branch.",
      redirects: "Check `_redirects` in the build output and Cloudflare redirect rules.",
      headers: "Add the header in `_headers` in the build output, or a Transform Rule.",
    })[topic],
};

export const fly: PlatformAdapter = {
  name: "fly",
  detect: (u, h) =>
    has(h, "fly-request-id") || serverIs(h, /^fly\//i) || host(u).endsWith(".fly.dev"),
  environment(u) {
    return host(u).endsWith(".fly.dev")
      ? {
          environment: "production",
          reason: "app fly.dev domain (Fly has no preview URLs by default)",
        }
      : { environment: "unknown", reason: "custom domain" };
  },
  isAccessProtected: () => false,
  configHint: (topic) =>
    ({
      env_var:
        "Set it with `fly secrets set NAME=…` (runtime) or `[build.args]` in fly.toml (build time), then `fly deploy`.",
      access_protection:
        "Fly does not add an access wall; check the application's own authentication.",
      production_domain: "`fly certs list` / Fly dashboard → Certificates for the custom domain.",
      redirects: "Check the application's router and `[http_service]` in fly.toml.",
      headers: "Set the header in the application.",
    })[topic],
};

export const generic: PlatformAdapter = {
  name: "generic",
  detect: () => true,
  environment: () => ({ environment: "unknown", reason: "hosting platform not recognised" }),
  isAccessProtected: (status, h) =>
    status === 401 && /basic|bearer|digest/i.test(h["www-authenticate"] ?? ""),
  configHint: (topic) =>
    ({
      env_var:
        "Set the variable in your hosting provider's environment settings for production, then rebuild and redeploy.",
      access_protection:
        "Remove the HTTP authentication in front of this deployment, or give CodeSentra a bypass token.",
      production_domain:
        "Check which deployment your production domain points to in your DNS / hosting provider.",
      redirects: "Check redirect rules in your web server, CDN and application router.",
      headers: "Set the header in your web server, CDN or application.",
    })[topic],
};

export const ADAPTERS: readonly PlatformAdapter[] = [
  vercel,
  netlify,
  cloudflarePages,
  render,
  fly,
  generic,
];

export function detectPlatform(
  url: URL,
  headers: Headers,
): { adapter: PlatformAdapter; identity: PlatformIdentity } {
  const adapter = ADAPTERS.find((a) => a.detect(url, headers)) ?? generic;
  const env = adapter.environment(url, headers);
  return {
    adapter,
    identity: { name: adapter.name, environment: env.environment, reason: env.reason },
  };
}

export function adapterByName(name: string | null | undefined): PlatformAdapter {
  return ADAPTERS.find((a) => a.name === name) ?? generic;
}
