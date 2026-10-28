import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secrets at rest (Section 17): AES-256-GCM with the 32-byte ENCRYPTION_KEY. The purpose
 * ("github-installation", "bypass-token", ...) is bound in as associated data, so a value
 * sealed for one field cannot be opened as another.
 *
 * Format `v2.<kid>.<iv>.<tag>.<ct>` (base64url), where `kid` names the key that sealed it,
 * so keys can be rotated (ADR 0024): values open with any key of the keyring (the current
 * ENCRYPTION_KEY plus retired ones in ENCRYPTION_KEY_PREVIOUS), and `reseal` rewrites them
 * under the current key. Values in the older `v1.<iv>.<tag>.<ct>` format still open.
 */
export type Keyring = string | readonly string[];

/** A short, non-secret id of a key (the first 8 bytes of its SHA-256). */
export function keyId(keyBase64: string): string {
  return createHash("sha256").update(keyOf(keyBase64)).digest("base64url").slice(0, 11);
}

/** The current key first, then retired ones. */
export const keyring = (current: string, previous?: string | null): string[] => [
  current,
  ...(previous ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
];

const ringOf = (keys: Keyring): readonly string[] => (typeof keys === "string" ? [keys] : keys);

export function sealSecret(plain: string, keys: Keyring, purpose: string): string {
  const current = ringOf(keys)[0];
  if (!current) throw new Error("no encryption key");
  const key = keyOf(current);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [
    "v2",
    keyId(current),
    ...[iv, c.getAuthTag(), ct].map((p) => p.toString("base64url")),
  ].join(".");
}

export function openSecret(sealed: string, keys: Keyring, purpose: string): string {
  const parts = sealed.split(".");
  const ring = ringOf(keys);
  let candidates: readonly string[];
  let body: string[];
  if (parts[0] === "v2" && parts.length === 5) {
    const kid = parts[1];
    const match = ring.find((k) => keyId(k) === kid);
    if (!match) throw new Error("sealed with a key that is not in the keyring");
    candidates = [match];
    body = parts.slice(2);
  } else if (parts[0] === "v1" && parts.length === 4) {
    candidates = ring;
    body = parts.slice(1);
  } else {
    throw new Error("not a sealed secret");
  }
  const [iv, tag, ct] = body as [string, string, string];
  let last: unknown;
  for (const k of candidates) {
    try {
      const d = createDecipheriv("aes-256-gcm", keyOf(k), Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(purpose, "utf8"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("could not open the sealed secret");
}

/** True when the value is already sealed with the current (first) key of the keyring. */
export function isSealedWith(sealed: string, keys: Keyring): boolean {
  const current = ringOf(keys)[0];
  const parts = sealed.split(".");
  return parts[0] === "v2" && !!current && parts[1] === keyId(current);
}

function keyOf(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (base64)");
  return key;
}
