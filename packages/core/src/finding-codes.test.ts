import { describe, expect, it } from "vitest";
import {
  FINDING_CODE_DECLARATIONS,
  FindingCode,
  PULSE_CODES,
  promptTypeFor,
  SCAN_CODES,
} from "./finding-codes.js";

describe("finding code declarations", () => {
  it("declares every code exactly once", () => {
    const all = [...SCAN_CODES, ...PULSE_CODES];
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(FINDING_CODE_DECLARATIONS).sort()).toEqual([...all].sort());
  });

  it("assigns module consistently with the code list", () => {
    for (const c of SCAN_CODES) expect(FINDING_CODE_DECLARATIONS[c].module).toBe("scan");
    for (const c of PULSE_CODES) expect(FINDING_CODE_DECLARATIONS[c].module).toBe("pulse");
  });

  it("re-check descriptors target the raising module", () => {
    for (const code of FindingCode.options) {
      const d = FINDING_CODE_DECLARATIONS[code];
      expect(d.recheck.module).toBe(d.module);
      expect(d.recheck.expectation.length).toBeGreaterThan(0);
      expect(d.title.length).toBeGreaterThan(0);
    }
  });

  it("maps outage codes to outage_triage (Section 10c)", () => {
    for (const code of [
      "DOWN",
      "DNS_FAILURE",
      "TLS_INVALID",
      "TLS_EXPIRING",
      "TIMEOUT",
      "SERVER_ERROR",
      "BUILD_FAILED",
    ] as const) {
      expect(FINDING_CODE_DECLARATIONS[code].promptType).toBe("outage_triage");
    }
  });

  it("maps config problems to config_fix", () => {
    expect(FINDING_CODE_DECLARATIONS.ACCESS_PROTECTED.promptType).toBe("config_fix");
    expect(FINDING_CODE_DECLARATIONS.PREVIEW_SERVED_AS_PROD.promptType).toBe("config_fix");
  });

  it("falls back to investigate for traceable Pulse codes without a verified trace", () => {
    expect(promptTypeFor("UNDEFINED_IN_URL", true)).toBe("code_fix");
    expect(promptTypeFor("UNDEFINED_IN_URL", false)).toBe("investigate");
    expect(promptTypeFor("LOCALHOST_CALL", false)).toBe("investigate");
  });

  it("never falls back for codes that carry their own location", () => {
    expect(promptTypeFor("TODO_MARKER", false)).toBe("code_fix");
    expect(promptTypeFor("DOWN", false)).toBe("outage_triage");
  });

  it("UNDEFINED_IN_URL leads SAME_ORIGIN_FAILURE when merged", () => {
    expect(FINDING_CODE_DECLARATIONS.UNDEFINED_IN_URL.specificity).toBeGreaterThan(
      FINDING_CODE_DECLARATIONS.SAME_ORIGIN_FAILURE.specificity,
    );
  });

  it("every code yields a prompt type in both trace states (Rule 4)", () => {
    for (const code of FindingCode.options) {
      expect(promptTypeFor(code, true)).toBeTruthy();
      expect(promptTypeFor(code, false)).toBeTruthy();
    }
  });
});
