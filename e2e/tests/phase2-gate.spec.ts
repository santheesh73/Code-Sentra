import type { ChildProcess } from "node:child_process";
import { loadFixtureApps } from "@codesentra/fixture-harness";
import { expect, type Page, test } from "@playwright/test";
import { startWorkerProcess, stop } from "../stack";
import { APP, signIn } from "./helpers";

/**
 * Phase 2 gate (Section 18) through the whole stack: web → API → pg-boss → worker-pulse
 * (real Chromium) → Postgres/MinIO → web. Every fixture app must return its expected
 * status and findings, `healthy` must be live with zero issues, and every issue must
 * have a prompt. The SSRF suite itself runs in packages/ssrf; here the API must refuse
 * private targets.
 */

interface Targets {
  apps: Record<string, { url: string }>;
  simulators: Record<string, { url: string }>;
  control: string;
}
const targets = (): Targets => JSON.parse(process.env.CS_E2E_HARNESS ?? "{}") as Targets;

interface ApiFinding {
  code: string;
  severity: string;
  locator: string;
  discriminator: string | null;
  message: string;
}
interface ApiRunFindings {
  findings: ApiFinding[];
  issues: { issue_id: string | null; code: string; prompt: { body: string } }[];
}

let worker: ChildProcess | undefined;
test.beforeAll(() => {
  worker = startWorkerProcess();
});
test.afterAll(async () => stop(worker));

async function setVariant(app: string, variant: string) {
  const res = await fetch(new URL(`/__harness/apps/${app}/variant`, targets().control), {
    method: "POST",
    body: JSON.stringify({ variant }),
  });
  if (!res.ok) throw new Error(`setVariant ${app} ${variant}: ${res.status}`);
}

/** Same comparison as packages/checks: CODE path, CODE host:port, or CODE message. */
function summarise(findings: ApiFinding[]): string[] {
  return findings
    .filter((f) => f.severity !== "info")
    .map((f) => {
      if (f.code === "UNCAUGHT_EXCEPTION" || f.code === "CONSOLE_ERROR")
        return `${f.code} ${f.discriminator}`;
      if (f.code === "LOCALHOST_CALL") return `${f.code} ${f.locator}`;
      return `${f.code} ${new URL(f.locator).pathname}`;
    })
    .sort();
}

async function createProject(page: Page, name: string, envs: { name: string; url: string }[]) {
  const me = await (await page.request.get(`${APP()}/api/v1/me`)).json();
  const res = await page.request.post(`${APP()}/api/v1/projects`, {
    headers: { origin: APP() },
    data: { org_id: me.organizations[0].id, name, environments: envs },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

/** Clicks "Check now" for one environment and waits for the run's Pulse status. */
async function checkNow(page: Page, projectId: string, env: string) {
  await page.goto(`${APP()}/projects/${projectId}`);
  await page.getByRole("button", { name: `Check ${env} now` }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const runId = page.url().split("/").at(-1) as string;
  const badge = page.locator("h1 ~ span [data-pulse-status]");
  await expect(badge).toBeVisible({ timeout: 60_000 });
  return { runId, status: await badge.getAttribute("data-pulse-status") };
}

async function runFindings(page: Page, runId: string): Promise<ApiRunFindings> {
  const res = await page.request.get(`${APP()}/api/v1/runs/${runId}/findings`);
  expect(res.status()).toBe(200);
  return res.json();
}

test("Phase 2 gate: every fixture app returns its expected status and findings", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page, `pulse-gate-${Date.now()}@example.com`);
  const apps = loadFixtureApps();
  const projectId = await createProject(
    page,
    "Fixture apps",
    apps.map((a) => ({
      name: a.manifest.name,
      url: targets().apps[a.manifest.name]?.url ?? "",
    })),
  );

  for (const app of apps) {
    for (const [variant, expected] of Object.entries(app.manifest.expected)) {
      await test.step(`${app.manifest.name} (${variant}) → ${expected.pulseStatus}`, async () => {
        await setVariant(app.manifest.name, variant);
        const { runId, status } = await checkNow(page, projectId, app.manifest.name);
        const data = await runFindings(page, runId);
        const want = expected.findings
          .map((f) => `${f.code} ${f.message ?? f.url ?? f.path}`)
          .sort();
        expect({ status, findings: summarise(data.findings) }).toEqual({
          status: expected.pulseStatus,
          findings: want,
        });
        // No group skipped: a fixture result with gaps would not prove anything.
        await expect(page.getByTestId("gaps")).toHaveCount(0);
        // Every issue has a prompt, in the API and on the page (Rule 4).
        for (const i of data.issues) {
          expect(i.prompt.body.length, i.code).toBeGreaterThan(50);
          expect(i.issue_id, i.code).not.toBeNull();
        }
        await expect(page.getByTestId("prompt")).toHaveCount(data.issues.length);
        if (expected.pulseStatus === "live") {
          await expect(page.getByTestId("no-issues")).toBeVisible();
        }
        await expect(page.getByRole("img", { name: /rendered/ })).toBeVisible();
      });
    }
  }
});

test("an issue opens with evidence and a prompt, then resolves after the fix deploys", async ({
  page,
}) => {
  await signIn(page, `pulse-issue-${Date.now()}@example.com`);
  const projectId = await createProject(page, "Env bug", [
    { name: "production", url: targets().apps["env-undefined"]?.url ?? "" },
  ]);
  await setVariant("env-undefined", "broken");
  const first = await checkNow(page, projectId, "production");
  expect(first.status).toBe("degraded");

  // Shared evidence: one issue led by UNDEFINED_IN_URL, corroborated by SAME_ORIGIN_FAILURE.
  const issue = page.getByTestId("run-issues").locator("li[data-code]");
  await expect(issue).toHaveCount(1);
  await expect(issue).toHaveAttribute("data-code", "UNDEFINED_IN_URL");
  await issue.getByRole("link").click();
  await expect(page).toHaveURL(/\/issues\/[0-9a-f-]{36}$/);
  const issueUrl = page.url();
  await expect(page.locator("[data-issue-status]")).toHaveAttribute("data-issue-status", "open");
  await expect(page.getByText("also shown by SAME_ORIGIN_FAILURE")).toBeVisible();
  await expect(page.getByTestId("prompt")).toContainText("/undefined/api/ping");
  await expect(page.getByTestId("recheck")).toContainText("/undefined/");

  await page.getByRole("button", { name: "View evidence" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("SHA-256");
  await page.getByRole("button", { name: "Close evidence" }).click();

  await setVariant("env-undefined", "fixed");
  const second = await checkNow(page, projectId, "production");
  expect(second.status).toBe("live");
  await page.goto(issueUrl);
  await expect(page.locator("[data-issue-status]")).toHaveAttribute(
    "data-issue-status",
    "resolved",
  );
  await expect(page.getByText("Resolved (re-check passed)")).toBeVisible();
});

test("Quick Pulse checks a pasted URL without a project and refuses private targets", async ({
  page,
}) => {
  await signIn(page, `quick-${Date.now()}@example.com`);
  await page.getByRole("link", { name: "Quick Pulse" }).click();

  const quick = async (url: string) => {
    await page.goto(`${APP()}/pulse`);
    await page.getByLabel("Public URL").fill(url);
    await page.getByRole("button", { name: "Check now" }).click();
  };

  await quick(targets().apps.healthy?.url ?? "");
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.locator("h1 ~ span [data-pulse-status]")).toHaveAttribute(
    "data-pulse-status",
    "live",
    { timeout: 60_000 },
  );
  await expect(page.getByTestId("no-issues")).toBeVisible();

  await quick(targets().simulators["server-error"]?.url ?? "");
  await expect(page.locator("h1 ~ span [data-pulse-status]")).toHaveAttribute(
    "data-pulse-status",
    "down",
    { timeout: 60_000 },
  );
  await expect(page.locator('[data-prompt-type="outage_triage"]')).toBeVisible();

  for (const url of ["http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/"]) {
    await quick(url);
    await expect(page.getByText(/only checks public URLs/)).toBeVisible();
    await expect(page).toHaveURL(/\/pulse$/);
  }
});

test("@responsive Phase 2 pages fit a 375 px screen", async ({ page }) => {
  await signIn(page, `small2-${Date.now()}@example.com`);
  const projectId = await createProject(page, "Small", [
    { name: "production", url: targets().apps["console-throw"]?.url ?? "" },
  ]);
  const { runId } = await checkNow(page, projectId, "production");
  await expect(page.getByTestId("prompt").first()).toBeVisible();
  const issueHref = await page
    .getByTestId("run-issues")
    .getByRole("link")
    .first()
    .getAttribute("href");
  for (const path of ["/pulse", `/runs/${runId}`, issueHref ?? "", `/projects/${projectId}`]) {
    await page.goto(`${APP()}${path}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
