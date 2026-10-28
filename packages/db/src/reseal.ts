import { isSealedWith, type Keyring, openSecret, sealSecret } from "@codesentra/core/crypto";
import { eq, isNotNull } from "drizzle-orm";
import type { Database } from "./client.js";
import { environments, githubInstallations, notificationChannels } from "./schema.js";

/** Every sealed column and the purpose its values were sealed for (ADR 0022, 0024). */
const SEALED = [
  {
    name: "github_installations.sealed",
    table: githubInstallations,
    column: githubInstallations.sealed,
    purpose: "github-installation",
  },
  {
    name: "notification_channels.sealed",
    table: notificationChannels,
    column: notificationChannels.sealed,
    purpose: "notification-target",
  },
  {
    name: "environments.bypass_token_ref",
    table: environments,
    column: environments.bypassTokenRef,
    purpose: "bypass-token",
  },
] as const;

export interface ResealReport {
  column: string;
  resealed: number;
  alreadyCurrent: number;
  /** Rows whose value no key of the keyring opens (left unchanged). */
  failed: string[];
}

/**
 * Key rotation (ADR 0024): rewrites every sealed value under the keyring's current key.
 * Values already sealed with it are left alone, so running it again is harmless. A value
 * no key opens is reported and left as it is: nothing is ever dropped.
 */
export async function resealAll(db: Database, keys: Keyring): Promise<ResealReport[]> {
  const out: ResealReport[] = [];
  for (const c of SEALED) {
    const report: ResealReport = { column: c.name, resealed: 0, alreadyCurrent: 0, failed: [] };
    const rows = (await db.system
      .select({ id: c.table.id, value: c.column })
      .from(c.table)
      .where(isNotNull(c.column))) as { id: string; value: string }[];
    for (const row of rows) {
      if (isSealedWith(row.value, keys)) {
        report.alreadyCurrent++;
        continue;
      }
      let plain: string;
      try {
        plain = openSecret(row.value, keys, c.purpose);
      } catch {
        report.failed.push(row.id);
        continue;
      }
      await db.system
        .update(c.table)
        .set({
          [c.column.name === "sealed" ? "sealed" : "bypassTokenRef"]: sealSecret(
            plain,
            keys,
            c.purpose,
          ),
        })
        .where(eq(c.table.id, row.id));
      report.resealed++;
    }
    out.push(report);
  }
  return out;
}
