import { createHmac } from "node:crypto";
import { type FakeGithubApp, startFakeGithubApp } from "@codesentra/fixture-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GithubApp, verifyWebhookSignature } from "./app.js";
import { conclusionFor, PullRequestEvent } from "./webhooks.js";

let gh: FakeGithubApp;
let app: GithubApp;
const A = "a".repeat(40);
const B = "b".repeat(40);

beforeAll(async () => {
  gh = await startFakeGithubApp();
  app = new GithubApp({ appId: gh.appId, privateKey: gh.privateKeyPem, apiBaseUrl: gh.url });
  gh.commit("acme/board", A, { "app/page.tsx": "one", "README.md": "r" });
  gh.commit("acme/board", B, { "app/page.tsx": "two", "README.md": "r", "lib/new.ts": "n" });
});
afterAll(async () => gh?.close());

describe("webhook signatures", () => {
  const secret = "s3cret-s3cret-s3cret";
  const body = Buffer.from('{"action":"opened"}');
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts the right signature only", () => {
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
    expect(verifyWebhookSignature(secret, Buffer.from('{"action":"closed"}'), sig)).toBe(false);
    expect(verifyWebhookSignature("another-secret-123", body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "sha1=abc")).toBe(false);
    expect(verifyWebhookSignature(secret, body, `${sig}0`)).toBe(false);
  });
});

describe("the App against a GitHub API", () => {
  it("gets an installation token with its JWT and caches it", async () => {
    const t1 = await app.installationToken(7);
    const t2 = await app.installationToken(7);
    expect(t1).toMatch(/^ghs_/);
    expect(t2).toBe(t1);
    expect(gh.calls.filter((c) => c === "POST /app/installations/7/access_tokens")).toHaveLength(1);
  });

  it("is refused with a JWT from another key", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const bad = new GithubApp({ appId: gh.appId, privateKey: other, apiBaseUrl: gh.url });
    await expect(bad.installationToken(7)).rejects.toThrow(/HTTP 401/);
  });

  it("creates and completes a check run", async () => {
    const { id } = await app.createCheckRun(7, "acme", "board", {
      name: "CodeSentra",
      head_sha: B,
      status: "in_progress",
    });
    await app.updateCheckRun(7, "acme", "board", id, {
      status: "completed",
      conclusion: "failure",
      output: { title: "1 issue", summary: "x" },
    });
    expect(gh.checkRuns.find((r) => r.id === id)).toMatchObject({
      name: "CodeSentra",
      head_sha: B,
      status: "completed",
      conclusion: "failure",
    });
  });

  it("lists a PR's changed files and downloads the zipball through the redirect", async () => {
    expect(await app.changedFiles(7, "acme", "board", A, B)).toEqual([
      "app/page.tsx",
      "lib/new.ts",
    ]);
    const zip = await app.zipball(7, "acme", "board", B, 10_000_000);
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    await expect(app.zipball(7, "acme", "board", B, 10)).rejects.toThrow(/exceeds/);
  });

  it("verifies who installed it through the user's own token, never the callback alone", async () => {
    const withClient = new GithubApp({
      appId: gh.appId,
      privateKey: gh.privateKeyPem,
      apiBaseUrl: gh.url,
      oauthBaseUrl: gh.url,
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
    });
    gh.authorize("code-1", [7]);
    expect(await withClient.userCanAccessInstallation("code-1", 7)).toBe(true);
    gh.authorize("code-2", [7]);
    expect(await withClient.userCanAccessInstallation("code-2", 8)).toBe(false);
    expect(await withClient.userCanAccessInstallation("forged", 7)).toBe(false);
    // A code is single use.
    expect(await withClient.userCanAccessInstallation("code-1", 7)).toBe(false);
  });

  it("refuses names and refs that are not GitHub's", async () => {
    await expect(app.changedFiles(7, "acme", "../x", A, B)).rejects.toThrow(/bad repository/);
    await expect(app.zipball(7, "acme", "board", "a b", 10)).rejects.toThrow(/bad ref/);
  });
});

describe("webhook payloads and the conclusion rule", () => {
  it("validates a pull_request delivery", () => {
    const ok = PullRequestEvent.safeParse({
      action: "opened",
      number: 3,
      pull_request: { head: { sha: B, ref: "fix" }, base: { sha: A, ref: "main" } },
      repository: { full_name: "acme/board" },
      installation: { id: 7 },
    });
    expect(ok.success).toBe(true);
    expect(
      PullRequestEvent.safeParse({ action: "opened", number: 3, repository: {}, installation: {} })
        .success,
    ).toBe(false);
  });

  it("fails on down/degraded or new errors, is neutral when unverified, else succeeds", () => {
    expect(conclusionFor("degraded", 0)).toBe("failure");
    expect(conclusionFor("down", 0)).toBe("failure");
    expect(conclusionFor("unverified", 0)).toBe("neutral");
    expect(conclusionFor("live", 0)).toBe("success");
    expect(conclusionFor(null, 1)).toBe("failure");
    expect(conclusionFor(null, 0)).toBe("success");
  });
});
