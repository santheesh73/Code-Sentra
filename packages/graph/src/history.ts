import { posix } from "node:path";

export interface Commit {
  sha: string;
  author: string;
  /** ISO timestamp. */
  date: string;
  /** Repo-relative paths touched by the commit. */
  files: string[];
}

export interface HistoryStats {
  commits: number;
  contributors: number;
  /** Commits and last-touched date per top-level directory ("." for root files). */
  directories: { dir: string; commits: number; lastTouched: string }[];
  /** Commits touching each file. */
  churn: Map<string, number>;
  lastTouched: Map<string, string>;
  /** File pairs changed together in ≥ 2 commits that touched 2–50 files. */
  coChanges: { a: string; b: string; count: number }[];
}

const MIN_FILES = 2;
const MAX_FILES = 50;
const MIN_PAIR = 2;

/** Pure history analysis over parsed `git log` output (Section 8.3). */
export function analyzeHistory(commits: Commit[], livePaths?: ReadonlySet<string>): HistoryStats {
  const authors = new Set<string>();
  const churn = new Map<string, number>();
  const last = new Map<string, string>();
  const dirs = new Map<string, { commits: number; lastTouched: string }>();
  const pairs = new Map<string, number>();

  for (const c of commits) {
    authors.add(c.author.toLowerCase());
    const files = [...new Set(c.files)].filter((f) => !livePaths || livePaths.has(f)).sort();
    const touchedDirs = new Set<string>();
    for (const f of files) {
      churn.set(f, (churn.get(f) ?? 0) + 1);
      if (!last.has(f) || (last.get(f) as string) < c.date) last.set(f, c.date);
      const top = f.includes("/") ? (f.split("/")[0] as string) : ".";
      touchedDirs.add(top);
    }
    for (const d of touchedDirs) {
      const prev = dirs.get(d) ?? { commits: 0, lastTouched: c.date };
      prev.commits++;
      if (prev.lastTouched < c.date) prev.lastTouched = c.date;
      dirs.set(d, prev);
    }
    if (files.length >= MIN_FILES && files.length <= MAX_FILES) {
      for (let i = 0; i < files.length; i++)
        for (let j = i + 1; j < files.length; j++) {
          const k = `${files[i]}\u0000${files[j]}`;
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
        }
    }
  }

  const coChanges = [...pairs.entries()]
    .filter(([, n]) => n >= MIN_PAIR)
    .map(([k, count]) => {
      const [a, b] = k.split("\u0000") as [string, string];
      return { a, b, count };
    })
    .sort((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  return {
    commits: commits.length,
    contributors: authors.size,
    directories: [...dirs.entries()]
      .map(([dir, v]) => ({ dir, ...v }))
      .sort((a, b) => b.commits - a.commits || a.dir.localeCompare(b.dir)),
    churn,
    lastTouched: last,
    coChanges,
  };
}

/** The value at the q-quantile (0–1) of a list, nearest-rank. */
function quantile(values: number[], q: number): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] as number;
}

/**
 * Hotspots: files in the top decile of both churn and inbound imports. Files with no
 * churn or no importers are never hotspots, so tiny repos do not flag everything.
 */
export function hotspots(
  churn: ReadonlyMap<string, number>,
  fanIn: ReadonlyMap<string, number>,
): { path: string; churn: number; fanIn: number }[] {
  const candidates = [...churn.keys()].filter(
    (p) => (churn.get(p) ?? 0) > 0 && (fanIn.get(p) ?? 0) > 0,
  );
  if (!candidates.length) return [];
  const churnCut = quantile([...churn.values()], 0.9);
  const fanCut = quantile([...fanIn.values()], 0.9);
  return candidates
    .filter((p) => (churn.get(p) as number) >= churnCut && (fanIn.get(p) as number) >= fanCut)
    .map((p) => ({ path: p, churn: churn.get(p) as number, fanIn: fanIn.get(p) as number }))
    .sort((a, b) => b.churn * b.fanIn - a.churn * a.fanIn || a.path.localeCompare(b.path));
}

/**
 * Parses `git log --name-only --no-renames --format=%x1e%H%x1f%aE%x1f%aI` output.
 * Paths are kept only if they are repo-relative and stay inside the repo.
 */
export function parseGitLog(out: string): Commit[] {
  return out
    .split("\x1e")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [head = "", ...rest] = block.split("\n");
      const [sha = "", author = "", date = ""] = head.split("\x1f");
      const files = rest
        .map((l) => l.trim())
        .filter((l) => l && !posix.isAbsolute(l) && !posix.normalize(l).startsWith(".."));
      return { sha, author, date, files };
    })
    .filter((c) => /^[0-9a-f]{7,64}$/.test(c.sha));
}
