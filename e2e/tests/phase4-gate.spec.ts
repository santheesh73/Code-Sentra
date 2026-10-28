import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { loadFixtureApps } from "@codesentra/fixture-harness";
import { expect, type Page, test } from "@playwright/test";
import yazl from "yazl";
import { ROOT, startScanWorkerProcess, startWorkerProcess, stop } from "../stack";
import { APP, signIn, waitForLink, waitForRunApi } from "./helpers";

/**
 * Phase 4 gate (Section 18) through the whole stack: a full check on env-undefined
 * (worker-scan on the uploaded source, worker-pulse in Chromium, then worker-link)
 * produces one merged issue whose prompt names NEXT_PUBLIC_API_URL and the exact file
 * and line; once the fixture is "fixed" (variable set) and re-served, the next run
 * resolves the issue with no manual action; re-breaking it marks it regressed.
 */
const IMAGE = process.env.SANDBOX_IMAGE ?? "codesentra/sandbox:e2e";
const targets = () =>
  JSON.parse(process.env.CS_E2E_HARNESS ?? "{}") as {
    apps: Record<string, { url: string }>;
    control: string;
  };
let pulseWorker: ChildProcess | undefined;
let scanWorker: ChildProcess | undefined;

test.beforeAll(async () => {
  test.setTimeout(15 * 60_000);
  if (!process.env.SANDBOX_IMAGE)
    execFileSync("docker", ["build", "-q", "-t", IMAGE, join(ROOT, "infra/sandbox")], {
      stdio: "pipe",
      timeout: 600_000,
    });
  pulseWorker = startWorkerProcess();
  scanWorker = startScanWorkerProcess(IMAGE);
});
test.afterAll(async () => {
  await Promise.all([stop(pulseWorker), stop(scanWorker)]);
});

async function setVariant(app: string, variant: string) {
  const res = await fetch(new URL(`/__harness/apps/${app}/variant`, targets().control), {
    method: "POST",
    body: JSON.stringify({ variant }),
  });
  if (!res.ok) throw new Error(`setVariant ${app} ${variant}: ${res.status}`);
}

/** The fixture app's source, as a developer would zip it (no build output). */
async function sourceZip(dir: string): Promise<Buffer> {
  const out = join(mkdtempSync(join(tmpdir(), "cs-e2e-src-")), "src.zip");
  const zip = new yazl.ZipFile();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (["node_modules", ".next", ".turbo", "out", "out-fixed"].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else zip.addFile(p, relative(dir, p));
    }
  };
  walk(dir);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(out));
  const { readFileSync } = await import("node:fs");
  return readFileSync(out);
}

async function issueStatus(page: Page) {
  return page.locator("[data-issue-status]").getAttribute("data-issue-status");
}

test("Phase 4 gate: full check traces env-undefined to the line, then resolves and regresses on its own", async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const app = loadFixtureApps().find((a) => a.manifest.name === "env-undefined");
  const want = app?.manifest.expected.broken?.issues[0];
  if (!app || !want?.trace) throw new Error("env-undefined manifest has no trace expectation");
  await setVariant("env-undefined", "broken");

  await signIn(page, `link-gate-${Date.now()}@example.com`);
  const me = await (await page.request.get(`${APP()}/api/v1/me`)).json();
  const created = await page.request.post(`${APP()}/api/v1/projects`, {
    headers: { origin: APP() },
    data: {
      org_id: me.organizations[0].id,
      name: "Status board",
      environments: [{ name: "production", url: targets().apps["env-undefined"]?.url }],
    },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id as string;
  const up = await page.request.post(`${APP()}/api/v1/projects/${projectId}/snapshots`, {
    headers: { origin: APP(), "content-type": "application/zip" },
    data: await sourceZip(app.dir),
  });
  expect(up.status(), await up.text()).toBe(201);

  // Full check from the project page: Scan + Pulse in parallel, then Link.
  await page.goto(`${APP()}/projects/${projectId}`);
  await page.getByRole("button", { name: "Run full check" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const linkRunId = page.url().split("/").at(-1) as string;
  await expect(page.getByTestId("child-scan")).toBeVisible();
  await expect(page.getByTestId("child-pulse")).toBeVisible();
  const link = await waitForRunApi(page, linkRunId, 14 * 60_000);
  expect(link.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`)).toEqual([
    "trace:done",
    "widen:done",
    "prompt:done",
    "verify:done",
  ]);
  await page.reload();
  await expect(page.getByTestId("link-outcome")).toContainText("traced to code");
  expect(link.outcome.traced).toBeGreaterThanOrEqual(1);

  // One merged issue from Pulse, led by UNDEFINED_IN_URL and corroborated.
  const issues = (await (
    await page.request.get(`${APP()}/api/v1/projects/${projectId}/issues?source=pulse`)
  ).json()) as { id: string; code: string; corroborating_codes: string[] }[];
  expect(issues).toHaveLength(1);
  expect(issues[0]?.code).toBe(want.leadCode);
  // The Scan finding that NEXT_PUBLIC_API_URL is undocumented at the traced file joins it.
  expect(issues[0]?.corroborating_codes).toEqual([...want.corroboratedBy, "ENV_VAR_UNDOCUMENTED"]);
  const issueUrl = `${APP()}/issues/${issues[0]?.id}`;

  // The issue view: the verified trace, env var, and a code_fix prompt naming both.
  await page.goto(issueUrl);
  await expect(page.getByTestId("trace-location")).toHaveText(
    `${want.trace.file}:${want.trace.line}`,
  );
  await expect(page.getByTestId("trace")).toContainText(want.trace.lineContains);
  await expect(page.getByTestId("trace-env")).toContainText("NEXT_PUBLIC_API_URL");
  const prompt = page.getByTestId("prompt");
  await expect(page.locator(`[data-prompt-type="${want.promptType}"]`)).toBeVisible();
  for (const m of [...want.promptMustMention, `${want.trace.file}:${want.trace.line}`])
    await expect(prompt).toContainText(m);
  for (const m of want.configGuidanceMustMention ?? []) await expect(prompt).toContainText(m);

  // The fix is deployed: "Check now" (Pulse, then Link) resolves it with no manual action.
  await setVariant("env-undefined", "fixed");
  try {
    await page.goto(`${APP()}/projects/${projectId}`);
    await page.getByRole("button", { name: "Check production now" }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
    await waitForLink(page, page.url().split("/").at(-1) as string);
    await page.goto(issueUrl);
    expect(await issueStatus(page)).toBe("resolved");
    await expect(page.getByText("Resolved (re-check passed)")).toBeVisible();
  } finally {
    await setVariant("env-undefined", "broken");
  }

  // Broken again: a targeted re-check regresses it.
  await page.getByRole("button", { name: "Re-check now" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await waitForRunApi(page, page.url().split("/").at(-1) as string);
  await page.goto(issueUrl);
  expect(await issueStatus(page)).toBe("regressed");
  await expect(page.getByLabel("Issue history")).toContainText("Regressed");
});
