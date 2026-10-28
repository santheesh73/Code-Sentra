import { expect, test } from "@playwright/test";
import { APP, signIn } from "./helpers";

/**
 * Phase 5 settings through the web app: an API token is shown once and works as a
 * Bearer token; a project gets a GitHub repository, a schedule and an email channel,
 * and each action lands in the audit log. (The PR check-run gate runs at the API
 * against the fake GitHub: apps/api/src/__tests__/github.test.ts.)
 */
const targets = () =>
  JSON.parse(process.env.CS_E2E_HARNESS ?? "{}") as { apps: Record<string, { url: string }> };

test("tokens, schedules, notifications and the audit log", async ({ page }) => {
  const email = `settings-${Date.now()}@example.com`;
  await signIn(page, email);

  // A project with one environment, created from the page (same-origin fetch).
  const project = await page.evaluate(async (url) => {
    const me = await (await fetch("/api/v1/me")).json();
    const res = await fetch("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: me.organizations[0].id,
        name: "settings-e2e",
        environments: [{ name: "production", url }],
      }),
    });
    return res.json();
  }, targets().apps.healthy?.url);

  // API token: shown once, then usable as a Bearer token.
  await page.goto(`${APP()}/settings`);
  await page.getByLabel("New token name").fill("e2e laptop");
  await page.getByRole("button", { name: "Create token" }).click();
  const shown = page.getByText(/^cs_[A-Za-z0-9_-]{43}$/);
  await expect(shown).toBeVisible();
  const token = (await shown.textContent()) as string;
  await expect(page.getByText("e2e laptop")).toBeVisible();
  const me = await page.request.get(`${APP()}/api/v1/me`, {
    headers: { authorization: `Bearer ${token}`, cookie: "" },
  });
  expect(me.status()).toBe(200);
  expect((await me.json()).user.email).toBe(email);
  await page.reload();
  await expect(page.getByText(/^cs_[A-Za-z0-9_-]{43}$/)).toHaveCount(0);

  // Project settings: GitHub repository, a schedule, an email channel.
  await page.goto(`${APP()}/projects/${project.id}`);
  await page.getByRole("main").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible();
  await page.getByLabel("Repository (owner/name)").fill("acme/settings-e2e");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByLabel("Cron (minute hour day month weekday)").fill("* * * * *");
  await page.getByRole("button", { name: "Add schedule" }).click();
  await expect(page.getByText(/minimum is 5/)).toBeVisible();
  await page.getByLabel("Cron (minute hour day month weekday)").fill("*/30 * * * *");
  await page.getByRole("button", { name: "Add schedule" }).click();
  await expect(page.getByText("*/30 * * * *")).toBeVisible();

  await page.getByLabel("Email a member of the organization").fill("stranger@example.org");
  await page.getByRole("button", { name: "Add email" }).click();
  await expect(page.getByText(/can only be emailed to members/)).toBeVisible();
  await page.getByLabel("Email a member of the organization").fill(email);
  await page.getByRole("button", { name: "Add email" }).click();
  await expect(page.getByText(/email · s\*\*\*@example\.com/i)).toBeVisible();

  // Every one of those is in the audit log.
  await page.goto(`${APP()}/settings`);
  for (const action of ["api_token.created", "schedule.created", "notification_channel.created"])
    await expect(page.getByText(action).first()).toBeVisible();
});
