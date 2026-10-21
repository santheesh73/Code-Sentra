import { z } from "zod";
import { JsonObject } from "./json.js";

/**
 * Kinds of deterministic evidence. Collectors in Scan and Pulse write these to the
 * single `evidence` table (Rule 3); claims and findings cite them by id.
 */
export const EvidenceKind = z.enum([
  // Scan
  "manifest",
  "doc_excerpt",
  "code_fact",
  "route",
  "env_var_read",
  "env_var_documented",
  "marker",
  "test_result",
  "probe_result",
  "dependency_advisory",
  "secret_match",
  "commit_stats",
  "hotspot",
  "language_coverage",
  // Pulse
  "dns_result",
  "tls_certificate",
  "http_response",
  "redirect_chain",
  "platform_identity",
  "browser_request",
  "console_message",
  "page_error",
  "render_summary",
  "screenshot",
  "security_headers",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** `path/to/file.ts:12`, `path/to/file.ts:12:5`, `path/to/file.ts`, or an absolute http(s) URL. */
export const Locator = z.string().min(1).max(4096);
export type Locator = z.infer<typeof Locator>;

export const EvidenceInput = z.object({
  kind: EvidenceKind,
  locator: Locator,
  payload: JsonObject,
});
export type EvidenceInput = z.infer<typeof EvidenceInput>;

export const EvidenceRecord = EvidenceInput.extend({
  id: z.uuid(),
  orgId: z.uuid(),
  runId: z.uuid(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.coerce.date(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

const CODE_LOCATOR =
  /^(?<path>[^:\s][^:]*?)(?::(?<line>\d+)(?::(?<col>\d+))?)?(?:#(?<symbol>[^#]+))?$/;

export interface CodeLocator {
  path: string;
  line?: number;
  column?: number;
  symbol?: string;
}

export function isUrlLocator(locator: string): boolean {
  return /^https?:\/\//i.test(locator);
}

/** Parses `path[:line[:col]][#symbol]`. Returns null for URL locators or malformed input. */
export function parseCodeLocator(locator: string): CodeLocator | null {
  if (isUrlLocator(locator)) return null;
  const m = CODE_LOCATOR.exec(locator);
  if (!m?.groups?.path) return null;
  const out: CodeLocator = { path: m.groups.path };
  if (m.groups.line) out.line = Number(m.groups.line);
  if (m.groups.col) out.column = Number(m.groups.col);
  if (m.groups.symbol) out.symbol = m.groups.symbol;
  return out;
}
