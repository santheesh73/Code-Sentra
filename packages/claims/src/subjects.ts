import type { CheckName } from "./index.js";

/**
 * Check-subject recognition (WS-A, re-audit N-4). The report separates deterministic check
 * results (rendered from run_steps/evidence) from LLM narrative. The verifier therefore drops
 * ANY narrative sentence whose subject is a check or its result — whatever the sentence says —
 * because the templated line already states that fact and natural-language success phrasing is
 * unbounded (a polarity detector always leaks the next paraphrase). Unlike that detector, this
 * is a *closed* problem: the set of check subjects is finite and enumerable, so it does not
 * depend on how success or failure is worded.
 *
 * `checkSubject` returns which check a sentence is about, or null when it is about something
 * else (what the project is, a feature, a route, an env var, an issue's context).
 */
export type CheckSubject = CheckName | "health";

const SUBJECTS: { subject: CheckSubject; re: RegExp }[] = [
  // The project's overall readiness / health score — templated from the score, never narrated.
  {
    subject: "health",
    re: /\b(health\s+score|the\s+score|overall\s+(health|score|readiness)|production[\s-]?(ready|readiness)|readiness)\b/,
  },
  {
    subject: "typecheck",
    re: /\b(types?[\s-]?check(s|ing|ed)?|tsc|typescript|the\s+type\s+system|the\s+compiler|type[\s-]?safe(ty)?|type\s+errors?)\b/,
  },
  {
    subject: "lint",
    re: /\b(lint(s|ing|er)?|biome|eslint|prettier|the\s+linter|the\s+formatter|static\s+analysis)\b/,
  },
  {
    subject: "build",
    re: /\b(builds?|build\s+step|(re)?compiles?|compilation|bundl(e|es|ing)|the\s+project\s+builds?)\b/,
  },
  {
    subject: "install",
    re: /\b(install(s|ation|ed|ing)?|install\s+step|(dependenc(y|ies)|packages?)\s+(install\w*|pull\w*|download\w*|resol(ve|ves|ved|ving|ution)))\b/,
  },
  {
    subject: "secrets",
    re: /\b(secrets?|credentials?|api\s+keys?|access\s+keys?|hard[\s-]?coded\s+(keys?|credentials?|secrets?)|secret[\s-]?scan\w*|gitleaks|security\s+scan\w*|the\s+scan|scanning)\b/,
  },
  {
    subject: "dependency_audit",
    re: /\b((dependency|dependencies|security)\s+audit|the\s+audit|vulnerab\w+|cves?|advisor\w+|dependenc(y|ies))\b/,
  },
  {
    subject: "tests",
    re: /\b(tests?|specs?|suite|tested|covered|(code\s+)?coverage|test\s+runs?|ci|the\s+(ci\s+)?pipeline|the\s+checks?|all\s+checks|every\s+check|the\s+gates?|every\s+gate|all\s+gates|each\s+gate)\b/,
  },
];

/** The check a sentence is about, or null when it is about something other than a check. */
export function checkSubject(text: string): CheckSubject | null {
  const lower = text.toLowerCase();
  for (const { subject, re } of SUBJECTS) if (re.test(lower)) return subject;
  return null;
}

/** Whether a sentence's subject is a check or its result (so it must not appear in narrative). */
export function isCheckStatement(text: string): boolean {
  return checkSubject(text) !== null;
}
