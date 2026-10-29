import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureReportModel, loadFixtureRepos } from "@codesentra/fixture-harness";
import { createSandbox, type Sandbox } from "@codesentra/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offlineSource } from "./audit/osv.js";
import { listTree } from "./ingest/tree.js";
import type { ReportModel } from "./model.js";
import { runScan, type ScanResult } from "./pipeline.js";

/**
 * Phase 3 gate, package level: each fixture repo's scan matches its expected.json
 * (routes, env vars, probes, features with statuses, findings, absent findings), no
 * forbidden claim survives verification, and secret values are never stored. Real
 * sandbox, real gitleaks, the real OSV snapshot; the report model is the scripted
 * fixture model (ADR 0017), since statuses and claims are decided deterministically.
 */
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const IMAGE = process.env.SANDBOX_IMAGE ?? "codesentra/sandbox:test";
let sandbox: Sandbox;
const results = new Map<string, ScanResult>();
/** Everything each repo's scan sent to the report model (Section 17: no secrets to the LLM). */
const modelInputs = new Map<string, string[]>();
function recording(repo: string, m: ReportModel): ReportModel {
  const sent: string[] = [];
  modelInputs.set(repo, sent);
  return {
    name: m.name,
    proposeFeatures: (bundle) => {
      sent.push(JSON.stringify(bundle));
      return m.proposeFeatures(bundle);
    },
    draftReport: (input) => {
      sent.push(JSON.stringify(input));
      return m.draftReport(input);
    },
  };
}
const scratch: string[] = [];

beforeAll(async () => {
  if (!process.env.SANDBOX_IMAGE)
    execFileSync("docker", ["build", "-q", "-t", IMAGE, join(ROOT, "infra/sandbox")], {
      stdio: "pipe",
      timeout: 600_000,
    });
  sandbox = await createSandbox({
    network: process.env.SANDBOX_FETCH_NETWORK ?? "bridge",
    proxy: process.env.SANDBOX_FETCH_PROXY ?? null,
    caFile: process.env.SANDBOX_FETCH_CA_FILE ?? null,
  });
  const osv = await offlineSource(join(ROOT, "fixtures/osv"));
  for (const repo of loadFixtureRepos()) {
    const dir = mkdtempSync(join(tmpdir(), "cs-gate-"));
    scratch.push(dir);
    const tree = await listTree(repo.repoDir);
    results.set(
      repo.expected.name,
      await runScan({
        root: repo.repoDir,
        tree: tree.files,
        hasHistory: false,
        scratchDir: dir,
        sandbox: { sandbox, image: IMAGE },
        osv: { source: osv },
        secrets: { enabled: true },
        model: { model: recording(repo.expected.name, fixtureReportModel()) },
      }),
    );
  }
}, 30 * 60_000);
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const lineAt = (repoDir: string, locator: string) => {
  const [file, line] = locator.split(":");
  const text = readFileSync(join(repoDir, file as string), "utf8");
  return line ? (text.split("\n")[Number(line) - 1] ?? "") : text;
};

describe.each(loadFixtureRepos().map((r) => [r.expected.name, r] as const))(
  "Phase 3 gate: %s",
  (name, repo) => {
    const exp = repo.expected;
    const r = () => results.get(name) as ScanResult;

    it("maps languages, frameworks, package manager, routes and env vars", () => {
      expect(Object.keys(r().summary.languages)).toEqual(expect.arrayContaining(exp.languages));
      expect(r().summary.frameworks).toEqual(exp.frameworks);
      expect(r().summary.packageManager).toBe(exp.packageManager);
      for (const route of exp.routes) expect(r().summary.routes).toContainEqual(route);
      expect(r().summary.envVars.read).toEqual(exp.envVars.read.map((e) => e.name).sort());
      expect(r().summary.envVars.documented).toEqual([...exp.envVars.documented].sort());
      for (const e of exp.envVars.read)
        expect(
          r().evidence.some(
            (x) =>
              x.kind === "env_var_read" && x.locator === e.locator && x.payload.name === e.name,
          ),
          e.name,
        ).toBe(true);
    });

    it("probes as expected in the sandbox", () => {
      const by = Object.fromEntries((r().summary.probes?.results ?? []).map((p) => [p.name, p]));
      expect(by.install?.status).toBe(exp.probes.install);
      expect(by.build?.status).toBe(exp.probes.build);
      if (exp.probes.tests) expect(by.tests?.tests).toMatchObject(exp.probes.tests);
      else expect(by.tests?.status).toBe("skipped");
    });

    it("classifies every feature with its expected status", () => {
      const got = Object.fromEntries(r().features.map((f) => [f.name, f.status]));
      expect(got).toEqual(Object.fromEntries(exp.features.map((f) => [f.name, f.status])));
    });

    it("reports every expected finding at its exact locator", () => {
      for (const f of exp.findings) {
        const hit = r().findings.find((x) => x.code === f.code && x.locator === f.locator);
        expect(
          hit,
          `${f.code} at ${f.locator}; got ${r()
            .findings.filter((x) => x.code === f.code)
            .map((x) => x.locator)
            .join(", ")}`,
        ).toBeTruthy();
        if (f.lineContains) expect(lineAt(repo.repoDir, f.locator)).toContain(f.lineContains);
        const ev = r().evidence.find((e) => e.key === hit?.evidenceKey);
        if (f.code === "VULNERABLE_DEPENDENCY") {
          expect(ev?.payload.package).toBe(f.package);
          expect(ev?.payload.version).toBe(f.version);
          if (f.mustIncludeAdvisory)
            expect(JSON.stringify(ev?.payload)).toContain(f.mustIncludeAdvisory as string);
        }
        if (f.code === "SECRET_EXPOSED") expect(ev?.payload.type).toBe(f.secretType);
      }
    });

    it("raises none of the absent findings", () => {
      for (const code of exp.absentFindings)
        expect(
          r().findings.filter((f) => f.code === code),
          code,
        ).toEqual([]);
    });

    it("never stores a secret value", () => {
      for (const f of exp.findings.filter((x) => x.code === "SECRET_EXPOSED")) {
        const secret = f.storedPreviewMustNotContain as string;
        expect(JSON.stringify(r().evidence)).not.toContain(secret);
        expect(JSON.stringify(r().findings)).not.toContain(secret);
        expect(JSON.stringify(r().claims.filter((c) => c.verified))).not.toContain(secret);
        // ...and never reaches the model: the bundle is built from redacted evidence.
        const sent = modelInputs.get(name) ?? [];
        expect(sent.length).toBeGreaterThan(0);
        for (const input of sent) expect(input).not.toContain(secret);
      }
    });

    it("drops every forbidden claim and keeps the true ones", () => {
      const verified = r()
        .claims.filter((c) => c.verified)
        .map((c) => c.text);
      for (const c of exp.forbiddenClaims) {
        expect(verified, c.text).not.toContain(c.text);
        expect(r().claims.find((x) => x.text === c.text)?.verified).toBe(false);
      }
      const truthful = r().claims.filter(
        (c) => !exp.forbiddenClaims.some((f) => f.text === c.text),
      );
      expect(
        truthful
          .filter((c) => !c.verified)
          .map((c) => `${c.text} → ${c.dropReason}: ${c.dropDetail}`),
      ).toEqual([]);
      expect(truthful.length).toBeGreaterThan(exp.features.length);
    });

    it("scores health deterministically and says what was not measured", () => {
      expect(r().health.score).not.toBeNull();
      expect(r().gaps.some((g) => g.stage === "history")).toBe(true);
      expect(r().stages).toMatchObject({
        map: "done",
        probe: "done",
        inventory: "done",
        explain: "done",
        history: "skipped",
      });
    });
  },
);
