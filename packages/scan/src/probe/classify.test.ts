import { describe, expect, it } from "vitest";
import { classifyFetchFailure } from "./classify.js";

/** Real tool output captured from each kind of download/install failure (ADR 0030, F-05). */
const INFRA: [string, string, number | null][] = [
  [
    "egress proxy denies the host",
    "npm error code E403\nnpm error 403 Forbidden - GET https://registry.npmjs.org/left-pad",
    1,
  ],
  ["DNS failure", "npm error network getaddrinfo EAI_AGAIN registry.npmjs.org", 1],
  ["connection refused", "Error: connect ECONNREFUSED 10.0.0.2:443", 1],
  [
    "pnpm meta fetch",
    " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/is-number: request to ... failed, reason: socket hang up",
    1,
  ],
  ["registry 503", "npm error 503 Service Unavailable - GET https://registry.npmjs.org/x", 1],
  [
    "rate limited",
    'error An unexpected error occurred: "https://registry.yarnpkg.com/x: 429 Too Many Requests".',
    1,
  ],
  [
    "tls intercept",
    "npm error request to https://registry.npmjs.org/x failed, reason: self-signed certificate in certificate chain",
    1,
  ],
  ["killed, no code", "Downloading ...", null],
];
const DEPENDENCY: [string, string, number | null][] = [
  [
    "version does not exist",
    " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for is-number@99.0.0",
    1,
  ],
  [
    "npm ETARGET",
    "npm error code ETARGET\nnpm error notarget No matching version found for left-pad@99.0.0",
    1,
  ],
  ["integrity mismatch", " ERR_PNPM_TARBALL_INTEGRITY  Got unexpected checksum for is-number", 1],
  ["npm EINTEGRITY", "npm error code EINTEGRITY\nnpm error sha512 integrity check failed", 1],
  [
    "lockfile out of date",
    ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date',
    1,
  ],
  [
    "npm ci out of sync",
    "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync",
    1,
  ],
  ["eresolve", "npm error code ERESOLVE\nnpm error unable to resolve dependency tree", 1],
];

describe("download/install failure classification (ADR 0030, F-05)", () => {
  it("treats network and environment failures as a coverage gap", () => {
    for (const [name, out, code] of INFRA) {
      const v = classifyFetchFailure(out, code, false);
      expect(v.kind, name).toBe("infra");
      expect(v.reason, name).toBeTruthy();
    }
  });
  it("treats a timeout as a gap", () => {
    expect(classifyFetchFailure("", null, true).kind).toBe("infra");
  });
  it("treats manifest and lockfile errors as a real dependency failure, with the tool's message", () => {
    for (const [name, out, code] of DEPENDENCY) {
      const v = classifyFetchFailure(out, code, false);
      expect(v.kind, name).toBe("dependency");
      expect(out, name).toContain(v.reason.slice(0, 20).trim().split("\n")[0]);
    }
  });
  it("does not blame the project for an unrecognised failure", () => {
    const v = classifyFetchFailure("something went wrong\nsome other line", 1, false);
    expect(v.kind).toBe("infra");
    expect(v.reason).toMatch(/could not attribute/);
  });
});
