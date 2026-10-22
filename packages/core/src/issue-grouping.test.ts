import { describe, expect, it } from "vitest";
import { groupFindings, recheckFor } from "./issue-grouping.js";

describe("groupFindings", () => {
  it("merges findings that share evidence, led by the more specific code", () => {
    const groups = groupFindings([
      { code: "SAME_ORIGIN_FAILURE" as const, evidenceKey: "req1" },
      { code: "UNDEFINED_IN_URL" as const, evidenceKey: "req1" },
      { code: "MISSING_SECURITY_HEADER" as const, evidenceKey: "hdr" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.leader.code).toBe("UNDEFINED_IN_URL");
    expect(groups[0]?.members.map((m) => m.code)).toEqual([
      "UNDEFINED_IN_URL",
      "SAME_ORIGIN_FAILURE",
    ]);
  });

  it("never merges console errors that only share a page", () => {
    const groups = groupFindings([
      { code: "CONSOLE_ERROR" as const, evidenceKey: "c1" },
      { code: "CONSOLE_ERROR" as const, evidenceKey: "c2" },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("recheckFor", () => {
  it("fills the expectation from the code's declaration", () => {
    expect(
      recheckFor("UNDEFINED_IN_URL", "https://x.dev/undefined/api/ping", "https://x.dev/"),
    ).toEqual({
      module: "pulse",
      check_group: "render",
      target: "https://x.dev/",
      expectation: "no request matching https://x.dev/undefined/api/ping",
    });
  });
});
