import { expect, test } from "@playwright/test";
import { APP, expectNoA11yViolations, signIn } from "./helpers";

/**
 * Accessibility gate (audit F-11): no serious or critical WCAG 2.1 A/AA violations on the
 * main pages. Tagged @responsive so it runs at desktop width and at 375 px (the mobile
 * project). Keyboard reachability of the primary sign-in action is checked too.
 */
test("@responsive sign-in page has no serious accessibility violations", async ({ page }) => {
  await page.goto(`${APP()}/signin`);
  await expect(page.getByRole("heading", { name: "Sign in to CodeSentra" })).toBeVisible();
  await expectNoA11yViolations(page, "signin");
});

test("@responsive the projects page has no serious accessibility violations", async ({ page }) => {
  await signIn(page, `a11y-${Date.now()}@example.test`);
  await expect(page).toHaveURL(/\/projects$/);
  await expectNoA11yViolations(page, "projects");
});

test("@responsive the new-project page has no serious accessibility violations", async ({
  page,
}) => {
  await signIn(page, `a11y-new-${Date.now()}@example.test`);
  await page.goto(`${APP()}/projects/new`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expectNoA11yViolations(page, "projects/new");
});

test("@responsive the settings page has no serious accessibility violations", async ({ page }) => {
  await signIn(page, `a11y-settings-${Date.now()}@example.test`);
  await page.goto(`${APP()}/settings`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expectNoA11yViolations(page, "settings");
});

test("the sign-in form is operable by keyboard alone", async ({ page }) => {
  await page.goto(`${APP()}/signin`);
  const email = page.getByLabel("Email");
  await email.focus();
  await email.type(`kbd-${Date.now()}@example.test`);
  // Tab to the submit button and activate it with the keyboard.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Check your email")).toBeVisible();
});
