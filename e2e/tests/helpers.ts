import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export const APP = () => process.env.CS_E2E_APP_URL ?? "";

async function readMagicLink(email: string): Promise<string> {
  const dir = process.env.CS_E2E_OUTBOX ?? "";
  for (let i = 0; i < 50; i++) {
    const msgs = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; text: string });
    const msg = msgs.filter((m) => m.to === email).at(-1);
    const link = msg && /(https?:\/\/\S+#token=[A-Za-z0-9_-]+)/.exec(msg.text)?.[1];
    if (link) return link;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-in email for ${email}`);
}

export async function signIn(page: Page, email: string) {
  await page.goto(`${APP()}/signin`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.goto(await readMagicLink(email));
  await page.getByRole("button", { name: "Sign in to CodeSentra" }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

const TERMINAL = ["succeeded", "failed", "partial"];

/** Waits for a run to finish, through the web app's API proxy. */
export async function waitForRunApi(page: Page, runId: string, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await (await page.request.get(`${APP()}/api/v1/runs/${runId}`)).json();
    if (TERMINAL.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`run ${runId} did not finish`);
}

/** A project run's issues come from the Link run that follows it (ADR 0019): wait for it. */
export async function waitForLink(page: Page, runId: string) {
  const run = await waitForRunApi(page, runId);
  if (!run.parent_run_id) return null;
  return waitForRunApi(page, run.parent_run_id);
}
