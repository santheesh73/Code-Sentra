import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LockedPackage, normalizePyName } from "./lockfiles.js";
import { compareFor } from "./versions.js";

/** The subset of the OSV schema (https://ossf.github.io/osv-schema/) the audit reads. */
export interface OsvRecord {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  modified?: string;
  withdrawn?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { ecosystem?: string; name?: string };
    ranges?: { type: string; events: Record<string, string>[] }[];
    versions?: string[];
    database_specific?: { severity?: string };
  }[];
}

export type Severity = "critical" | "high" | "moderate" | "low" | "unknown";

export interface Advisory {
  /** Preferred id (GHSA when one exists) and every alias seen across sources. */
  id: string;
  ids: string[];
  summary: string;
  severity: Severity;
  fixedVersions: string[];
}

export interface PackageVulns {
  pkg: LockedPackage;
  advisories: Advisory[];
}

export interface OsvSource {
  /** Describes the data (for evidence): e.g. "OSV API" or "OSV offline snapshot (2026-10-22)". */
  readonly description: string;
  /** False when the source has no data for this package (it is then not checked, Rule 2). */
  covers(pkg: LockedPackage): boolean;
  records(pkg: LockedPackage): Promise<OsvRecord[]>;
}

export interface AuditResult {
  vulnerable: PackageVulns[];
  /** Packages the source could not check, with the reason. */
  notChecked: { pkg: LockedPackage; reason: string }[];
  checked: number;
}

const keyOf = (ecosystem: string, name: string) =>
  `${ecosystem}:${ecosystem === "PyPI" ? normalizePyName(name) : name}`;

/**
 * Reads `<dir>/<ecosystem>/*.json` OSV records (the format of osv-vulnerabilities `all.zip`).
 * `SNAPSHOT.json` lists the packages the snapshot was built for; any other package is not
 * covered, so it is reported as not checked rather than as clean.
 */
export async function offlineSource(dir: string): Promise<OsvSource> {
  const manifest = JSON.parse(await readFile(join(dir, "SNAPSHOT.json"), "utf8")) as {
    fetchedAt: string;
    ecosystems: Record<string, { packages: string[] }>;
  };
  const covered = new Set(
    Object.entries(manifest.ecosystems).flatMap(([eco, e]) => e.packages.map((n) => keyOf(eco, n))),
  );
  const index = new Map<string, OsvRecord[]>();
  for (const eco of await readdir(dir, { withFileTypes: true })) {
    if (!eco.isDirectory()) continue;
    for (const f of await readdir(join(dir, eco.name))) {
      if (!f.endsWith(".json")) continue;
      const rec = JSON.parse(await readFile(join(dir, eco.name, f), "utf8")) as OsvRecord;
      for (const a of rec.affected ?? []) {
        if (!a.package?.ecosystem || !a.package.name) continue;
        const k = keyOf(a.package.ecosystem, a.package.name);
        const list = index.get(k) ?? [];
        if (!list.includes(rec)) list.push(rec);
        index.set(k, list);
      }
    }
  }
  return {
    description: `OSV offline snapshot (fetched ${manifest.fetchedAt.slice(0, 10)})`,
    covers: (pkg) => covered.has(keyOf(pkg.ecosystem, pkg.name)),
    async records(pkg) {
      return index.get(keyOf(pkg.ecosystem, pkg.name)) ?? [];
    },
  };
}

/** The OSV API (`/v1/query`, one package at a time; results cached per run). */
export function apiSource(opts: { baseUrl?: string; timeoutMs?: number } = {}): OsvSource {
  const base = opts.baseUrl ?? "https://api.osv.dev";
  return {
    description: "OSV API (api.osv.dev)",
    covers: () => true,
    async records(pkg) {
      const out: OsvRecord[] = [];
      let pageToken: string | undefined;
      do {
        const res = await fetch(`${base}/v1/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            package: { ecosystem: pkg.ecosystem, name: pkg.name },
            version: pkg.version,
            ...(pageToken ? { page_token: pageToken } : {}),
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
        if (!res.ok) throw new Error(`OSV API answered HTTP ${res.status}`);
        const body = (await res.json()) as { vulns?: OsvRecord[]; next_page_token?: string };
        out.push(...(body.vulns ?? []));
        pageToken = body.next_page_token;
      } while (pageToken);
      return out;
    },
  };
}

/** True when `version` falls in one of the record's affected ranges for this package. */
export function affects(rec: OsvRecord, pkg: LockedPackage): boolean {
  if (rec.withdrawn) return false;
  const cmp = compareFor(pkg.ecosystem);
  for (const a of rec.affected ?? []) {
    if (a.package?.ecosystem !== pkg.ecosystem) continue;
    if (keyOf(pkg.ecosystem, a.package.name ?? "") !== keyOf(pkg.ecosystem, pkg.name)) continue;
    if (a.versions?.includes(pkg.version)) return true;
    for (const r of a.ranges ?? []) {
      if (r.type !== "SEMVER" && r.type !== "ECOSYSTEM") continue;
      // Events are ordered: introduced … fixed/last_affected, possibly several windows.
      let inWindow = false;
      for (const ev of r.events) {
        if (ev.introduced !== undefined) {
          const c = ev.introduced === "0" ? 1 : cmp(pkg.version, ev.introduced);
          if (c === null) continue;
          if (c >= 0) inWindow = true;
        } else if (ev.fixed !== undefined && inWindow) {
          const c = cmp(pkg.version, ev.fixed);
          if (c !== null && c < 0) return true;
          inWindow = false;
        } else if (ev.last_affected !== undefined && inWindow) {
          const c = cmp(pkg.version, ev.last_affected);
          if (c !== null && c <= 0) return true;
          inWindow = false;
        } else if (ev.limit !== undefined && inWindow) {
          const c = cmp(pkg.version, ev.limit);
          if (c !== null && c < 0) return true;
          inWindow = false;
        }
      }
      if (inWindow) return true;
    }
  }
  return false;
}

function severityOf(rec: OsvRecord): Severity {
  const s = (
    rec.database_specific?.severity ??
    rec.affected?.find((a) => a.database_specific?.severity)?.database_specific?.severity ??
    ""
  ).toLowerCase();
  if (s === "critical" || s === "high" || s === "moderate" || s === "low") return s;
  if (s === "medium") return "moderate";
  return "unknown";
}

const RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };

function fixedIn(rec: OsvRecord, pkg: LockedPackage): string[] {
  const out = new Set<string>();
  for (const a of rec.affected ?? [])
    if (
      a.package?.ecosystem === pkg.ecosystem &&
      keyOf(pkg.ecosystem, a.package.name ?? "") === keyOf(pkg.ecosystem, pkg.name)
    )
      for (const r of a.ranges ?? []) for (const ev of r.events) if (ev.fixed) out.add(ev.fixed);
  return [...out];
}

/**
 * Advisories affecting each package. Records that share an id or alias (a GHSA and its
 * PYSEC twin) collapse into one advisory; the GHSA id is preferred, and the highest
 * severity any source states is kept. A severity no source states is `unknown`.
 */
export async function auditPackages(
  source: OsvSource,
  pkgs: LockedPackage[],
): Promise<AuditResult> {
  const out: PackageVulns[] = [];
  const notChecked: AuditResult["notChecked"] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const pkg of pkgs) {
    const k = `${keyOf(pkg.ecosystem, pkg.name)}@${pkg.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!source.covers(pkg)) {
      notChecked.push({ pkg, reason: `${source.description} has no data for ${pkg.name}` });
      continue;
    }
    let recs: OsvRecord[];
    try {
      recs = (await source.records(pkg)).filter((r) => affects(r, pkg));
    } catch (e) {
      notChecked.push({ pkg, reason: `advisory lookup failed: ${(e as Error).message}` });
      continue;
    }
    checked++;
    const groups: { ids: Set<string>; recs: OsvRecord[] }[] = [];
    for (const r of recs) {
      const ids = [r.id, ...(r.aliases ?? [])];
      const g = groups.find((x) => ids.some((i) => x.ids.has(i)));
      if (g) {
        for (const i of ids) g.ids.add(i);
        g.recs.push(r);
      } else groups.push({ ids: new Set(ids), recs: [r] });
    }
    const advisories = groups
      .map((g) => {
        const ids = [...g.ids].sort();
        const id = ids.find((i) => i.startsWith("GHSA-")) ?? (ids[0] as string);
        const severity = g.recs
          .map(severityOf)
          .reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "unknown" as Severity);
        const summary =
          g.recs.map((r) => r.summary).find(Boolean) ??
          (g.recs[0]?.details ?? "").split("\n")[0] ??
          "";
        const fixed = [...new Set(g.recs.flatMap((r) => fixedIn(r, pkg)))].sort();
        return { id, ids, summary: summary.slice(0, 300), severity, fixedVersions: fixed };
      })
      .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id));
    if (advisories.length) out.push({ pkg, advisories });
  }
  return { vulnerable: out, notChecked, checked };
}
