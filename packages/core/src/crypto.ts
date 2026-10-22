import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secrets at rest (Section 17): AES-256-GCM with the 32-byte ENCRYPTION_KEY. The purpose
 * ("github-installation", "slack-webhook", ...) is bound in as associated data, so a
 * value sealed for one field cannot be opened as another. Format: `v1.<iv>.<tag>.<ct>`
 * (base64url), so a future key or algorithm can be told apart.
 */
export function sealSecret(plain: string, keyBase64: string, purpose: string): string {
  const key = keyOf(keyBase64);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function openSecret(sealed: string, keyBase64: string, purpose: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("not a sealed secret");
  const d = createDecipheriv("aes-256-gcm", keyOf(keyBase64), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(purpose, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

function keyOf(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (base64)");
  return key;
}
