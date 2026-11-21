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
    // `check(s|ing|ed|er)?` recognises the agent-noun "typechecker"/"type-checker"/"type checker"
    // — a plainly-worded check subject, not a metaphor (re-audit, independent: rigid `(s|ing|ed)?`
    // leaked "The typechecker passed." with typecheck failing).
    re: /\b(types?[\s-]?check(s|ing|ed|er)?|tsc|typescript|the\s+type\s+system|the\s+compiler|type[\s-]?safe(ty)?|type\s+(errors?|gripes?|complaints?|issues?|problems?|warnings?))\b/,
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
    re: /\b(install(s|ation|ed|ing)?|install\s+step|(dependenc(y|ies)|packages?)\s+(install\w*|pull\w*|download\w*|resol(ve|ves|ved|ving|ution)|graph|tree)|lock\s?files?|packager|package\s+manager)\b/,
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
    // "gate"/"check" are check subjects even with an adjective between the determiner and the
    // noun ("the whole gate", "the entire check matrix", "every quality gate") — the determiner
    // need not be adjacent (re-audit: rigid adjacency leaked those forms). `gates?\b` excludes
    // "gateway". Also the standalone "quality gate" and "check matrix/set/battery/run".
    re: /\b(tests?|specs?|suite|tested|covered|(code\s+)?coverage|test\s+runs?|ci|the\s+(ci\s+)?pipeline|(the|all|every|each|any)\s+(\w+\s+)?(checks?|gates?)|quality\s+gates?|check\s+(matrix|set|suite|battery|runs?)|verification\s+(stack|suite|run|step|matrix|pipeline))\b/,
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
