/**
 * Health score (Section 8a): 0–100, deterministic. A component that could not be measured
 * is excluded and the remaining weights are renormalized; the breakdown says which, and
 * every deduction lists its evidence.
 */
export type ProbeOutcome = "pass" | "fail" | "timeout" | "not_applicable" | "skipped";
export type AdvisorySeverity = "critical" | "high" | "moderate" | "low" | "unknown";

export interface HealthInput {
  install: { outcome: ProbeOutcome; evidence: string[] };
  build: { outcome: ProbeOutcome; evidence: string[] };
  tests: {
    outcome: ProbeOutcome;
    pass: number;
    fail: number;
    testsFound: number;
    evidence: string[];
  };
  typecheck: { outcome: ProbeOutcome; evidence: string[] };
  lint: { outcome: ProbeOutcome; evidence: string[] };
  /** null when no audit ran (no lockfile or no data). */
  vulnerable: { severity: AdvisorySeverity; evidence: string }[] | null;
  /** null when the secrets scan did not run. */
  secrets: { evidence: string }[] | null;
  readme: { present: boolean; evidence: string[] };
  envVars: { read: number; undocumented: { evidence: string }[] };
  setupSteps: { present: boolean; evidence: string[] };
  markers: { count: number; sourceLines: number; evidence: string[] };
  /** null without git history. */
  hotspots: { count: number; files: number; evidence: string[] } | null;
}

export interface HealthDeduction {
  reason: string;
  points: number;
  evidence: string[];
}

export interface HealthComponent {
  component: "build" | "tests" | "security" | "configuration" | "maintainability";
  weight: number;
  measured: boolean;
  /** Why it was not measured, or which parts of it were not. */
  notMeasured: string[];
  /** 0–1 share of the component's marks earned. */
  ratio: number;
  deductions: HealthDeduction[];
}

export interface HealthScore {
  score: number | null;
  components: HealthComponent[];
  excluded: string[];
}

interface Part {
  name: string;
  /** null = not measurable. */
  ratio: number | null;
  why?: string;
  deduction?: HealthDeduction;
}

const ran = (o: ProbeOutcome) => o === "pass" || o === "fail" || o === "timeout";

function component(
  name: HealthComponent["component"],
  weight: number,
  parts: Part[],
): HealthComponent {
  const measured = parts.filter((p) => p.ratio !== null);
  const notMeasured = parts
    .filter((p) => p.ratio === null)
    .map((p) => `${p.name}: ${p.why ?? "not measured"}`);
  const ratio = measured.length
    ? measured.reduce((a, p) => a + (p.ratio as number), 0) / measured.length
    : 0;
  return {
    component: name,
    weight,
    measured: measured.length > 0,
    notMeasured,
    ratio: Math.round(ratio * 1000) / 1000,
    deductions: measured
      .map((p) => p.deduction)
      .filter((d): d is HealthDeduction => !!d && d.points > 0),
  };
}

const SEVERITY_COST: Record<AdvisorySeverity, number> = {
  critical: 10,
  high: 6,
  moderate: 3,
  low: 1,
  unknown: 3,
};
const SECRET_COST = 8;

export function computeHealth(i: HealthInput): HealthScore {
  const pts = (w: number, r: number) => Math.round(w * (1 - r) * 10) / 10;

  // Build (20): install + build succeed.
  const installOk = i.install.outcome === "pass";
  const buildOk = i.build.outcome === "pass" || i.build.outcome === "not_applicable";
  const buildParts: Part[] = [];
  if (!ran(i.install.outcome))
    buildParts.push({ name: "install", ratio: null, why: `install ${i.install.outcome}` });
  else
    buildParts.push({
      name: "install",
      ratio: installOk ? 1 : 0,
      deduction: {
        reason: "dependency install failed",
        points: installOk ? 0 : 10,
        evidence: i.install.evidence,
      },
    });
  if (i.build.outcome === "skipped")
    buildParts.push({ name: "build", ratio: null, why: "build did not run" });
  else
    buildParts.push({
      name: "build",
      ratio: buildOk ? 1 : 0,
      deduction: { reason: "build failed", points: buildOk ? 0 : 10, evidence: i.build.evidence },
    });
  const build = component("build", 20, buildParts);

  // Tests (25): exist and all pass, scaled by pass ratio; 0 if none.
  const executed = i.tests.pass + i.tests.fail;
  let testsPart: Part;
  if (i.tests.testsFound === 0)
    testsPart = {
      name: "tests",
      ratio: 0,
      deduction: { reason: "no tests", points: 25, evidence: i.tests.evidence },
    };
  else if (!ran(i.tests.outcome) || (executed === 0 && i.tests.outcome !== "fail"))
    testsPart = {
      name: "tests",
      ratio: null,
      why: `tests ${i.tests.outcome === "pass" ? "ran but no results could be read" : i.tests.outcome}`,
    };
  else {
    const r = executed ? i.tests.pass / executed : 0;
    testsPart = {
      name: "tests",
      ratio: r,
      deduction: {
        reason: `${i.tests.fail} of ${executed} tests fail`,
        points: pts(25, r),
        evidence: i.tests.evidence,
      },
    };
  }
  const tests = component("tests", 25, [testsPart]);

  // Security (20): vulnerable dependencies (high/critical cost more) and exposed secrets.
  const secParts: Part[] = [];
  if (i.vulnerable === null)
    secParts.push({ name: "dependencies", ratio: null, why: "no dependency audit ran" });
  else {
    const cost = Math.min(
      20,
      i.vulnerable.reduce((a, v) => a + SEVERITY_COST[v.severity], 0),
    );
    secParts.push({
      name: "dependencies",
      ratio: 1 - cost / 20,
      deduction: {
        reason: `${i.vulnerable.length} vulnerable dependencies`,
        points: cost / 2,
        evidence: i.vulnerable.map((v) => v.evidence),
      },
    });
  }
  if (i.secrets === null)
    secParts.push({ name: "secrets", ratio: null, why: "secrets scan did not run" });
  else {
    const cost = Math.min(20, i.secrets.length * SECRET_COST);
    secParts.push({
      name: "secrets",
      ratio: 1 - cost / 20,
      deduction: {
        reason: `${i.secrets.length} exposed secrets`,
        points: cost / 2,
        evidence: i.secrets.map((s) => s.evidence),
      },
    });
  }
  const security = component("security", 20, secParts);

  // Configuration & docs (15): README, documented env vars, setup steps.
  const undocumented = i.envVars.undocumented.length;
  const envRatio = i.envVars.read ? 1 - undocumented / i.envVars.read : 1;
  const configuration = component("configuration", 15, [
    {
      name: "readme",
      ratio: i.readme.present ? 1 : 0,
      deduction: {
        reason: "no README",
        points: i.readme.present ? 0 : 5,
        evidence: i.readme.evidence,
      },
    },
    {
      name: "env_vars",
      ratio: envRatio,
      deduction: {
        reason: `${undocumented} of ${i.envVars.read} env vars read in code are undocumented`,
        points: pts(5, envRatio),
        evidence: i.envVars.undocumented.map((u) => u.evidence),
      },
    },
    {
      name: "setup",
      ratio: i.setupSteps.present ? 1 : 0,
      deduction: {
        reason: "no setup steps in the docs",
        points: i.setupSteps.present ? 0 : 5,
        evidence: i.setupSteps.evidence,
      },
    },
  ]);

  // Maintainability (20): typecheck/lint clean, few markers per KLOC, hotspots bounded.
  const check = (name: string, c: { outcome: ProbeOutcome; evidence: string[] }): Part =>
    ran(c.outcome)
      ? {
          name,
          ratio: c.outcome === "pass" ? 1 : 0,
          deduction: {
            reason: `${name} not clean`,
            points: c.outcome === "pass" ? 0 : 5,
            evidence: c.evidence,
          },
        }
      : {
          name,
          ratio: null,
          why: c.outcome === "not_applicable" ? "not applicable" : `${name} did not run`,
        };
  const kloc = Math.max(1, i.markers.sourceLines / 1000);
  const density = i.markers.count / kloc;
  const markerRatio = Math.max(0, 1 - density / 10);
  const hot = i.hotspots;
  const hotRatio = hot
    ? Math.max(0, 1 - Math.max(0, hot.count / Math.max(1, hot.files) - 0.05) * 10)
    : null;
  const maintainability = component("maintainability", 20, [
    check("typecheck", i.typecheck),
    check("lint", i.lint),
    {
      name: "markers",
      ratio: markerRatio,
      deduction: {
        reason: `${i.markers.count} TODO/FIXME/stub markers (${density.toFixed(1)} per KLOC)`,
        points: pts(5, markerRatio),
        evidence: i.markers.evidence,
      },
    },
    hot
      ? {
          name: "hotspots",
          ratio: hotRatio,
          deduction: {
            reason: `${hot.count} hotspots`,
            points: pts(5, hotRatio ?? 1),
            evidence: hot.evidence,
          },
        }
      : { name: "hotspots", ratio: null, why: "no git history" },
  ]);

  const components = [build, tests, security, configuration, maintainability];
  const measured = components.filter((c) => c.measured);
  const total = measured.reduce((a, c) => a + c.weight, 0);
  const score = total
    ? Math.round((measured.reduce((a, c) => a + c.weight * c.ratio, 0) / total) * 100)
    : null;
  return {
    score,
    components,
    excluded: components.filter((c) => !c.measured).map((c) => c.component),
  };
}
