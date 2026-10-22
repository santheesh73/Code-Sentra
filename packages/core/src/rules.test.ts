import { describe, expect, it } from "vitest";
import type { PulseCheckGroup } from "./enums.js";
import { nextIssueStatus } from "./issue-lifecycle.js";
import { type CheckGroupOutcome, computePulseStatus } from "./pulse-status.js";
import { ReportDraftSchema } from "./report.js";
import { deriveRunStatus } from "./run-status.js";

const ALL: PulseCheckGroup[] = ["reachability", "platform", "render", "routes", "hygiene"];
const allRan = (): CheckGroupOutcome[] => ALL.map((group) => ({ group, ran: true }));

describe("computePulseStatus", () => {
  it("is down when the main URL fails, regardless of other inputs", () => {
    for (const failure of [
      "dns",
      "tls_invalid",
      "timeout",
      "server_error",
      "connection",
    ] as const) {
      expect(
        computePulseStatus({ main: { reachable: false, failure }, groups: allRan(), findings: [] })
          .status,
      ).toBe("down");
    }
  });

  it("is down on redirect loops and over-long chains", () => {
    for (const failure of ["redirect_loop", "too_many_redirects"] as const) {
      expect(
        computePulseStatus({ main: { reachable: false, failure }, groups: allRan(), findings: [] })
          .status,
      ).toBe("down");
    }
  });

  it("is unverified, not down, when the target was refused by the SSRF policy", () => {
    const r = computePulseStatus({
      main: { reachable: false, failure: "blocked" },
      groups: [],
      findings: [],
    });
    expect(r.status).toBe("unverified");
    expect(r.gaps[0]?.reason).toMatch(/non-public address/);
  });

  it("reports one reachability gap when the group already recorded why it was skipped", () => {
    const r = computePulseStatus({
      main: { reachable: false, failure: "blocked" },
      groups: [{ group: "reachability", ran: false, gapReason: "refused by policy" }],
      findings: [],
    });
    expect(r.gaps).toEqual([{ group: "reachability", reason: "refused by policy" }]);
  });

  it("is down on a 5xx main response", () => {
    expect(
      computePulseStatus({ main: { reachable: true, status: 503 }, groups: allRan(), findings: [] })
        .status,
    ).toBe("down");
  });

  it("is degraded with any error finding", () => {
    const r = computePulseStatus({
      main: { reachable: true, status: 200 },
      groups: allRan(),
      findings: [{ severity: "warning" }, { severity: "error" }],
    });
    expect(r.status).toBe("degraded");
  });

  it("is degraded even if a group was skipped, when an error was found", () => {
    const groups = allRan();
    groups[2] = { group: "render", ran: false, gapReason: "browser unavailable" };
    const r = computePulseStatus({
      main: { reachable: true, status: 200 },
      groups,
      findings: [{ severity: "error" }],
    });
    expect(r.status).toBe("degraded");
    expect(r.gaps).toEqual([{ group: "render", reason: "browser unavailable" }]);
  });

  it("is live only when every group ran and no errors", () => {
    const r = computePulseStatus({
      main: { reachable: true, status: 200 },
      groups: allRan(),
      findings: [{ severity: "warning" }, { severity: "info" }],
    });
    expect(r).toEqual({ status: "live", gaps: [] });
  });

  it("is unverified when a group did not run, and names the gap", () => {
    const groups = allRan();
    groups[2] = { group: "render", ran: false, gapReason: "Playwright not installed" };
    const r = computePulseStatus({ main: { reachable: true, status: 200 }, groups, findings: [] });
    expect(r.status).toBe("unverified");
    expect(r.gaps).toEqual([{ group: "render", reason: "Playwright not installed" }]);
  });

  it("never reports a skipped group without a reason", () => {
    const groups = allRan();
    groups[3] = { group: "routes", ran: false };
    const r = computePulseStatus({ main: { reachable: true, status: 200 }, groups, findings: [] });
    expect(r.status).toBe("unverified");
    expect(r.gaps[0]?.reason).toMatch(/no reason recorded/);
  });

  it("is unverified (not live) when no groups were recorded", () => {
    const r = computePulseStatus({
      main: { reachable: true, status: 200 },
      groups: [],
      findings: [],
    });
    expect(r.status).toBe("unverified");
  });
});

describe("nextIssueStatus", () => {
  it("resolves an open issue only when the check ran and the problem was not observed", () => {
    expect(nextIssueStatus("open", { checkGroupRan: true, observed: false })).toEqual({
      status: "resolved",
      event: "resolved",
    });
  });

  it("never resolves on a skipped check", () => {
    expect(nextIssueStatus("open", { checkGroupRan: false, observed: false })).toEqual({
      status: "open",
      event: null,
    });
    expect(nextIssueStatus("regressed", { checkGroupRan: false, observed: false }).status).toBe(
      "regressed",
    );
  });

  it("records a sighting on open issues", () => {
    expect(nextIssueStatus("open", { checkGroupRan: true, observed: true })).toEqual({
      status: "open",
      event: "seen",
    });
  });

  it("regresses a resolved issue when seen again", () => {
    expect(nextIssueStatus("resolved", { checkGroupRan: true, observed: true })).toEqual({
      status: "regressed",
      event: "regressed",
    });
  });

  it("resolves a regressed issue once fixed again", () => {
    expect(nextIssueStatus("regressed", { checkGroupRan: true, observed: false }).status).toBe(
      "resolved",
    );
  });

  it("leaves dismissed issues alone", () => {
    expect(nextIssueStatus("dismissed", { checkGroupRan: true, observed: true })).toEqual({
      status: "dismissed",
      event: null,
    });
  });
});

describe("ReportDraftSchema", () => {
  it("accepts a well-formed draft and rejects malformed evidence ids", () => {
    const id = "6f1c1a5e-2b7d-4f7e-9a49-0d6f8f9f6a11";
    const ok = ReportDraftSchema.safeParse({
      summary: [{ text: "A Next.js app.", evidence_ids: [id] }],
      value: [],
      features: [],
      issues: [],
      remaining: [],
    });
    expect(ok.success).toBe(true);
    const bad = ReportDraftSchema.safeParse({
      summary: [{ text: "x", evidence_ids: ["not-a-uuid"] }],
      value: [],
      features: [],
      issues: [],
      remaining: [],
    });
    expect(bad.success).toBe(false);
  });
});

describe("deriveRunStatus", () => {
  it("fails on any failed step", () => {
    expect(deriveRunStatus([{ status: "done" }, { status: "failed" }, { status: "skipped" }])).toBe(
      "failed",
    );
  });
  it("is partial when a step was skipped, never succeeded", () => {
    expect(deriveRunStatus([{ status: "done" }, { status: "skipped" }])).toBe("partial");
  });
  it("succeeds only when every step is done", () => {
    expect(deriveRunStatus([{ status: "done" }, { status: "done" }])).toBe("succeeded");
  });
  it("fails a run with no steps", () => {
    expect(deriveRunStatus([])).toBe("failed");
  });
  it("refuses unfinished steps", () => {
    expect(() => deriveRunStatus([{ status: "running" }])).toThrow();
  });
});
