import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtureApps } from "./manifest.js";
import { resolveExportPath } from "./static-server.js";

const REQUIRED_APPS = [
  "blank",
  "broken-route",
  "console-throw",
  "env-undefined",
  "healthy",
  "localhost-leak",
];

describe("fixture manifests", () => {
  const apps = loadFixtureApps();

  it("declares every fixture app required by Section 13", () => {
    expect(apps.map((a) => a.manifest.name)).toEqual(REQUIRED_APPS);
  });

  it("trace expectations point at the real source line", () => {
    for (const app of apps) {
      for (const [variant, expected] of Object.entries(app.manifest.expected)) {
        for (const issue of expected.issues) {
          if (!issue.trace) continue;
          const lines = readFileSync(join(app.dir, issue.trace.file), "utf8").split("\n");
          const line = lines[issue.trace.line - 1];
          expect(
            line,
            `${app.manifest.name}/${variant} ${issue.trace.file}:${issue.trace.line}`,
          ).toContain(issue.trace.lineContains);
        }
      }
    }
  });

  it("healthy expects live with zero findings and issues", () => {
    const healthy = apps.find((a) => a.manifest.name === "healthy");
    expect(healthy?.manifest.expected.default).toEqual({
      pulseStatus: "live",
      findings: [],
      issues: [],
    });
  });

  it("env-undefined has a fixed variant that sets NEXT_PUBLIC_API_URL and expects live", () => {
    const app = apps.find((a) => a.manifest.name === "env-undefined");
    expect(app?.manifest.variants.fixed?.env.NEXT_PUBLIC_API_URL).toBeTruthy();
    expect(app?.manifest.expected.fixed?.pulseStatus).toBe("live");
    const pkg = JSON.parse(readFileSync(join(app?.dir ?? "", "package.json"), "utf8"));
    expect(pkg.scripts.build).toContain(
      `NEXT_PUBLIC_API_URL=${app?.manifest.variants.fixed?.env.NEXT_PUBLIC_API_URL}`,
    );
    expect(pkg.scripts.build).toContain("env -u NEXT_PUBLIC_API_URL");
  });
});

describe("resolveExportPath", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-export-"));
  writeFileSync(join(root, "index.html"), "home");
  writeFileSync(join(root, "about.html"), "about");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "index.html"), "docs");

  it("maps Next.js export conventions", () => {
    expect(resolveExportPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveExportPath(root, "/about")).toBe(join(root, "about.html"));
    expect(resolveExportPath(root, "/docs")).toBe(join(root, "docs", "index.html"));
    expect(resolveExportPath(root, "/pricing")).toBeNull();
  });

  it("rejects traversal and malformed paths", () => {
    expect(resolveExportPath(root, "/../../etc/passwd")).toBeNull();
    expect(resolveExportPath(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveExportPath(root, "/%E0%A4%A")).toBeNull();
    expect(resolveExportPath(root, "/index.html%00.txt")).toBeNull();
  });
});
