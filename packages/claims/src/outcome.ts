import type { CheckName, CheckOutcome } from "./index.js";

/**
 * A deterministic read of what a report sentence claims about the project's health
 * (WS-2, audit F-02). The claim verifier is the last guard against the model fabricating or
 * being talked into success language ("all tests pass", "production-ready") that the evidence
 * does not support, so this does not trust the model's own words: it derives, from the text,
 * which check a sentence says succeeded, and whether it makes an unfalsifiable quality boast.
 * Default deny: an outcome or quality claim stands only when a check backs it.
 *
 * The detector is structural, not a fixed list of whole phrases (which a new paraphrase always
 * slips past — re-audit N-1/N-4): a sentence asserts "check X succeeded" when it names a
 * subject that belongs to check X (tests, build, typecheck, lint, install, the dependency
 * audit, secrets) together with a positive-outcome signal (pass/green/clean/"no errors"/
 * "flags nothing"/"emits no"/"sail through"/…) or the negation of a failure ("no failing
 * tests", "zero failures"), and is not an honest partial or failure report. It is deliberately
 * eager: an ambiguous success sentence is gated rather than waved through.
 */

export type OutcomeClaim =
  | { kind: "check"; check: CheckName; polarity: "positive" | "negative" }
  | { kind: "quality"; phrase: string };

/**
 * Subject tokens, by check. A sentence naming one of these is *about* that check; whether it
 * asserts success is decided separately by the outcome signal. Ordered so a more specific
 * subject (the compiler → typecheck) is found before a broad one.
 */
const SUBJECTS: { check: CheckName; re: RegExp }[] = [
  {
    check: "typecheck",
    re: /\b(types?[\s-]?check(s|ing|ed)?|tsc|typescript|the\s+type\s+system|the\s+compiler|type[\s-]?safe(ty)?|type\s+errors?)\b/,
  },
  {
    check: "lint",
    re: /\b(lint(s|ing|er)?|biome|eslint|prettier|the\s+linter|static\s+analysis)\b/,
  },
  {
    check: "build",
    re: /\b(builds?|build\s+step|(re)?compiles?|compilation|the\s+project\s+builds?|bundl(e|es|ing))\b/,
  },
  {
    check: "install",
    re: /\b(installs?|installation|install\s+step|dependencies\s+(install|pull|download|resolve)|packages?\s+(install|pull|download|resolve))\b/,
  },
  {
    check: "secrets",
    re: /\b(secrets?|credentials?|api\s+keys?|access\s+keys?|hard[\s-]?coded\s+(keys?|credentials?|secrets?)|secret[\s-]?scan\w*|gitleaks|security\s+scan\w*|the\s+scan|scanning)\b/,
  },
  {
    check: "dependency_audit",
    re: /\b((dependency|dependencies|security)\s+audit|the\s+audit|vulnerab\w+|cves?|advisor\w+|dependenc(y|ies))\b/,
  },
  // Broadest last: the test suite / coverage and the CI pipeline / "the checks" / "every gate".
  {
    check: "tests",
    re: /\b(tests?|specs?|suite|tested|covered|(code\s+)?coverage|test\s+runs?|ci|the\s+(ci\s+)?pipeline|the\s+checks?|all\s+checks|every\s+check|the\s+gates?|every\s+gate|all\s+gates|each\s+gate)\b/,
  },
];

/** Positive-outcome signals: a success is being asserted. These never include a flipping negation. */
const POSITIVE =
  /\b(pass(es|ing|ed)?|green|clean(ly)?|spotless|success(ful|fully)?|succeed(s|ing|ed)?|works?(\s+fine)?|fine|ok|happy|healthy|silent|satisfied|content|secure|safe|up[\s-]to[\s-]date|type[\s-]?safe(ty)?|in\s+order|in\s+the\s+green|checks?\s+out|sail(s|ed)?\s+through|go(es)?\s+through\s+(fine|clean(ly)?)|comes?\s+back\s+(clean|green|spotless|fine)|(fully|thoroughly|well|completely|100%?)\s+(tested|covered)|coverage\s+(is\s+)?(100%?|complete|full|high|comprehensive)|without\s+(a\s+)?(hitch|issue|issues|trouble|complaint|complaints|problem|problems|error|errors)|with\s+no\s+(errors?|issues?|problems?|trouble|complaints?)|no\s+(\w+\s+)?(errors?|issues?|problems?|warnings?|diagnostics?|complaints?|findings?|notes?|objections?|concerns?)|nothing\s+(concerning|to\s+say|of\s+note|flagged|amiss|wrong)|flags?\s+nothing|turns?\s+up\s+nothing|found\s+nothing|came?\s+up\s+(clean|empty)|emits?\s+no\b|report(s|ed)?\s+(no\b|nothing)|raises?\s+no\b|type[\s-]?safe)\b/;

/** Negation of a failure, which is itself a success claim ("no failing tests", "zero failures"). */
const NEG_SUCCESS =
  /\b(no|not\s+(one|a\s+single|any)|zero|without\s+(a\s+single|any))\b[\s\w]{0,24}?\b(fail(s|ed|ing|ures?)?|broken)\b|\bnothing\s+(fail(s|ed|ing)?|broke|went\s+wrong)\b/;

/**
 * Negation of a bad *finding*, also a success claim: "no known vulnerabilities", "no secrets
 * were detected", "free of hard-coded credentials". The dependency-audit and secrets checks
 * assert the good state by the absence of findings rather than by "passing".
 */
const NEG_FINDING =
  /\b(no|zero|not\s+(any|a\s+single)|free\s+(of|from)|without)\b[\s\w]{0,24}?\b(vulnerab\w+|cves?|advisor\w+|secrets?|credentials?|api\s+keys?|leaks?|leaked|exposed|committed|hard[\s-]?coded)\b|\bno\s+(\w+\s+)?(secrets?|credentials?|keys?|vulnerab\w+)\b/;

/** Unfalsifiable quality boasts: dropped by default (no check can establish them). */
const QUALITY_PHRASES =
  /\b(production[\s-]?(ready|grade|hardened)|ready\s+to\s+ship\s+to\s+production|(ready|safe)\s+for\s+production(\s+use)?|ship[\s-]?ready|enterprise[\s-]?grade|battle[\s-]?tested|bullet[\s-]?proof|bug[\s-]?free|defect[\s-]?free|rock[\s-]?solid|flawless|fault[\s-]?tolerant|fully\s+functional|feature[\s-]?complete|never\s+(crashes?|fails?|breaks?)|zero\s+(bugs?|defects?|issues?)|no\s+(bugs?|defects?)|completely\s+(safe|secure|stable|reliable)|highly\s+(secure|available|reliable)|(secure|safe)\s+by\s+design|(thoroughly|fully)\s+hardened|(is\s+)?(secure|safe)\s+against\b|hardened\s+against\b|impervious\s+to\b|immune\s+to\b|guaranteed\b|robust\s+and\s+reliable|reliable\s+and\s+robust|(100%?|fully)\s+(secure|stable|reliable|robust))/;

/** Words that negate a following outcome within a short window. */
const NEG =
  /\b(no|not|never|cannot|can't|without|fails?\s+to|does\s+not|doesn't|didn't|isn't|aren't|won't|lacks?|missing|broken|failing)\b/;

/**
 * Whether a sentence reports a *mixed or partial* result rather than a blanket success —
 * "2 of 4 tests pass and 1 fails", "75% of tests pass" — so its "tests pass" is honest
 * reporting, not a success claim to police. A negated failure ("no failing tests") is success.
 */
function mixedResult(lower: string): boolean {
  if (/\b\d+\s+of\s+\d+\b/.test(lower) || /\b\d+\s*%\s+of\b/.test(lower)) return true;
  // Strip success framed as the negation of a bad outcome before looking for a real failure.
  const rest = lower
    .replace(/\bno\s+(failing|broken)\s+(tests?|specs?)\b/g, " ")
    .replace(
      /\b(no|not\s+(one|a\s+single|any)|zero|without\s+(a\s+single|any))\b[\s\w]{0,24}?\b(fail(s|ed|ing|ures?)?|broken|errors?)\b/g,
      " ",
    )
    .replace(/\bnothing\s+(fail(s|ed|ing)?|broke|went\s+wrong)\b/g, " ");
  return /\b(fails?|failed|failing|broken|errored?)\b/.test(rest);
}

/** Whether a negation falls close before `index` in the lower-cased text. */
function negatedBefore(text: string, index: number): boolean {
  return NEG.test(text.slice(Math.max(0, index - 40), index));
}

/**
 * The check-outcome and quality claims a sentence makes. A subject plus a positive signal (not
 * under sentence negation) is a positive claim; a subject plus a negated failure is positive
 * too; a subject under a negated positive ("the build does not pass") is a negative claim,
 * which is honest reporting and not policed.
 */
export function outcomeClaims(text: string): OutcomeClaim[] {
  const lower = text.toLowerCase();
  const out: OutcomeClaim[] = [];
  const seen = new Set<string>();
  const partial = mixedResult(lower);
  const negGood = NEG_SUCCESS.test(lower) || NEG_FINDING.test(lower);
  const pos = new RegExp(POSITIVE.source, "gi").exec(lower);

  for (const { check, re } of SUBJECTS) {
    const sm = new RegExp(re.source, "gi").exec(lower);
    if (!sm) continue;
    let polarity: "positive" | "negative" | null = null;
    if (negGood) {
      // Success framed as the absence of a failure or a bad finding ("no failing tests",
      // "zero failures", "no known vulnerabilities", "no secrets detected").
      polarity = "positive";
    } else if (pos) {
      // A positive outcome signal is present; a sentence negation before it flips it.
      polarity = negatedBefore(lower, pos.index) ? "negative" : "positive";
    }
    if (polarity === null) continue; // the subject is named but no success is asserted
    if (partial && polarity === "positive") continue; // honest partial/mixed report
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
