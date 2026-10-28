import { describe, expect, it } from "vitest";
import { maskEmail, renderAlert } from "./alert.js";
import { isSlackWebhookUrl } from "./slack.js";

const issue = {
  title: "The page requests /undefined/api/ping",
  code: "UNDEFINED_IN_URL",
  severity: "error" as const,
  change: "opened" as const,
  location: "app/page.tsx:9",
  promptType: "code_fix",
  prompt: "Set NEXT_PUBLIC_API_URL <before> the build & redeploy.",
  url: "https://app.example/issues/1",
};

describe("renderAlert", () => {
  it("carries each issue's prompt in email text, HTML and Slack", () => {
    const a = renderAlert({
      projectName: "status-board",
      pulseStatus: "degraded",
      runUrl: "https://app.example/runs/9",
      issues: [
        issue,
        {
          ...issue,
          change: "regressed",
          severity: "warning",
          title: "Old bug",
          prompt: null,
          promptType: null,
        },
      ],
    });
    expect(a.subject).toBe("[CodeSentra] status-board: 1 new issue, 1 regressed · Degraded");
    expect(a.text).toContain("NEW ERROR The page requests /undefined/api/ping");
    expect(a.text).toContain("UNDEFINED_IN_URL at app/page.tsx:9");
    expect(a.text).toContain("Set NEXT_PUBLIC_API_URL <before> the build & redeploy.");
    expect(a.text).toContain("REGRESSED WARNING Old bug");
    // HTML and Slack escape what the prompt contains.
    expect(a.html).toContain("Set NEXT_PUBLIC_API_URL &lt;before&gt; the build &amp; redeploy.");
    expect(a.html).not.toContain("<before>");
    const slack = JSON.stringify(a.slack.blocks);
    expect(slack).toContain("&lt;before&gt; the build &amp; redeploy.");
    expect(slack).toContain("<https://app.example/issues/1|The page requests /undefined/api/ping>");
  });

  it("clips long prompts for Slack and caps the issue list", () => {
    const many = Array.from({ length: 25 }, (_, n) => ({
      ...issue,
      title: `Issue ${n}`,
      prompt: "x".repeat(4000),
    }));
    const a = renderAlert({
      projectName: "p",
      pulseStatus: null,
      runUrl: "https://r",
      issues: many,
    });
    expect(a.text).toContain("…and 5 more");
    expect(a.slack.blocks.length).toBeLessThanOrEqual(50);
    for (const b of a.slack.blocks as { text?: { text: string } }[])
      expect(b.text?.text.length ?? 0).toBeLessThanOrEqual(3000);
  });
});

describe("helpers", () => {
  it("masks addresses and accepts only Slack's webhook host", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(isSlackWebhookUrl("https://hooks.slack.com/services/T/B/x")).toBe(true);
    for (const bad of [
      "http://hooks.slack.com/services/T",
      "https://hooks.slack.com.evil.io/services/T",
      "https://169.254.169.254/services/x",
      "https://hooks.slack.com/other",
    ])
      expect(isSlackWebhookUrl(bad), bad).toBe(false);
    expect(isSlackWebhookUrl("http://127.0.0.1:9/hooks/x", new Set(["127.0.0.1"]))).toBe(true);
  });
});
