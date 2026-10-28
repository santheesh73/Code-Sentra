import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeGithubApp, startFakeGithubApp } from "@codesentra/fixture-harness";
import { GithubApp } from "@codesentra/github";
import { testPolicy } from "@codesentra/ssrf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneRepo, GitError, git } from "./git.js";

let gh: FakeGithubApp;
let app: GithubApp;
let first: string;
let second: string;

beforeAll(async () => {
  gh = await startFakeGithubApp();
  app = new GithubApp({
    appId: gh.appId,
    privateKey: gh.privateKeyPem,
    apiBaseUrl: gh.url,
    gitBaseUrl: gh.gitBaseUrl,
  });
  first = gh.gitCommit("acme/web", { "README.md": "v1\n" }, "first");
  second = gh.gitCommit("acme/web", { "README.md": "v2\n", "src/a.ts": "export {};\n" }, "second");
});
afterAll(() => gh?.close());

const dest = () => join(mkdtempSync(join(tmpdir(), "cs-ghclone-")), "tree");
const opts = { policy: testPolicy(["127.0.0.1"]), allowHttp: true };

describe("cloning a GitHub commit (ADR 0024)", () => {
  it("fetches exactly that commit, with history, using the installation token", async () => {
    const d = dest();
    const r = await cloneRepo(app.gitUrl("acme", "web"), d, {
      ...opts,
      commit: first,
      authorization: await app.gitAuthorization(7),
    });
    expect(r.commitSha).toBe(first);
    expect(readFileSync(join(d, "README.md"), "utf8")).toBe("v1\n");
    const d2 = dest();
    await cloneRepo(app.gitUrl("acme", "web"), d2, {
      ...opts,
      commit: second,
      authorization: await app.gitAuthorization(7),
    });
    const { stdout } = await git(["rev-list", "--count", "HEAD"], { cwd: d2 });
    expect(stdout.trim()).toBe("2");
  });

  it("is refused without the token, and an unknown commit is reported as such", async () => {
    await expect(
      cloneRepo(app.gitUrl("acme", "web"), dest(), { ...opts, commit: first }),
    ).rejects.toBeInstanceOf(GitError);
    await expect(
      cloneRepo(app.gitUrl("acme", "web"), dest(), {
        ...opts,
        commit: "f".repeat(40),
        authorization: await app.gitAuthorization(7),
      }),
    ).rejects.toMatchObject({ code: "ref_not_found" });
    await expect(
      cloneRepo(app.gitUrl("acme", "web"), dest(), { ...opts, commit: "not-a-sha" }),
    ).rejects.toMatchObject({ code: "invalid_url" });
  });
});
