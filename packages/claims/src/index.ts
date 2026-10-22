import type { ClaimDraft, ClaimDropReason, FeatureStatus, JsonValue } from "@codesentra/core";

export interface VerifierEvidence {
  id: string;
  runId: string;
  kind: string;
  locator: string;
  payload: JsonValue;
}

export type CheckName =
  | "install"
  | "build"
  | "typecheck"
  | "lint"
  | "tests"
  | "dependency_audit"
  | "secrets";
export type CheckOutcome = "pass" | "fail" | "skipped" | "not_applicable";

export interface VerifierContext {
  /** This run and, for cached scans, the run whose snapshot evidence is reused. */
  runIds: ReadonlySet<string>;
  evidence: ReadonlyMap<string, VerifierEvidence>;
  features: { name: string; status: FeatureStatus; evidenceIds: string[] }[];
  checks: Partial<Record<CheckName, CheckOutcome>>;
}

export type Verdict =
  | { verified: true }
  | { verified: false; reason: ClaimDropReason; detail: string };

// --- Concrete tokens ---------------------------------------------------------------------

/** Technology names: naming one is a concrete claim the evidence must support. */
const TECH = [
  "PostgreSQL",
  "Postgres",
  "MySQL",
  "MariaDB",
  "SQLite",
  "MongoDB",
  "Redis",
  "DynamoDB",
  "Cassandra",
  "Elasticsearch",
  "Supabase",
  "Firebase",
  "Prisma",
  "Drizzle",
  "Sequelize",
  "TypeORM",
  "SQLAlchemy",
  "Mongoose",
  "Express",
  "Fastify",
  "NestJS",
  "Koa",
  "Hono",
  "Next.js",
  "Nuxt",
  "React",
  "Vue",
  "Svelte",
  "Angular",
  "Vite",
  "Remix",
  "Astro",
  "Django",
  "Flask",
  "FastAPI",
  "Starlette",
  "Rails",
  "Laravel",
  "Spring",
  "GraphQL",
  "gRPC",
  "tRPC",
  "WebSocket",
  "WebSockets",
  "Kafka",
  "RabbitMQ",
  "S3",
  "Stripe",
  "OAuth",
  "JWT",
  "Docker",
  "Kubernetes",
  "Terraform",
  "AWS",
  "GCP",
  "Azure",
  "Vercel",
  "Netlify",
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "Kotlin",
  "Ruby",
  "PHP",
  "jest",
  "vitest",
  "pytest",
  "mocha",
  "Playwright",
  "Cypress",
  "Tailwind",
  "Bootstrap",
  "Webpack",
  "esbuild",
  "Babel",
  "Deno",
  "Bun",
  "Node.js",
  "lodash",
  "jinja2",
  "Jinja",
  "uvicorn",
  "gunicorn",
  "Celery",
];
const TECH_RE = new RegExp(
  `(?<![\\w.-])(${TECH.map((t) => t.replace(/[.]/g, "\\.")).join("|")})(?![\\w-])`,
  "gi",
);

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

export interface Tokens {
  strings: string[];
  numbers: number[];
}

/**
 * Concrete tokens in a claim (Section 11, rule 2): file paths, `code`, symbol-like
 * identifiers (camelCase, snake_case, CONSTANT_CASE, dotted), route paths, versions,
 * technology names, and numbers (digits, number words, percentages).
 */
export function concreteTokens(text: string): Tokens {
  const strings = new Set<string>();
  const numbers: number[] = [];
  let rest = text;
  // Code spans: each whitespace-separated part must be supported (`POST /tasks`).
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    for (const part of (m[1] as string).trim().split(/\s+/)) if (part) strings.add(part);
    rest = rest.replace(m[0], " ");
  }
  // Advisory ids are opaque strings, never numbers.
  for (const m of rest.matchAll(
    /\b(GHSA(?:-[0-9a-z]{4}){3}|CVE-\d{4}-\d{4,}|PYSEC-\d{4}-\d+|OSV-\d{4}-\d+)\b/gi,
  )) {
    strings.add(m[1] as string);
    rest = rest.replace(m[0], " ");
  }
  const add = (re: RegExp, group = 0) => {
    for (const m of rest.matchAll(re)) {
      const v = (m[group] as string).replace(/[.,;:!?)]+$/, "");
      if (v) strings.add(v);
    }
  };
  // Paths: anything with a slash and a word char, or a file with an extension.
  add(/(?<![\w])(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.[\]{}:-]+)+\/?/g);
  add(
    /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md|toml|ya?ml|txt|lock|env|sql|sh|go|rs|java|rb|php|css|html)\b/g,
  );
  // Route paths like /tasks or /notes/{id}.
  add(/(?<![\w/])\/[\w{}:[\].-]*(?:\/[\w{}:[\].-]+)*/g);
  // Identifiers that are clearly code: CONSTANT_CASE (with _), snake_case, camelCase, dotted.calls.
  add(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g);
  add(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g);
  add(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g);
  add(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\(\)?/g);
  // Versions are strings (so 4.17.15 is not the number 4.17).
  for (const m of rest.matchAll(/\bv?\d+\.\d+(?:\.\d+)*\b/g)) {
    strings.add(m[0]);
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(TECH_RE)) strings.add(m[1] as string);
  for (const m of rest.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)(?![\w.-])\s*%?/g))
    numbers.push(Number(m[1]));
  for (const m of rest
    .toLowerCase()
    .matchAll(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g,
    )) {
    // "one of the routes" is not a count claim; numbers before a noun are.
    const after = rest
      .toLowerCase()
      .slice((m.index ?? 0) + (m[0] as string).length)
      .trim();
    if (!/^of\b/.test(after)) numbers.push(NUMBER_WORDS[m[1] as string] as number);
  }
  // Drop route-like tokens that are only "/" or plain words.
  const cleaned = [...strings].filter((s) => s.length > 1 && s !== "/" && !/^\/\W*$/.test(s));
  return { strings: cleaned, numbers };
}

const NON_COUNT_KEYS =
  /^(line|lines|column|skip_line|exit_code|duration_ms|size|bytes|.*_ms|.*_at|version|port)$/;

function collect(value: JsonValue, key: string, strings: string[], numbers: Set<number>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (!NON_COUNT_KEYS.test(key)) numbers.add(value);
    return;
  }
  if (typeof value === "string") {
    strings.push(value);
    if (key === "text" || key === "summary" || key === "description")
      for (const m of value.matchAll(/(?<![\w.])(\d+)(?![\w.])/g)) numbers.add(Number(m[1]));
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, key, strings, numbers);
    if (
      /^(failing|symbols|imports|packages|files|advisories|dependency_names|frameworks|languages)$/.test(
        key,
      )
    )
      numbers.add(value.length);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    strings.push(k);
    collect(v as JsonValue, k, strings, numbers);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/^\.\//, "").replace(/\\/g, "/");

// --- Status words and check assertions ---------------------------------------------------

const PLANNED =
  /\b(planned|not (yet )?(implemented|built|available|supported)|missing|roadmap|future|upcoming|todo|to be (built|added))\b/i;
const PARTIAL =
  /\b(partial(ly)?|incomplete|in progress|unfinished|stub(bed)?|not (fully|complete|finished)|work in progress|only (partly|partially))\b/i;
const COMPLETE =
  /\b(complete[ds]?|done|implemented|finished|works|working|fully|supports?|available|ready)\b/i;

function statusOf(text: string): FeatureStatus | null {
  if (PLANNED.test(text)) return "planned";
  if (PARTIAL.test(text)) return "partial";
  if (COMPLETE.test(text)) return "complete";
  return null;
}

const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "and",
  "or",
  "via",
  "as",
  "for",
  "with",
  "by",
  "in",
  "on",
  "is",
  "are",
  "be",
  "can",
]);
const stem = (w: string) => w.toLowerCase().replace(/(ing|ed|es|s)$/, "");
const words = (s: string) =>
  s
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((w) => !STOP.has(w))
    .map(stem) ?? [];

/** Features the claim talks about: shared evidence, or most of the feature name's words. */
function featuresIn(claim: ClaimDraft, ctx: VerifierContext) {
  const cw = new Set(words(claim.text));
  return ctx.features.filter((f) => {
    if (f.evidenceIds.some((id) => claim.evidence_ids.includes(id))) {
      const fw = words(f.name);
      return fw.some((w) => cw.has(w));
    }
    const fw = words(f.name);
    if (!fw.length) return false;
    const hit = fw.filter((w) => cw.has(w)).length;
    return hit / fw.length >= 0.5 && hit >= Math.min(2, fw.length);
  });
}

const CHECK_PATTERNS: [CheckName, RegExp][] = [
  // "All tests pass" / "Tests pass" / "every test passes"; not "2 of 4 tests pass".
  [
    "tests",
    /(\b(all|every)\s+(\w+\s+)?tests?\s+(pass|passes|passing|succeed|are green)\b|(^|[.!?]\s+)(the\s+)?tests\s+(all\s+)?pass(es|ing)?\b|\btest suite (passes|is green)\b|\bno (failing|broken) tests\b)/i,
  ],
  [
    "build",
    /\b(builds? (successfully|cleanly|without errors)|(the )?build (passes|succeeds|works)|compiles? (cleanly|without errors))\b/i,
  ],
  ["install", /\b(installs? (cleanly|successfully|without errors))\b/i],
  [
    "typecheck",
    /\b(type[- ]?checks? (cleanly|pass(es)?)|no type errors|type[- ]?safe without errors)\b/i,
  ],
  ["lint", /\b(lints? cleanly|no lint (errors|warnings)|passes lint(ing)?)\b/i],
  [
    "dependency_audit",
    /\b(no (known )?(vulnerabilities|vulnerable dependencies|advisories)|dependencies (are|have no known) (secure|safe|vulnerabilit(y|ies))|up[- ]to[- ]date and secure)\b/i,
  ],
  [
    "secrets",
    /\b(no (secrets|credentials|leaked keys|exposed secrets)( were)?( (found|detected|committed))?|free of secrets)\b/i,
  ],
];

/**
 * Verifies one draft claim against the run's evidence (Section 11). All rules must pass:
 * 1. it cites evidence, and every id exists and belongs to this run;
 * 2. every concrete token appears in a cited payload (numbers exactly);
 * 3. status words agree with the classifier, and a claim about an unfinished feature
 *    must say so;
 * 4. it does not assert that a skipped or failed check passed.
 */
export function verifyClaim(claim: ClaimDraft, ctx: VerifierContext): Verdict {
  if (!claim.evidence_ids.length)
    return { verified: false, reason: "no_evidence", detail: "cites no evidence" };
  const cited: VerifierEvidence[] = [];
  for (const id of claim.evidence_ids) {
    const e = ctx.evidence.get(id);
    if (!e)
      return {
        verified: false,
        reason: "unknown_evidence",
        detail: `evidence ${id} does not exist`,
      };
    if (!ctx.runIds.has(e.runId))
      return {
        verified: false,
        reason: "foreign_evidence",
        detail: `evidence ${id} belongs to another run`,
      };
    cited.push(e);
  }

  for (const [check, re] of CHECK_PATTERNS) {
    if (!re.test(claim.text)) continue;
    const outcome = ctx.checks[check];
    if (outcome !== "pass")
      return {
        verified: false,
        reason: "skipped_check_asserted",
        detail: `asserts ${check} passed, but it ${outcome === undefined ? "was not checked" : outcome === "fail" ? "failed" : `was ${outcome}`}`,
      };
  }

  const strings: string[] = [];
  const numbers = new Set<number>();
  for (const e of cited) {
    strings.push(e.locator);
    collect(e.payload, "", strings, numbers);
  }
  const haystack = norm(strings.join("\n"));
  const tokens = concreteTokens(claim.text);
  for (const t of tokens.strings) {
    const n = norm(t);
    if (!haystack.includes(n) && !haystack.includes(n.replace(/^\//, "")))
      return {
        verified: false,
        reason: "unsupported_token",
        detail: `"${t}" is not in the cited evidence`,
      };
  }
  for (const n of tokens.numbers) {
    if (!numbers.has(n))
      return {
        verified: false,
        reason: "number_mismatch",
        detail: `${n} does not match the cited evidence`,
      };
  }

  const said = statusOf(claim.text);
  for (const f of featuresIn(claim, ctx)) {
    if (said && said !== f.status)
      return {
        verified: false,
        reason: "status_contradiction",
        detail: `says "${said}" but "${f.name}" is ${f.status}`,
      };
    if (!said && f.status !== "complete")
      return {
        verified: false,
        reason: "status_contradiction",
        detail: `describes "${f.name}" without saying it is ${f.status}`,
      };
  }
  return { verified: true };
}
