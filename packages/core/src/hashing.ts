import { createHash } from "node:crypto";
import type { Module } from "./enums.js";
import type { EvidenceInput } from "./evidence.js";
import { fingerprintInput } from "./fingerprint.js";
import { canonicalJson } from "./json.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** sha256 of kind + locator + canonical payload (Section 6). */
export function evidenceHash(e: EvidenceInput): string {
  return sha256Hex(`${e.kind}\n${e.locator}\n${canonicalJson(e.payload)}`);
}

/** sha256 of code + normalized locator (+ optional normalized discriminator, e.g. a console message). */
export function fingerprint(
  code: string,
  module: Module,
  locator: string,
  discriminator?: string,
): string {
  return sha256Hex(fingerprintInput(code, module, locator, discriminator));
}
