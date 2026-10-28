import { describe, expect, it } from "vitest";
import { checkRunReport } from "./check-run.js";

const issue = {
  title: "The page requests /undefined/api/ping",
  code: "UNDEFINED_IN_URL",
  severity: "error" as const,
  location: "app/page.tsx:9",
  promptType: "code_fix",
  prompt: "Set NEXT_PUBLIC_API_URL at build time.",
};
const base = {
  deploymentUrl: null,
  atRisk: [],
  changedFiles: ["app/page.tsx"],
  gaps: [],
  runUrl: "https://app/runs/1",
};

describe("checkRunReport", () => {
  it("fails on a degraded deployment and carries each issue's prompt", () => {
    const r = checkRunReport({ ...base, pulseStatus: "degraded", newIssues: [issue] });
    expect(r.conclusion).toBe("failure");
    expect(r.title).toBe("Degraded · 1 new issue");
    expect(r.text).toContain("🔴 The page requests /undefined/api/ping");
    expect(r.text).toContain("`UNDEFINED_IN_URL` at `app/page.tsx:9` · prompt: code_fix");
    expect(r.text).toContain("Set NEXT_PUBLIC_API_URL at build time.");
  });

  it("is neutral when checks did not run, success when live and clean", () => {
    expect(checkRunReport({ ...base, pulseStatus: "unverified", newIssues: [] }).conclusion).toBe(
      "neutral",
    );
    const ok = checkRunReport({ ...base, pulseStatus: "live", newIssues: [] });
    expect(ok.conclusion).toBe("success");
    expect(ok.title).toBe("Live · no new issues");
  });

  it("fails on new error issues before any deployment, and says the deploy is unchecked", () => {
    const r = checkRunReport({ ...base, pulseStatus: null, newIssues: [issue] });
    expect(r.conclusion).toBe("failure");
    expect(r.summary).toContain("not checked yet");
  });

  it("caps the text under GitHub's limit", () => {
    const big = { ...issue, prompt: "x".repeat(70_000) };
    const r = checkRunReport({ ...base, pulseStatus: "live", newIssues: [big] });
    expect(r.text.length).toBeLessThan(65_535);
    expect(r.text).toContain("truncated");
  });
});
