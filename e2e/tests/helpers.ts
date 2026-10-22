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
