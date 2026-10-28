#!/usr/bin/env node
import { keyring } from "@codesentra/core/crypto";
import { createDatabase } from "./client.js";
import { resealAll } from "./reseal.js";

/**
 * `node reseal-cli.js`: after setting ENCRYPTION_KEY to the new key and the old one in
 * ENCRYPTION_KEY_PREVIOUS (docs/runbook.md, key rotation). Exits 1 if any value could
 * not be opened, so a rotation never silently loses a secret.
 */
const url = process.env.DATABASE_URL;
const current = process.env.ENCRYPTION_KEY;
if (!url || !current) {
  process.stderr.write("DATABASE_URL and ENCRYPTION_KEY are required\n");
  process.exit(1);
}
const db = createDatabase(url, { applicationName: "codesentra-reseal" });
try {
  const reports = await resealAll(db, keyring(current, process.env.ENCRYPTION_KEY_PREVIOUS));
  let failed = 0;
  for (const r of reports) {
    process.stdout.write(
      `${r.column}: ${r.resealed} resealed, ${r.alreadyCurrent} already current${r.failed.length ? `, ${r.failed.length} could not be opened (${r.failed.join(", ")})` : ""}\n`,
    );
    failed += r.failed.length;
  }
  if (failed) {
    process.stderr.write(
      `${failed} value(s) were not resealed: keep the key that sealed them in ENCRYPTION_KEY_PREVIOUS\n`,
    );
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
