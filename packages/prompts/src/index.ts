import {
  FINDING_CODE_DECLARATIONS,
  type FindingCode,
  type JsonObject,
  type PromptType,
  promptTypeFor,
  recheckFor,
  type Severity,
} from "@codesentra/core";

/** Bump a template's version whenever its wording or structure changes. */
export const TEMPLATE_VERSIONS: Record<PromptType, string> = {
  outage_triage: "outage_triage@1",
  config_fix: "config_fix@1",
  investigate: "investigate@1",
  code_fix: "code_fix@0",
};

export type HintTopic =
  | "env_var"
  | "access_protection"
  | "production_domain"
  | "redirects"
  | "headers";

export interface PromptEvidence {
  kind: string;
  locator: string;
  payload: JsonObject;
}

export interface PromptContext {
  code: FindingCode;
  title: string;
  severity: Severity;
  locator: string;
  message: string;
  /** Header name, console text… */
  discriminator?: string | null;
  corroborating: { code: FindingCode; message: string }[];
  evidence: PromptEvidence[];
  hasVerifiedTrace: boolean;
  platform: { name: string; environment: string; reason: string } | null;
  /** Where to change things on the detected platform (adapter configHint). */
  hints: Record<HintTopic, string>;
  target: { url: string; environment: string | null };
  project: { name: string; repoUrl: string | null } | null;
  lastSuccessfulCheck: string | null;
  /** Summary of the latest Scan's build/test results; null until Scan exists. */
  scanSummary: string | null;
}

export interface RenderedPrompt {
  type: PromptType;
  body: string;
  templateVersion: string;
}

const bullet = (lines: (string | null | undefined | false)[]) =>
  lines
    .filter((l): l is string => Boolean(l))
    .map((l) => `- ${l}`)
    .join("\n");

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function targetLine(ctx: PromptContext): string {
  const env = ctx.target.environment ? `${ctx.target.environment} — ` : "";
  const platform =
    ctx.platform && ctx.platform.name !== "generic" ? ` (hosted on ${ctx.platform.name})` : "";
  return `${env}${ctx.target.url}${platform}`;
}

function fixedWhen(ctx: PromptContext): string {
  const r = recheckFor(ctx.code, ctx.locator, ctx.target.url);
  return `## How CodeSentra will confirm the fix\nOn every later check of ${ctx.target.url}, CodeSentra re-runs its **${r.check_group}** checks and expects: _${r.expectation}_. When that holds, this issue closes on its own; if it comes back later, the issue reopens as regressed.`;
}

function corroboration(ctx: PromptContext): string | null {
  if (ctx.corroborating.length === 0) return null;
  return `Also observed in the same evidence: ${ctx.corroborating.map((c) => `\`${c.code}\` (${c.message})`).join("; ")}`;
}

/** Turns stored evidence into plain observation lines. Only facts that were recorded. */
function observations(ctx: PromptContext): string[] {
  const out: string[] = [];
  for (const e of ctx.evidence) {
    const p = e.payload;
    switch (e.kind) {
      case "http_response": {
        if (str(p.error))
          out.push(
            `Request to ${str(p.url) ?? e.locator} failed: ${str(p.error)} — ${str(p.message) ?? ""}`.trim(),
          );
        else if (num(p.status) !== null && str(p.url))
          out.push(
            `${str(p.url)} answered HTTP ${num(p.status)}${num(p.ttfb_ms) !== null ? ` (first byte after ${num(p.ttfb_ms)} ms)` : ""}`,
          );
        const tls = p.tls as JsonObject | undefined;
        if (tls && typeof tls === "object") {
          out.push(
            `TLS certificate rejected: ${str(tls.error) ?? "unknown reason"}${str(tls.subject) ? `; subject ${str(tls.subject)}` : ""}${str(tls.issuer) ? `, issuer ${str(tls.issuer)}` : ""}${str(tls.valid_to) ? `, valid until ${str(tls.valid_to)}` : ""}`,
          );
        }
        const hops = Array.isArray(p.hops) ? (p.hops as JsonObject[]) : [];
        if (hops.length > 0)
          out.push(
            `Redirect chain before the failure: ${hops.map((h) => `${str(h.url)} → ${num(h.status)}`).join(", ")}`,
          );
        break;
      }
      case "redirect_chain": {
        const hops = Array.isArray(p.hops) ? (p.hops as JsonObject[]) : [];
        if (hops.length > 1)
          out.push(
            `Redirect chain (${hops.length - 1} redirects): ${hops.map((h) => `${str(h.url)} → ${num(h.status)}`).join(" ⇒ ")}`,
          );
        break;
      }
      case "tls_certificate":
        out.push(
          `TLS certificate for ${e.locator}: subject ${str(p.subject) ?? "?"}, issuer ${str(p.issuer) ?? "?"}, valid until ${str(p.valid_to) ?? "?"} (${num(p.days_remaining) ?? "?"} days left)`,
        );
        break;
      case "browser_request":
        out.push(
          `The page ${str(p.page) ?? ""} made ${str(p.method) ?? "GET"} ${str(p.url)}${num(p.status) !== null ? ` → HTTP ${num(p.status)}` : ""}${str(p.not_sent) ? ` (not sent by CodeSentra: ${str(p.not_sent)})` : ""}${str(p.error) ? ` (failed: ${str(p.error)})` : ""}`.replace(
            /\s+/g,
            " ",
          ),
        );
        break;
      case "page_error":
        out.push(`Uncaught exception on ${str(p.page) ?? e.locator}: \`${str(p.message)}\``);
        break;
      case "console_message":
        out.push(`Console error on ${str(p.page) ?? e.locator}: \`${str(p.text)}\``);
        break;
      case "render_summary":
        out.push(
          `Rendered page ${e.locator}: ${num(p.text_length)} characters of visible text, ${num(p.media_elements)} media elements, ${num(p.requests)} requests`,
        );
        break;
      case "platform_identity":
        out.push(
          `Platform: ${str(p.platform)}, deployment looks like **${str(p.environment)}** (${str(p.reason)})${str(p.expected_environment) ? `; registered in CodeSentra as ${str(p.expected_environment)}` : ""}`,
        );
        break;
      case "security_headers": {
        const present = (p.present ?? {}) as JsonObject;
        out.push(
          `Security headers on ${str(p.url)}: ${Object.entries(present)
            .filter(([, v]) => v !== null)
            .map(([k, v]) => `${k} ${v ? "present" : "missing"}`)
            .join(", ")}`,
        );
        break;
      }
      default:
        break;
    }
  }
  return [...new Set(out)];
}

// --- outage_triage ----------------------------------------------------------------

const OUTAGE_STEP: Partial<Record<FindingCode, number>> = {
  BUILD_FAILED: 1,
  SERVER_ERROR: 4,
  DOWN: 0,
  TIMEOUT: 4,
  DNS_FAILURE: 2,
  TLS_INVALID: 3,
  TLS_EXPIRING: 3,
  BAD_STATUS: 0,
};

function outageTriage(ctx: PromptContext): string {
  const steps = [
    `**Deploy logs** — did the latest deployment succeed and is it the one serving traffic? (${ctx.platform?.name ?? "your host"}'s deployments page)`,
    "**Build output** — look for a failed or skipped build step, missing build-time variables, or a different output directory than the server expects.",
    `**DNS records** — \`dig +short ${hostOf(ctx.target.url)}\` should return your host's addresses; check A/AAAA/CNAME at the DNS provider and that the domain has not expired.`,
    `**Certificate** — \`openssl s_client -connect ${hostOf(ctx.target.url)}:443 -servername ${hostOf(ctx.target.url)} </dev/null | openssl x509 -noout -subject -issuer -dates\`; renew or re-issue if expired, for the wrong host, or from an untrusted issuer.`,
    "**Runtime logs** — look for crashes, unhandled errors, exhausted memory, or failing dependencies (database, upstream APIs) at the time of the check.",
  ];
  const startAt = OUTAGE_STEP[ctx.code] ?? 0;
  return [
    `# Outage triage: ${ctx.title}`,
    "",
    "## What CodeSentra observed",
    bullet([
      `Target: ${targetLine(ctx)}`,
      ctx.message,
      ...observations(ctx),
      corroboration(ctx),
      `Last successful check of this target: ${ctx.lastSuccessfulCheck ?? "none recorded"}`,
      ctx.scanSummary ??
        "No Scan has run for this project yet, so build and test results are not available to correlate.",
    ]),
    "",
    "## Checklist (in this order)",
    steps
      .map((s, i) => `${i + 1}. ${s}${i === startAt ? " ← the observation points here first" : ""}`)
      .join("\n"),
    "",
    "Confirm the cause from logs or settings before changing anything, and report back what you found if it does not match the observation above.",
    "",
    fixedWhen(ctx),
  ].join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// --- config_fix ------------------------------------------------------------------

const HEADER_SHAPES: Record<string, string> = {
  "Content-Security-Policy":
    "a policy listing the origins your pages load from, e.g. `default-src 'self'; script-src 'self'; frame-ancestors 'none'` (start with Content-Security-Policy-Report-Only to avoid breaking the site)",
  "X-Content-Type-Options: nosniff": "`X-Content-Type-Options: nosniff`",
  "X-Frame-Options or CSP frame-ancestors":
    "`X-Frame-Options: DENY` (or `SAMEORIGIN`), or `frame-ancestors 'none'` in the CSP",
  "Strict-Transport-Security":
    "`Strict-Transport-Security: max-age=63072000; includeSubDomains` (add `preload` only once every subdomain serves HTTPS)",
};

function configFix(ctx: PromptContext): string {
  let setting: string;
  let where: string;
  let shape: string;
  switch (ctx.code) {
    case "ACCESS_PROTECTED":
      setting = "Deployment access protection for this environment";
      where = ctx.hints.access_protection;
      shape =
        "Either the environment is public, or CodeSentra has a bypass token (stored encrypted; add it on the environment in CodeSentra). Never paste the token into a prompt or a commit.";
      break;
    case "PREVIEW_SERVED_AS_PROD":
      setting = "Which deployment the production URL points to";
      where = ctx.hints.production_domain;
      shape = "The production domain serves the production deployment of the default branch.";
      break;
    case "REDIRECT_LOOP":
    case "LONG_REDIRECT_CHAIN":
      setting = "Redirect rules (HTTP→HTTPS, apex↔www, trailing slash, locale)";
      where = ctx.hints.redirects;
      shape =
        "Each URL reaches its final page in at most one or two redirects, and no rule sends a URL back to an earlier one.";
      break;
    case "MISSING_SECURITY_HEADER": {
      const header = ctx.discriminator ?? "the header";
      setting = `Response header ${header}`;
      where = ctx.hints.headers;
      shape = HEADER_SHAPES[header] ?? "a value appropriate for your site";
      break;
    }
    default:
      setting = "The platform setting named in the observation";
      where = ctx.hints.env_var;
      shape = "As described by your platform's documentation.";
  }
  return [
    `# Configuration fix: ${ctx.title}`,
    "",
    "## What CodeSentra observed",
    bullet([`Target: ${targetLine(ctx)}`, ctx.message, ...observations(ctx), corroboration(ctx)]),
    "",
    "## What to change",
    bullet([
      `**Setting:** ${setting}`,
      `**Where:** ${where}`,
      `**Expected value (shape, never a secret):** ${shape}`,
    ]),
    "",
    "## Then redeploy",
    "Apply the change, redeploy (build-time settings only take effect in a new build), and confirm the setting on the deployed URL. Confirm the cause before editing; report back if what you find does not match the observation.",
    "",
    fixedWhen(ctx),
  ].join("\n");
}

// --- investigate -----------------------------------------------------------------

function quote(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim().slice(0, max);
  return `\`${t.replace(/`/g, "'")}\``;
}

function searches(ctx: PromptContext): { terms: string[]; notes: string[] } {
  const terms: string[] = [];
  const notes: string[] = [];
  let url: URL | null = null;
  try {
    url = new URL(ctx.locator);
  } catch {
    /* non-URL locator */
  }
  switch (ctx.code) {
    case "UNDEFINED_IN_URL": {
      const path = url?.pathname ?? "";
      const idx = path
        .split("/")
        .findIndex((seg) =>
          /^(undefined|null|nan|\[object object\])$/i.test(decodeURIComponent(seg)),
        );
      const suffix =
        idx >= 0
          ? `/${path
              .split("/")
              .slice(idx + 1)
              .join("/")}`
          : path;
      terms.push(suffix, "process.env.", "import.meta.env.");
      notes.push(
        `Find where the request path \`${suffix}\` is built with a variable prefix (a template literal or string concatenation). The value before \`${suffix}\` was empty when the code ran.`,
        "If it is a build-time variable (NEXT_PUBLIC_*, VITE_*, REACT_APP_*), it must be set in the hosting environment **before the build**, then redeployed.",
        `Where to set environment variables here: ${ctx.hints.env_var}`,
      );
      break;
    }
    case "LOCALHOST_CALL":
      terms.push(
        url ? `${url.hostname}:${url.port}`.replace(/:$/, "") : ctx.locator,
        "localhost",
        "127.0.0.1",
      );
      notes.push(
        "A hard-coded development URL ships to production. Replace it with a configured base URL (an environment variable) or a same-origin relative path.",
      );
      break;
    case "SAME_ORIGIN_FAILURE":
    case "ROUTE_BROKEN":
    case "ROUTE_MISSING":
      terms.push(url?.pathname ?? ctx.locator);
      notes.push(
        ctx.code === "SAME_ORIGIN_FAILURE"
          ? "Find the code that calls this path, and the route or API handler that should answer it."
          : "Find the link that points to this path, and the page or route that should exist for it (or remove the link).",
      );
      break;
    case "CONSOLE_ERROR":
    case "UNCAUGHT_EXCEPTION": {
      const text = (ctx.discriminator ?? ctx.message).replace(/^(Uncaught\s+)?(\w*Error:\s*)/, "");
      terms.push(text.slice(0, 80));
      notes.push(
        "Search for the exact message text; if it is thrown by a library, find the call site in your code that triggers it.",
      );
      break;
    }
    case "BLANK_PAGE":
      terms.push("export default function", "return null", "ReactDOM.createRoot", "hydrateRoot");
      notes.push(
        `Check the component for ${url?.pathname ?? "/"} (e.g. app/page.tsx, pages/index.tsx, src/App.tsx): it renders nothing, or crashes before first paint (see any uncaught exception issues).`,
      );
      break;
    case "MIXED_CONTENT":
      terms.push(url ? `http://${url.host}` : ctx.locator);
      notes.push("Load the resource over https:// (or a protocol-relative/same-origin path).");
      break;
    case "SLOW_RESPONSE":
      notes.push(
        "Compare with a second request (cold start vs. warm), check server timing on the host, slow database queries or upstream calls made while rendering, and whether the page could be cached or statically generated.",
      );
      break;
    default:
      terms.push(ctx.locator);
  }
  return { terms: [...new Set(terms.filter(Boolean))], notes };
}

function investigate(ctx: PromptContext): string {
  const { terms, notes } = searches(ctx);
  const grep = terms.length
    ? terms.map((t) => `- ${quote(t)} — e.g. \`git grep -n -F ${JSON.stringify(t)}\``).join("\n")
    : "- (no literal search applies; see the notes below)";
  return [
    `# Unconfirmed lead: ${ctx.title}`,
    "",
    "> **Unconfirmed lead.** CodeSentra has not linked this observation to a file and line yet (Sentra Link traces need a Scan of the repository). Investigate and confirm the cause before editing anything; report back if the evidence does not match.",
    "",
    "## What CodeSentra observed",
    bullet([`Target: ${targetLine(ctx)}`, ctx.message, ...observations(ctx), corroboration(ctx)]),
    "",
    "## Suggested searches",
    grep,
    "",
    "## Notes",
    bullet(notes),
    "",
    fixedWhen(ctx),
  ].join("\n");
}

/**
 * Renders the fix prompt for an issue. Pure string templating over stored facts; no
 * LLM call (Section 10c). Every finding code maps to a template.
 */
export function renderPrompt(ctx: PromptContext): RenderedPrompt {
  const type = promptTypeFor(ctx.code, ctx.hasVerifiedTrace);
  let body: string;
  switch (type) {
    case "outage_triage":
      body = outageTriage(ctx);
      break;
    case "config_fix":
      body = configFix(ctx);
      break;
    case "investigate":
      body = investigate(ctx);
      break;
    case "code_fix":
      throw new Error(
        `code_fix prompts need a verified trace or a Scan location (Phases 3–4); ${ctx.code} has none yet`,
      );
  }
  return { type, body: `${body.trim()}\n`, templateVersion: TEMPLATE_VERSIONS[type] };
}

/** Human title for an issue led by `code`. */
export function issueTitle(
  code: FindingCode,
  locator: string,
  discriminator?: string | null,
): string {
  const base = FINDING_CODE_DECLARATIONS[code].title;
  let where = locator;
  try {
    const u = new URL(locator);
    where = u.pathname === "/" ? u.host : `${u.host}${u.pathname}`;
  } catch {
    /* keep */
  }
  if (discriminator) return `${base}: ${discriminator.slice(0, 80)}`;
  return `${base} — ${where}`;
}
