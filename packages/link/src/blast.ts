import type { LinkGraph } from "./trace.js";

export interface BlastEntry {
  path: string;
  /** Why it is in the radius: "imports app/lib/api.ts", "changed together in 4 commits". */
  reason: string;
  hops: number;
}

const MAX_ENTRIES = 25;
const CO_CHANGE_PARTNERS = 5;

/**
 * Blast radius of the traced files (Section 10b): files that import them, up to 2 hops
 * (inbound `imports` / `calls` edges), plus each file's top 5 `co_changes` partners by
 * weight. Each entry says why it is there. Pure and deterministic.
 */
export function blastRadius(tracedPaths: string[], graph: LinkGraph): BlastEntry[] {
  const pathById = new Map(graph.nodes.map((n) => [n.id, n.path]));
  const traced = new Set(tracedPaths);
  const out = new Map<string, BlastEntry>();
  const add = (e: BlastEntry) => {
    if (traced.has(e.path)) return;
    const prev = out.get(e.path);
    if (!prev || e.hops < prev.hops) out.set(e.path, e);
  };

  // Inbound edges: who imports (or calls into) a file.
  const importers = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind !== "imports" && e.kind !== "calls") continue;
    const from = pathById.get(e.fromId);
    const to = pathById.get(e.toId);
    if (!from || !to || from === to) continue;
    const set = importers.get(to) ?? new Set<string>();
    set.add(from);
    importers.set(to, set);
  }
  for (const t of [...traced].sort()) {
    for (const a of [...(importers.get(t) ?? [])].sort()) {
      add({ path: a, reason: `imports ${t}`, hops: 1 });
      for (const b of [...(importers.get(a) ?? [])].sort())
        add({ path: b, reason: `imports ${a}, which imports ${t}`, hops: 2 });
    }
  }

  for (const t of [...traced].sort()) {
    const partners = graph.edges
      .filter((e) => e.kind === "co_changes")
      .map((e) => {
        const a = pathById.get(e.fromId);
        const b = pathById.get(e.toId);
        return a === t
          ? { path: b, weight: e.weight }
          : b === t
            ? { path: a, weight: e.weight }
            : null;
      })
      .filter((x): x is { path: string; weight: number } => !!x?.path)
      .sort((x, y) => y.weight - x.weight || x.path.localeCompare(y.path))
      .slice(0, CO_CHANGE_PARTNERS);
    for (const p of partners)
      add({
        path: p.path,
        reason: `changed together with ${t} in ${p.weight} commit${p.weight === 1 ? "" : "s"}`,
        hops: 1,
      });
  }
  return [...out.values()]
    .sort((a, b) => a.hops - b.hops || a.path.localeCompare(b.path))
    .slice(0, MAX_ENTRIES);
}
