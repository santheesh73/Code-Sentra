import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { type FixtureRepo, loadFixtureRepos } from "@codesentra/fixture-harness";
import { expect, type Page, test } from "@playwright/test";
import yazl from "yazl";
import { ROOT, startScanWorkerProcess, stop } from "../stack";
import { APP, signIn } from "./helpers";

/**
 * Phase 3 gate (Section 18) through the whole stack: web (zip upload) → API → MinIO →
 * pg-boss → worker-scan (sandboxed probes, offline OSV, gitleaks, the scripted fixture
 * model) → Postgres → web report. Each fixture repo's report must match expected.json
 * (features and statuses, findings at their locators, absent findings), no forbidden
 * claim may appear, and no secret value may reach the API or the page. The adversarial
 * claim suite and the zip and sandbox safety suites run in their packages.
 */
const IMAGE = process.env.SANDBOX_IMAGE ?? "codesentra/sandbox:e2e";
let worker: ChildProcess | undefined;
let zipDir: string;

test.beforeAll(async () => {
  test.setTimeout(15 * 60_000);
  if (!process.env.SANDBOX_IMAGE)
    execFileSync("docker", ["build", "-q", "-t", IMAGE, join(ROOT, "infra/sandbox")], {
      stdio: "pipe",
      timeout: 600_000,
    });
  zipDir = mkdtempSync(join(tmpdir(), "cs-e2e-zips-"));
  worker = startScanWorkerProcess(IMAGE);
});
test.afterAll(async () => stop(worker));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function zipOf(repo: FixtureRepo): Promise<string> {
  const out = join(zipDir, `${repo.expected.name}.zip`);
  const zip = new yazl.ZipFile();
  for (const f of filesUnder(repo.repoDir)) zip.addFile(f, relative(repo.repoDir, f));
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(out));
  return out;
}

async function createProject(page: Page, name: string) {
  const me = await (await page.request.get(`${APP()}/api/v1/me`)).json();
  const res = await page.request.post(`${APP()}/api/v1/projects`, {
    headers: { origin: APP() },
    data: { org_id: me.organizations[0].id, name },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

interface ApiReport {
  source_run_id: string;
  features: { name: string; status: string }[];
  sections: Record<string, { text: string; evidence_ids: string[] }[]>;
  claims_dropped: number;
  dropped_claims: { text: string; reason: string }[];
  health: { score: number | null };
}
interface ApiFinding {
  code: string;
  locator: string;
  evidence: { payload: Record<string, unknown> };
}

for (const repo of loadFixtureRepos()) {
  const exp = repo.expected;
  test(`Phase 3 gate: ${exp.name}`, async ({ page }) => {
    test.setTimeout(15 * 60_000);
    await signIn(page, `scan-${exp.name}@example.com`);
    const projectId = await createProject(page, exp.name);

    await page.goto(`${APP()}/projects/${projectId}`);
    await page.getByLabel("Upload a zip of the source").setInputFiles(await zipOf(repo));
    await page.getByRole("button", { name: "Scan zip" }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
    const runId = page.url().split("/").at(-1) as string;

    // The run page streams the stages, then shows the report.
    await expect(page.getByTestId("health-score")).toBeVisible({ timeout: 14 * 60_000 });
    for (const stage of ["ingest", "map", "probe", "inventory", "explain"])
      await expect(page.getByTestId(`step-${stage}`)).toHaveAttribute("data-status", "done");
    // A zip has no history: a gap, shown as such (Rule 2).
    await expect(page.getByTestId("step-history")).toHaveAttribute("data-status", "skipped");
    await expect(page.getByTestId("scan-gaps")).toContainText("History");

    // Features and statuses, as the page shows them.
    for (const f of exp.features)
      await expect(
        page.locator(`[data-feature="${f.name}"] [data-feature-status]`),
        f.name,
      ).toHaveAttribute("data-feature-status", f.status);

    const report = (await (
      await page.request.get(`${APP()}/api/v1/runs/${runId}/report`)
    ).json()) as ApiReport;
    expect(Object.fromEntries(report.features.map((f) => [f.name, f.status]))).toEqual(
      Object.fromEntries(exp.features.map((f) => [f.name, f.status])),
    );
    expect(report.health.score).not.toBeNull();

    // Zero forbidden claims: none in the report, each one dropped with a reason.
    const shown = Object.values(report.sections)
      .flat()
      .map((c) => c.text);
    const pageText = (await page.getByTestId("report-sections").textContent()) ?? "";
    for (const c of exp.forbiddenClaims) {
      expect(shown, c.text).not.toContain(c.text);
      expect(pageText, c.text).not.toContain(c.text);
      expect(report.dropped_claims.find((d) => d.text === c.text)?.reason, c.text).toBeTruthy();
    }
    await page.getByRole("button", { name: /dropped claim/ }).click();
    await expect(page.getByTestId("dropped-claims").locator("li")).toHaveCount(
      report.claims_dropped,
    );

    // Findings at their exact locators; absent ones absent.
    const findings = (
      (await (await page.request.get(`${APP()}/api/v1/runs/${runId}/findings`)).json()) as {
        findings: ApiFinding[];
      }
    ).findings;
    for (const f of exp.findings) {
      const hit = findings.find((x) => x.code === f.code && x.locator === f.locator);
      expect(hit, `${f.code} at ${f.locator}`).toBeTruthy();
      if (f.code === "VULNERABLE_DEPENDENCY")
        expect(hit?.evidence.payload).toMatchObject({ package: f.package, version: f.version });
    }
    for (const code of exp.absentFindings)
      expect(
        findings.filter((f) => f.code === code),
        code,
      ).toEqual([]);

    // A secret's value never leaves the worker.
    for (const f of exp.findings.filter((x) => x.code === "SECRET_EXPOSED")) {
      const secret = f.storedPreviewMustNotContain as string;
      expect(JSON.stringify(findings)).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(await page.content()).not.toContain(secret);
    }

    // Every issue carries a prompt (Rule 4).
    await expect(page.getByTestId("run-issues")).toBeVisible();

    // The report fits a phone screen.
    await page.setViewportSize({ width: 375, height: 812 });
    // The elements that stick out, innermost first, so a failure names what to fix.
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .filter(
          (el) =>
            ![...el.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 1),
        )
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 80)}"`),
    );
    expect(overflowing).toEqual([]);
  });
}
