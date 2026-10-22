import { expect, test } from "@playwright/test";
import { startWorkerProcess, stop } from "../stack";
import { APP, signIn } from "./helpers";

test("redirects signed-out visitors to sign-in", async ({ page }) => {
  await page.goto(`${APP()}/projects`);
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "Sign in to CodeSentra" })).toBeVisible();
  await expect(page.getByText("GitHub sign-in is not configured on this server.")).toBeVisible();
});

test("Phase 1 gate: sign in, create a project, trigger a job and watch its steps live", async ({
  page,
}) => {
  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });

  await signIn(page, `gate-${Date.now()}@example.com`);

  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Name").fill("Gate project");
  await page.getByLabel("URL", { exact: true }).fill("https://gate.example.com");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Gate project" })).toBeVisible();
  // No Pulse yet: the environment must not look healthy.
  await expect(page.getByText("Not checked")).toBeVisible();
  await expect(page.getByText(/Live$/)).toHaveCount(0);

  await page.getByRole("button", { name: "Run diagnostic" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Queued")).toBeVisible();
  await expect(page.getByTestId("connection")).toHaveText("● Live");
  for (const step of ["database", "queue", "object_storage"]) {
    await expect(page.getByTestId(`step-${step}`)).toHaveAttribute("data-status", "pending");
  }

  // The worker starts only now: everything below must arrive over SSE, without a reload.
  const navigationsBefore = navigations;
  const worker = startWorkerProcess();
  try {
    for (const step of ["database", "queue", "object_storage"]) {
      await expect(page.getByTestId(`step-${step}`)).toHaveAttribute("data-status", "done");
    }
    await expect(page.getByText("Succeeded")).toBeVisible();
    await expect(page.getByText("Not everything was checked")).toHaveCount(0);
  } finally {
    await stop(worker);
  }
  expect(navigations).toBe(navigationsBefore);

  await page.getByRole("button", { name: "Show log" }).first().click();
  await expect(page.getByText(/Postgres 16\.\d+; tenant-scoped round trip/)).toBeVisible();

  await page.getByRole("link", { name: "← Project" }).click();
  await expect(page.getByRole("link", { name: /diagnostic/i })).toContainText("Succeeded");
});

test("@responsive pages fit a 375 px screen without horizontal scrolling", async ({ page }) => {
  await signIn(page, `small-${Date.now()}@example.com`);
  for (const path of ["/projects", "/projects/new", "/settings"]) {
    await page.goto(`${APP()}${path}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
