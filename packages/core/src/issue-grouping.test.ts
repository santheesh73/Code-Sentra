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

  it("keeps same-code findings on shared evidence as separate issues", () => {
    const groups = groupFindings([
      {
        code: "MISSING_SECURITY_HEADER" as const,
        evidenceKey: "resp",
        d: "Content-Security-Policy",
      },
      { code: "MISSING_SECURITY_HEADER" as const, evidenceKey: "resp", d: "X-Frame-Options" },
      { code: "UNDEFINED_IN_URL" as const, evidenceKey: "req", d: "a" },
      { code: "SAME_ORIGIN_FAILURE" as const, evidenceKey: "req", d: "b" },
      { code: "UNDEFINED_IN_URL" as const, evidenceKey: "req", d: "c" },
    ]);
    expect(groups.map((g) => g.members.map((m) => m.d))).toEqual([
      ["Content-Security-Policy"],
      ["X-Frame-Options"],
      ["a", "b"],
      ["c"],
    ]);
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

  it("names the discriminator where the declaration asks for it", () => {
    expect(
      recheckFor(
        "MISSING_SECURITY_HEADER",
        "https://x.dev/",
        "https://x.dev/",
        "Strict-Transport-Security",
      ).expectation,
    ).toBe("the response from https://x.dev/ sets Strict-Transport-Security");
  });

  it("names the env var, test or message rather than the place it was seen", () => {
    expect(
      recheckFor("ENV_VAR_UNDOCUMENTED", "app/page.tsx:9", "", "NEXT_PUBLIC_API_URL").expectation,
    ).toBe("NEXT_PUBLIC_API_URL is documented in .env.example or docs");
    expect(
      recheckFor(
        "CONSOLE_ERROR",
        "https://x.dev/",
        "https://x.dev/",
        `TypeError: a\n${"x".repeat(9)}`,
      ).expectation,
    ).toBe('https://x.dev/ logs no console error "TypeError: a"');
    expect(
      recheckFor("UNCAUGHT_EXCEPTION", "https://x.dev/", "https://x.dev/", "y".repeat(300))
        .expectation,
    ).toBe(`https://x.dev/ throws no uncaught "${"y".repeat(119)}…"`);
  });
});
