import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.30.1";

export interface SecretMatch {
  /** gitleaks rule, e.g. `aws-access-token`. */
  type: string;
  file: string;
  line: number;
  /** The matched text with the secret replaced; never the secret itself. */
  preview: string;
}

interface GitleaksFinding {
  RuleID: string;
  File: string;
  StartLine: number;
  EndLine: number;
  StartColumn: number;
  EndColumn: number;
}

/** The source line with the reported (1-based, inclusive) column range masked. */
function previewOf(treeDir: string, f: GitleaksFinding, rel: string): string {
  let line = "";
  try {
    line = readFileSync(join(treeDir, rel), "utf8").split("\n")[f.StartLine - 1] ?? "";
  } catch {
    return "•••";
  }
  const end = f.EndLine === f.StartLine ? f.EndColumn : line.length;
  return maskPreview(
    `${line.slice(0, Math.max(0, f.StartColumn - 1))}•••${line.slice(end)}`.trim(),
  );
}

/**
 * Masks anything secret-shaped that survived redaction: long runs of key-like
 * characters keep only their first 4 characters.
 */
export function maskPreview(text: string): string {
  return text
    .replace(/REDACTED/g, "•••")
    .replace(
      /[A-Za-z0-9+/_\-=]{12,}/g,
      (m) => `${m.slice(0, 4)}${"•".repeat(Math.min(8, m.length - 4))}`,
    )
    .slice(0, 200);
}

/**
 * gitleaks over the snapshot tree (outside the probe sandbox, Section 8.4, but still in a
 * no-network, read-only container with the tree mounted read-only). Runs with
 * `--redact`, and the preview is masked again before it is stored: only the type, file,
 * line and a masked preview leave this function.
 */
export function scanSecrets(
  treeDir: string,
  opts: { image?: string; timeoutMs?: number } = {},
): Promise<SecretMatch[]> {
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "1g",
    "-v",
    `${treeDir}:/scan:ro`,
    opts.image ?? GITLEAKS_IMAGE,
    "dir",
    "/scan",
    "--no-banner",
    "--redact",
    "--report-format",
    "json",
    "--report-path",
    "-",
    "--exit-code",
    "0",
    "--max-target-megabytes",
    "5",
    "--log-level",
    "error",
  ];
  return new Promise((ok, fail) =>
    execFile(
      "docker",
      args,
      {
        timeout: opts.timeoutMs ?? 5 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      (err, stdout, stderr) => {
        if (err)
          return fail(new Error(`gitleaks failed: ${String(stderr).slice(-500) || err.message}`));
        let found: GitleaksFinding[];
        try {
          found = JSON.parse(String(stdout) || "[]") as GitleaksFinding[];
        } catch {
          return fail(new Error("gitleaks output was not JSON"));
        }
        ok(
          found
            .map((f) => {
              const file = f.File.replace(/^\/scan\//, "");
              return {
                type: f.RuleID,
                file,
                line: f.StartLine,
                preview: previewOf(treeDir, f, file),
              };
            })
            .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
        );
      },
    ),
  );
}
