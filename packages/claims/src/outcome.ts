import type { CheckName, CheckOutcome } from "./index.js";

/**
 * A deterministic read of what a report sentence claims about the project's health
 * (WS-2, audit F-02). The claim verifier is the last guard against the model fabricating or
 * being talked into success language ("all tests pass", "production-ready") that the
 * evidence does not support, so this does not trust the model's own words: it derives, from
 * the text, which check-outcome a sentence asserts, and whether it makes an unfalsifiable
 * quality boast. Default deny: an outcome or quality claim stands only when a check backs it.
 */

export type OutcomeClaim =
  | { kind: "check"; check: CheckName; polarity: "positive" | "negative" }
  | { kind: "quality"; phrase: string };

/** Phrases that assert a check succeeded, by check. Matched case-insensitively on word runs. */
const CHECK_PHRASES: { check: CheckName; re: RegExp }[] = [
  // tests
  {
    check: "tests",
    re: /\b(tests?|specs?|test\s+suite|spec\s+suite)\b[\s\w,]*\b(pass(es|ing|ed)?|green|succeed(s|ing|ed)?|success(ful|fully)?|ok|work(s|ing)?)\b/,
  },
  {
    check: "tests",
    re: /\b(pass(es|ing|ed)?|all|every|100%?|fully)\b[\s\w,]*\b(tests?|specs?|test\s+suite)\b/,
  },
  { check: "tests", re: /\b(fully|well|thoroughly|100%?|completely)\s+(tested|covered)\b/ },
  { check: "tests", re: /\b(test|code)\s+coverage\s+(is\s+)?(100%?|complete|full|high)\b/ },
  { check: "tests", re: /\bno\s+(failing|broken)\s+(tests?|specs?)\b/ },
  { check: "tests", re: /\b(the\s+)?(test\s+)?suite\s+(is\s+)?(green|passes|passing)\b/ },
  {
    check: "tests",
    re: /\b(CI|the\s+(ci\s+)?pipeline|all\s+checks|every\s+check|the\s+checks)\b[\s\w]{0,12}\b(green|pass(es|ing)?|succeed(s|ed)?)\b/,
  },
  // build
  {
    check: "build",
    re: /\b(builds?|compiles?|compilation|build)\b[\s\w,]*\b(clean(ly)?|success(ful|fully)?|green|pass(es|ed)?|works?|without\s+errors?|fine|ok)\b/,
  },
  {
    check: "build",
    re: /\b(the\s+)?build\s+(is\s+)?(green|clean|passing|fine|ok|succeed(s|ed)?|complete(s|d)?)\b/,
  },
  { check: "build", re: /\bcompiles?\s+(fine|cleanly|without\s+errors?|ok)\b/ },
  { check: "build", re: /\bcompilation\s+(succeed(s|ed)?|is\s+(clean|successful)|passes)\b/ },
  // typecheck
  {
    check: "typecheck",
    re: /\b(type[\s-]?check(s|ing|ed)?|types?|tsc|typescript)\b[\s\w,]*\b(pass(es|ed)?|clean(ly)?|succeed(s|ed)?|fine|ok|without\s+errors?)\b/,
  },
  { check: "typecheck", re: /\bno\s+type\s+errors?\b/ },
  { check: "typecheck", re: /\btype[\s-]?safe\b/ },
  { check: "typecheck", re: /\btypes?\s+check\s+out\b/ },
  // lint
  {
    check: "lint",
    re: /\blint(s|ing)?\b[\s\w,]*\b(clean(ly)?|pass(es|ed)?|green|without\s+(errors?|warnings?)|fine|ok)\b/,
  },
  { check: "lint", re: /\blint(ing)?\s+is\s+clean\b/ },
  { check: "lint", re: /\bno\s+lint\s+(errors?|warnings?|issues?)\b/ },
  { check: "lint", re: /\bpasses\s+lint(ing)?\b/ },
  // install
  {
    check: "install",
    re: /\b(installs?|dependencies\s+install|installation)\b[\s\w,]*\b(clean(ly)?|success(ful|fully)?|succeed(s|ed)?|complete(s|d)?|without\s+errors?|fine|ok)\b/,
  },
  // dependency_audit
  {
    check: "dependency_audit",
    re: /\bno\s+(known\s+)?(vulnerab\w+|vulnerable\s+dependencies|advisories|CVEs?|security\s+(issues|advisories))\b/,
  },
  {
    check: "dependency_audit",
    re: /\bdependencies\s+(are\s+)?(secure|safe|up[\s-]to[\s-]date\s+and\s+secure|free\s+of\s+(known\s+)?vulnerab\w+)\b/,
  },
  { check: "dependency_audit", re: /\b(free\s+(of|from)|no)\s+(known\s+)?vulnerab\w+\b/ },
  // secrets
  {
    check: "secrets",
    re: /\b(no|free\s+of|without)\s+(hard[\s-]?coded\s+)?(secrets?|credentials?|leaked\s+keys?|exposed\s+(secrets?|keys?|credentials?)|api\s+keys?)\b/,
  },
  {
    check: "secrets",
    re: /\bno\s+(secrets?|credentials?)\s+(were\s+)?(found|detected|committed|leaked|exposed)\b/,
  },
];

/** Unfalsifiable quality boasts: dropped by default (no check can establish them). */
const QUALITY_PHRASES =
  /\b(production[\s-]?(ready|grade|hardened)|ready\s+to\s+ship\s+to\s+production|(ready|safe)\s+for\s+production(\s+use)?|ship[\s-]?ready|enterprise[\s-]?grade|battle[\s-]?tested|bullet[\s-]?proof|bug[\s-]?free|defect[\s-]?free|rock[\s-]?solid|flawless|fault[\s-]?tolerant|fully\s+functional|feature[\s-]?complete|never\s+(crashes?|fails?|breaks?)|zero\s+(bugs?|defects?|issues?)|no\s+(bugs?|defects?)|completely\s+(safe|secure|stable|reliable)|highly\s+(secure|available|reliable)|(secure|safe)\s+by\s+design|(thoroughly|fully)\s+hardened|(is\s+)?(secure|safe)\s+against\b|hardened\s+against\b|impervious\s+to\b|immune\s+to\b|guaranteed\b|robust\s+and\s+reliable|reliable\s+and\s+robust|(100%?|fully)\s+(secure|stable|reliable|robust))/;

/** Words that negate a following outcome within a short window. */
const NEG =
  /\b(no|not|never|cannot|can't|without|fails?\s+to|does\s+not|doesn't|isn't|aren't|lacks?|missing|broken|failing)\b/;

/**
 * Whether a sentence reports a *mixed or partial* result rather than a blanket success —
 * "2 of 4 tests pass and 1 fails", "75% of tests pass" — so its "tests pass" is honest
 * reporting, not a success claim to police. A "no failing tests" success phrase is not a
 * failure mention.
 */
function mixedResult(lower: string): boolean {
  if (/\b\d+\s+of\s+\d+\b/.test(lower) || /\b\d+\s*%\s+of\b/.test(lower)) return true;
  const rest = lower.replace(/\bno\s+(failing|broken)\s+(tests?|specs?)\b/g, " ");
  return /\b(fails?|failed|failing|broken|errored?)\b/.test(rest);
}

/** Whether a negation falls close before `index` in the lower-cased text. */
function negatedBefore(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 40), index);
  // A negation that is itself part of the matched positive phrase (e.g. "no lint errors")
  // is handled by those phrases being listed as positive; here we catch sentence negation.
  return NEG.test(window);
}

/**
 * The check-outcome and quality claims a sentence makes. A phrase already built around a
 * negation (listed above as a positive, e.g. "no failing tests") is positive; a sentence-level
 * negation before an otherwise-positive phrase ("tests do not pass") flips it to negative.
 */
export function outcomeClaims(text: string): OutcomeClaim[] {
  const lower = text.toLowerCase();
  const out: OutcomeClaim[] = [];
  const seen = new Set<string>();
  // A sentence reporting a partial or mixed result is honest, not a blanket success claim.
  const partial = mixedResult(lower);
  for (const { check, re } of CHECK_PHRASES) {
    if (partial) continue;
    const m = new RegExp(re.source, "gi").exec(lower);
    if (!m) continue;
    // Each phrase asserts success (including the "no failing tests" forms, which claim the
    // good state). A negation before the phrase, or inside it ("build does not pass"), flips
    // it to a negative claim. Bare "no" is excluded: it heads the "no failing tests" success
    // phrases.
    const internalNeg = /\b(not|never|n't|cannot|do(es)?\s+not|fails?\s+to)\b/.test(m[0] as string);
    const polarity = negatedBefore(lower, m.index) || internalNeg ? "negative" : "positive";
    const key = `${check}:${polarity}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind: "check", check, polarity });
    }
  }
  const q = QUALITY_PHRASES.exec(lower);
  if (q && !negatedBefore(lower, q.index)) out.push({ kind: "quality", phrase: q[0].trim() });
  return out;
}

export type OutcomeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Checks a sentence's outcome and quality claims against the real check results. A positive
 * check claim needs that check to have passed; a quality boast is always rejected.
 */
export function checkOutcomeClaims(
  text: string,
  checks: Partial<Record<CheckName, CheckOutcome>>,
): OutcomeVerdict {
  for (const c of outcomeClaims(text)) {
    if (c.kind === "quality")
      return { ok: false, reason: `unverifiable quality claim "${c.phrase}"` };
    if (c.polarity !== "positive") continue;
    const outcome = checks[c.check];
    if (outcome !== "pass")
      return {
        ok: false,
        reason: `asserts ${c.check} succeeded, but it ${outcome === undefined ? "was not run" : outcome === "fail" ? "failed" : `was ${outcome}`}`,
      };
  }
  return { ok: true };
}
