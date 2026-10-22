/**
 * Version ordering for OSV range evaluation. npm uses SemVer 2.0 (with a lenient parse of
 * `1.2` as `1.2.0`); PyPI uses PEP 440 (release segments, pre/post/dev releases, epochs).
 * Returns negative, zero or positive; null when a version cannot be parsed.
 */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa.release[i] as number) - (pb.release[i] as number);
    if (d) return d;
  }
  // A version without prerelease sorts after one with.
  if (!pa.pre.length || !pb.pre.length) return (pa.pre.length ? -1 : 0) - (pb.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseSemver(v: string): { release: number[]; pre: string[] } | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    v.trim(),
  );
  if (!m) return null;
  return {
    release: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] ? m[4].split(".") : [],
  };
}

interface Pep440 {
  epoch: number;
  release: number[];
  /** [phase rank, number]; phase rank a=0, b=1, rc=2. */
  pre: [number, number] | null;
  post: number | null;
  dev: number | null;
}

function parsePep440(v: string): Pep440 | null {
  const m =
    /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9.]+)?$/i.exec(
      v.trim(),
    );
  if (!m) return null;
  const phase = m[3]?.toLowerCase();
  const rank = phase ? (phase.startsWith("a") ? 0 : phase.startsWith("b") ? 1 : 2) : null;
  return {
    epoch: Number(m[1] ?? 0),
    release: (m[2] as string).split(".").map(Number),
    pre: rank === null ? null : [rank, Number(m[4] || 0)],
    post: m[5] !== undefined ? Number(m[5]) : m[6] !== undefined ? Number(m[7] || 0) : null,
    dev: m[8] !== undefined ? Number(m[8] || 0) : null,
  };
}

export function comparePep440(a: string, b: string): number | null {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa || !pb) return null;
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;
  const n = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < n; i++) {
    const d = (pa.release[i] ?? 0) - (pb.release[i] ?? 0);
    if (d) return d;
  }
  // Order within a release: dev < pre < (final) < post.
  const key = (p: Pep440): number[] => {
    if (p.pre === null && p.post === null && p.dev !== null) return [-1, 0, 0, p.dev];
    const pre = p.pre ? [p.pre[0], p.pre[1]] : [3, 0];
    return [0, ...pre, p.post ?? -1, p.dev === null ? Number.POSITIVE_INFINITY : p.dev];
  };
  const ka = key(pa);
  const kb = key(pb);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function compareFor(ecosystem: string): (a: string, b: string) => number | null {
  return ecosystem === "PyPI" ? comparePep440 : compareSemver;
}
