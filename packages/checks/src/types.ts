import type {
  CheckGroupOutcome,
  EvidenceKind,
  FindingCode,
  JsonObject,
  MainUrlOutcome,
  PulseCheckGroup,
  PulseStatus,
  Severity,
} from "@codesentra/core";
import type { FetchPolicy } from "@codesentra/ssrf";
import type { Browser } from "playwright-core";

/** Evidence produced by a check, before it has a database id. `key` links findings to it. */
export interface EvidenceDraft {
  key: string;
  kind: EvidenceKind;
  locator: string;
  payload: JsonObject;
}

export interface FindingDraft {
  code: FindingCode;
  severity: Severity;
  /** The evidence that shows the problem. */
  evidenceKey: string;
  /** What the fingerprint is computed from (URL for Pulse). */
  locator: string;
  /** Distinguishes findings on the same locator (console message, header name). */
  discriminator?: string;
  message: string;
}

export interface PlatformIdentity {
  name: "vercel" | "netlify" | "render" | "cloudflare-pages" | "fly" | "generic" | "unknown";
  environment: "production" | "preview" | "unknown";
  reason: string;
}

export interface PulseOptions {
  url: string;
  policy: FetchPolicy;
  /** null: render is recorded as a gap (Rule 2), never as a pass. */
  browser: Browser | null;
  browserUnavailableReason?: string;
  /** Environment name this URL is registered as, e.g. "production". */
  expectedEnvironment?: string;
  /** Page and API routes discovered by Scan (Phase 3+). */
  scanRoutes?: string[];
  /** TTFB above this is SLOW_RESPONSE. Default 3000 ms. */
  slowThresholdMs?: number;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Header sent to pass platform access protection on preview deployments. */
  bypass?: { header: string; value: string };
  /** Called as each group starts and finishes (progress events). */
  onGroup?: (
    group: PulseCheckGroup,
    state: "running" | "done" | "skipped" | "failed",
    detail?: string,
  ) => void | Promise<void>;
}

export interface PulseResult {
  url: string;
  finalUrl: string | null;
  status: PulseStatus;
  main: MainUrlOutcome;
  groups: CheckGroupOutcome[];
  gaps: { group: PulseCheckGroup; reason: string }[];
  platform: PlatformIdentity | null;
  evidence: EvidenceDraft[];
  findings: FindingDraft[];
  /** PNG of the rendered page, when render ran. Stored by the caller. */
  screenshot: Buffer | null;
  durationMs: number;
}
