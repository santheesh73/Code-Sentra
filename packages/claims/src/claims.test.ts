import { describe, expect, it } from "vitest";
import {
  concreteTokens,
  type VerifierContext,
  type VerifierEvidence,
  verifyClaim,
} from "./index.js";

const RUN = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
let n = 0;
const id = () => `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const ev = (
  kind: string,
  locator: string,
  payload: VerifierEvidence["payload"],
  runId = RUN,
): VerifierEvidence => ({ id: id(), runId, kind, locator, payload });

// Evidence shaped like a ts-taskboard scan.
const E = {
  manifest: ev("manifest", "package.json", {
    name: "ts-taskboard",
    description: "A tiny HTTP API for team task lists",
    dependencies: { express: "4.22.3", lodash: "4.17.15" },
    frameworks: ["Express"],
    package_manager: "npm",
  }),
  readmeCreate: ev("doc_excerpt", "README.md:8", {
    file: "README.md",
    line: 8,
    section: "Features",
    text: "- **Create tasks** — `POST /tasks` with a title and optional assignee.",
  }),
  readmeEmail: ev("doc_excerpt", "README.md:15", {
    file: "README.md",
    line: 15,
    section: "Roadmap",
    text: "- **Email reminders** — daily email to assignees with their open tasks.",
  }),
  routeCreate: ev("route", "src/routes/tasks.ts:8", {
    method: "POST",
    path: "/tasks",
    file: "src/routes/tasks.ts",
    line: 8,
    handler: null,
  }),
  routeExport: ev("route", "src/routes/tasks.ts:30", {
    method: "GET",
    path: "/tasks/export.csv",
    file: "src/routes/tasks.ts",
    line: 30,
  }),
  stub: ev("code_fact", "src/lib/csv.ts:4", {
    kind: "stub",
    symbol: "exportCsv",
    file: "src/lib/csv.ts",
    line: 4,
    text: 'throw new Error("not implemented");',
  }),
  store: ev("code_fact", "src/lib/store.ts", {
    kind: "file",
    file: "src/lib/store.ts",
    symbols: ["Task", "TaskStore"],
    imports: [],
    packages: ["lodash/sortBy.js"],
  }),
  tests: ev("probe_result", "package.json#tests", {
    probe: "tests",
    status: "fail",
    pass: 2,
    fail: 1,
    skip: 1,
    total: 4,
    failing: ["marks a task done"],
    duration_ms: 812,
    exit_code: 1,
  }),
  envRead: ev("env_var_read", "src/server.ts:9", {
    name: "TASKBOARD_ADMIN_TOKEN",
    file: "src/server.ts",
    line: 9,
    text: "const adminToken = process.env.TASKBOARD_ADMIN_TOKEN;",
  }),
  secret: ev("secret_match", "src/config/defaults.ts:4", {
    type: "aws-access-token",
    file: "src/config/defaults.ts",
    line: 4,
    preview: 'backupAccessKeyId: "•••",',
  }),
  advisory: ev("dependency_advisory", "package-lock.json", {
    package: "lodash",
    version: "4.17.15",
    advisories: [{ id: "GHSA-p6mc-m468-83gw", severity: "high" }],
  }),
  foreign: ev(
    "route",
    "src/admin.ts:3",
    { method: "GET", path: "/admin", file: "src/admin.ts" },
    OTHER,
  ),
};
const all = Object.values(E);
const ctx: VerifierContext = {
  runIds: new Set([RUN]),
  evidence: new Map(all.map((e) => [e.id, e])),
  features: [
    {
      name: "Create tasks",
      status: "complete",
      evidenceIds: [E.readmeCreate.id, E.routeCreate.id],
    },
    { name: "Export tasks to CSV", status: "partial", evidenceIds: [E.routeExport.id, E.stub.id] },
    { name: "Email reminders", status: "planned", evidenceIds: [E.readmeEmail.id] },
  ],
  checks: {
    install: "pass",
    build: "pass",
    typecheck: "pass",
    lint: "skipped",
    tests: "fail",
    dependency_audit: "fail",
    secrets: "fail",
  },
};
const claim = (text: string, ...cite: VerifierEvidence[]) =>
  verifyClaim({ text, evidence_ids: cite.map((e) => e.id) }, ctx);

describe("token extraction", () => {
  it("finds paths, code, identifiers, routes, versions, tech names and numbers", () => {
    const t = concreteTokens(
      "The `exportCsv` stub in src/lib/csv.ts reads TASKBOARD_ADMIN_TOKEN via process.env, serves /tasks/export.csv on Express 4.22.3 with 12 tests and two failures (50%).",
    );
    expect(t.strings).toEqual(
      expect.arrayContaining([
        "exportCsv",
        "src/lib/csv.ts",
        "TASKBOARD_ADMIN_TOKEN",
        "/tasks/export.csv",
        "4.22.3",
        "Express",
      ]),
    );
    expect(t.numbers).toEqual(expect.arrayContaining([12, 2, 50]));
    expect(t.numbers).not.toContain(4.22);
  });
});

describe("true claims survive", () => {
  it.each([
    ["Taskboard is a tiny HTTP API for team task lists.", [E.manifest]],
    ["Tasks are created with `POST /tasks`.", [E.routeCreate]],
    [
      "Creating tasks is complete: POST /tasks is handled in src/routes/tasks.ts.",
      [E.routeCreate, E.readmeCreate],
    ],
    ["CSV export is partial: exportCsv in src/lib/csv.ts throws.", [E.stub, E.routeExport]],
    ["Email reminders are planned on the roadmap.", [E.readmeEmail]],
    ["2 of 4 tests pass and 1 fails.", [E.tests]],
    ["TASKBOARD_ADMIN_TOKEN is read in src/server.ts.", [E.envRead]],
    ["lodash 4.17.15 has advisory GHSA-p6mc-m468-83gw.", [E.advisory]],
    ["An AWS access key pattern is committed in src/config/defaults.ts.", [E.secret]],
    ["The API is built with Express.", [E.manifest]],
  ] as const)("%s", (text, cite) => {
    expect(claim(text, ...cite)).toEqual({ verified: true });
  });
});

/** Adversarial suite (Section 11): every fabrication must be dropped (target 100 %). */
describe("adversarial suite: every fabricated claim is dropped", () => {
  const cases: [string, string, VerifierEvidence[], string][] = [
    // Fabricated files, symbols, env vars, routes, packages.
    [
      "fabricated file",
      "Authentication is handled in src/auth.ts.",
      [E.routeCreate],
      "unsupported_token",
    ],
    [
      "fabricated symbol",
      "The `validateTask` helper rejects empty titles.",
      [E.routeCreate],
      "unsupported_token",
    ],
    [
      "fabricated env var",
      "Tokens are signed with TASKBOARD_SIGNING_KEY.",
      [E.envRead],
      "unsupported_token",
    ],
    [
      "fabricated route",
      "Tasks can be deleted with DELETE /tasks/:id.",
      [E.routeCreate],
      "unsupported_token",
    ],
    ["fabricated database", "Tasks are stored in PostgreSQL.", [E.store], "unsupported_token"],
    ["wrong framework", "The API uses Django.", [E.manifest], "unsupported_token"],
    ["wrong version", "It runs on Express 5.0.0.", [E.manifest], "unsupported_token"],
    [
      "fabricated advisory",
      "lodash has advisory GHSA-xxxx-yyyy-zzzz.",
      [E.advisory],
      "unsupported_token",
    ],
    // Wrong counts.
    ["inflated count", "The project has 12 tests.", [E.tests], "number_mismatch"],
    ["wrong count in words", "Three tests fail.", [E.tests], "number_mismatch"],
    ["wrong percentage", "75% of tests pass.", [E.tests], "number_mismatch"],
    // Confident wording with no or bad evidence.
    ["no evidence", "The codebase is production-ready and well tested.", [], "no_evidence"],
    [
      "unknown id",
      "Tasks are created with POST /tasks.",
      [ev("route", "x", {})],
      "unknown_evidence",
    ],
    ["evidence from another run", "Admins use GET /admin.", [E.foreign], "foreign_evidence"],
    // Status contradictions.
    [
      "planned claimed done",
      "Email reminders are implemented.",
      [E.readmeEmail],
      "status_contradiction",
    ],
    [
      "planned described as working",
      "Assignees get email reminders every day.",
      [E.readmeEmail],
      "status_contradiction",
    ],
    [
      "partial claimed complete",
      "CSV export is complete.",
      [E.routeExport],
      "status_contradiction",
    ],
    [
      "complete claimed missing",
      "Creating tasks is not implemented yet.",
      [E.routeCreate],
      "status_contradiction",
    ],
    // Asserting checks that failed or were skipped.
    ["failed tests asserted", "All tests pass.", [E.tests], "skipped_check_asserted"],
    ["counted tests asserted", "All 4 tests pass.", [E.tests], "skipped_check_asserted"],
    ["skipped lint asserted", "The code lints cleanly.", [E.manifest], "skipped_check_asserted"],
    [
      "failed audit asserted",
      "Dependencies have no known vulnerabilities.",
      [E.advisory],
      "skipped_check_asserted",
    ],
    ["failed secrets asserted", "No secrets were found.", [E.secret], "skipped_check_asserted"],
  ];
  it.each(cases)("%s: %s", (_name, text, cite, reason) => {
    const v = claim(text, ...cite);
    expect(v.verified, JSON.stringify(v)).toBe(false);
    if (!v.verified) expect(v.reason).toBe(reason);
  });

  it("drops 100 % of the suite", () => {
    const dropped = cases.filter(([, text, cite]) => !claim(text, ...cite).verified).length;
    expect(dropped / cases.length).toBe(1);
  });

  it("does not trust a check it has no outcome for", () => {
    const v = verifyClaim(
      { text: "The build succeeds.", evidence_ids: [E.manifest.id] },
      { ...ctx, checks: {} },
    );
    expect(v).toMatchObject({ verified: false, reason: "skipped_check_asserted" });
  });
});
