import { PULSE_CODES } from "@codesentra/core";
import { describe, expect, it } from "vitest";
import { issueTitle, type PromptContext, renderPrompt } from "./index.js";

const hints = {
  env_var: "Platform → Settings → Environment Variables",
  access_protection: "Platform → Deployment Protection",
  production_domain: "Platform → Domains",
  redirects: "Platform → Redirects",
  headers: "Platform → Headers",
};

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    code: "UNDEFINED_IN_URL",
    title: "Request URL contains an undefined value",
    severity: "error",
    locator: "https://shop.example.com/undefined/api/ping",
    message:
      'The page requested https://shop.example.com/undefined/api/ping: the path contains "undefined".',
    corroborating: [
      {
        code: "SAME_ORIGIN_FAILURE",
        message: "Same-origin GET /undefined/api/ping returned HTTP 404.",
      },
    ],
    evidence: [
      {
        kind: "browser_request",
        locator: "https://shop.example.com/undefined/api/ping",
        payload: {
          url: "https://shop.example.com/undefined/api/ping",
          method: "GET",
          status: 404,
          page: "https://shop.example.com/",
        },
      },
    ],
    hasVerifiedTrace: false,
    platform: { name: "vercel", environment: "production", reason: "project vercel.app domain" },
    hints,
    target: { url: "https://shop.example.com/", environment: "production" },
    project: { name: "Shop", repoUrl: null },
    lastSuccessfulCheck: null,
    scanSummary: null,
    ...over,
  };
}

describe("renderPrompt", () => {
  it("renders a prompt for every Pulse code (Rule 4)", () => {
    for (const code of PULSE_CODES) {
      const p = renderPrompt(
        ctx({
          code,
          title: code,
          discriminator: code === "MISSING_SECURITY_HEADER" ? "Strict-Transport-Security" : null,
        }),
      );
      expect(p.body.length, code).toBeGreaterThan(200);
      expect(p.body, code).toContain("How CodeSentra will confirm the fix");
      expect(p.body, code).toContain("https://shop.example.com/");
      expect(p.templateVersion).toMatch(/@\d+$/);
    }
  });

  it("labels untraced code findings as unconfirmed leads with literal searches", () => {
    const p = renderPrompt(ctx());
    expect(p.type).toBe("investigate");
    expect(p.body).toContain("Unconfirmed lead");
    expect(p.body).toContain('git grep -n -F "/api/ping"');
    expect(p.body).toContain("Platform → Settings → Environment Variables");
    expect(p.body).toContain("SAME_ORIGIN_FAILURE");
    expect(p.body).toContain(
      "expects: _no request matching https://shop.example.com/undefined/api/ping_",
    );
  });

  it("builds an outage triage with the failed hop and the ordered checklist", () => {
    const p = renderPrompt(
      ctx({
        code: "TLS_INVALID",
        locator: "https://shop.example.com/",
        message: "TLS certificate rejected: CERT_HAS_EXPIRED",
        corroborating: [],
        evidence: [
          {
            kind: "http_response",
            locator: "https://shop.example.com/",
            payload: {
              url: "https://shop.example.com/",
              error: "tls_invalid",
              message: "TLS certificate rejected: CERT_HAS_EXPIRED",
              tls: {
                authorized: false,
                error: "CERT_HAS_EXPIRED",
                subject: "shop.example.com",
                issuer: "R3",
                valid_to: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        ],
      }),
    );
    expect(p.type).toBe("outage_triage");
    expect(p.body).toMatch(
      /1\. \*\*Deploy logs\*\*[\s\S]*2\. \*\*Build output\*\*[\s\S]*3\. \*\*DNS records\*\*[\s\S]*4\. \*\*Certificate\*\*.*← the observation points here first[\s\S]*5\. \*\*Runtime logs\*\*/,
    );
    expect(p.body).toContain("CERT_HAS_EXPIRED");
    expect(p.body).toContain("Last successful check of this target: none recorded");
    expect(p.body).toContain("No Scan has run for this project yet");
  });

  it("names the setting, where to change it and the value shape for config fixes", () => {
    const p = renderPrompt(
      ctx({
        code: "MISSING_SECURITY_HEADER",
        discriminator: "Strict-Transport-Security",
        locator: "https://shop.example.com/",
        corroborating: [],
      }),
    );
    expect(p.type).toBe("config_fix");
    expect(p.body).toContain("Response header Strict-Transport-Security");
    expect(p.body).toContain("Platform → Headers");
    expect(p.body).toContain("max-age=63072000");
  });

  it("is deterministic", () => {
    expect(renderPrompt(ctx())).toEqual(renderPrompt(ctx()));
  });

  it("refuses code_fix without a trace", () => {
    expect(() => renderPrompt(ctx({ hasVerifiedTrace: true }))).toThrow(/verified trace/);
  });
});

describe("issueTitle", () => {
  it("uses the code title plus where or what", () => {
    expect(issueTitle("ROUTE_BROKEN", "https://shop.dev/pricing")).toBe(
      "Route returns an error — shop.dev/pricing",
    );
    expect(issueTitle("UNCAUGHT_EXCEPTION", "https://shop.dev/", "CS_FIXTURE_BOOM")).toBe(
      "Uncaught exception: CS_FIXTURE_BOOM",
    );
  });
});
