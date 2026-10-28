import { keyring, openSecret, sealSecret } from "@codesentra/core/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resealAll } from "./reseal.js";
import * as s from "./schema.js";
import { startTestDatabase, type TestDatabase } from "./testing.js";

/** Key rotation (ADR 0024): every sealed column moves to the new key, nothing is lost. */
let t: TestDatabase;
const oldKey = Buffer.alloc(32, 1).toString("base64");
const newKey = Buffer.alloc(32, 2).toString("base64");
const strayKey = Buffer.alloc(32, 3).toString("base64");
let envId: string;
let strayEnvId: string;

beforeAll(async () => {
  t = await startTestDatabase();
  const [org] = await t.db.system
    .insert(s.organizations)
    .values({ name: "R", slug: "rs" })
    .returning();
  const orgId = org?.id as string;
  const [p] = await t.db.system.insert(s.projects).values({ orgId, name: "p" }).returning();
  const projectId = p?.id as string;
  const [e1, e2] = await t.db.system
    .insert(s.environments)
    .values([
      {
        orgId,
        projectId,
        name: "preview",
        url: "https://p.example/",
        bypassTokenRef: sealSecret('{"header":"x","value":"tok"}', oldKey, "bypass-token"),
      },
      {
        orgId,
        projectId,
        name: "stray",
        url: "https://q.example/",
        bypassTokenRef: sealSecret("lost", strayKey, "bypass-token"),
      },
    ])
    .returning();
  envId = e1?.id as string;
  strayEnvId = e2?.id as string;
  await t.db.system.insert(s.githubInstallations).values({
    installationId: 42,
    orgId,
    sealed: sealSecret('{"account":"acme","repositories":[]}', oldKey, "github-installation"),
  });
  await t.db.system.insert(s.notificationChannels).values({
    orgId,
    projectId,
    kind: "email",
    label: "a***@example.com",
    sealed: sealSecret("a@example.com", oldKey, "notification-target"),
  });
}, 120_000);
afterAll(() => t?.stop());

describe("resealAll", () => {
  it("moves every sealed value to the new key, and reports what it cannot open", async () => {
    const ring = keyring(newKey, oldKey);
    const first = await resealAll(t.db, ring);
    expect(first).toEqual([
      { column: "github_installations.sealed", resealed: 1, alreadyCurrent: 0, failed: [] },
      { column: "notification_channels.sealed", resealed: 1, alreadyCurrent: 0, failed: [] },
      {
        column: "environments.bypass_token_ref",
        resealed: 1,
        alreadyCurrent: 0,
        failed: [strayEnvId],
      },
    ]);
    // Now the new key alone opens them.
    const [env] = await t.db.system
      .select()
      .from(s.environments)
      .where(eq(s.environments.id, envId));
    expect(openSecret(env?.bypassTokenRef as string, newKey, "bypass-token")).toContain("tok");
    const [inst] = await t.db.system.select().from(s.githubInstallations);
    expect(openSecret(inst?.sealed as string, newKey, "github-installation")).toContain("acme");
    const [ch] = await t.db.system.select().from(s.notificationChannels);
    expect(openSecret(ch?.sealed as string, newKey, "notification-target")).toBe("a@example.com");
    // The value nobody can open is untouched (never dropped).
    const [stray] = await t.db.system
      .select()
      .from(s.environments)
      .where(eq(s.environments.id, strayEnvId));
    expect(openSecret(stray?.bypassTokenRef as string, strayKey, "bypass-token")).toBe("lost");

    const again = await resealAll(t.db, ring);
    expect(again.map((r) => [r.resealed, r.alreadyCurrent])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  });
});
