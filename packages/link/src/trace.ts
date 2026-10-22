import type { FindingCode } from "@codesentra/core";

/** A stored code node (code_nodes row) as Link sees it. `id` is the row id or graph key. */
export interface LinkNode {
  id: string;
  kind: string;
  path: string | null;
  name: string;
  line: number | null;
  meta: Record<string, unknown>;
}

export interface LinkEdge {
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
}

export interface LinkGraph {
  nodes: LinkNode[];
  edges: LinkEdge[];
  /** Env var names documented in .env.example / docs (Scan's env_var_documented evidence). */
  documentedEnv: ReadonlySet<string>;
}

export interface TraceFinding {
  code: FindingCode;
  locator: string;
  discriminator?: string | null;
  message: string;
}

export interface TraceSite {
  nodeId: string;
  path: string;
  line: number | null;
  /** The enclosing (nearest preceding) symbol in the file, when known. */
  symbol: string | null;
  /** The source line, as stored at Scan time. */
  excerpt: string | null;
}

export interface Trace {
  verified: boolean;
  /** The key taken from the runtime evidence (null when none could be derived). */
  joinKey: string | null;
  sites: TraceSite[];
  /** Env vars interpolated at the site, and whether the project documents each. */
  envVars: { name: string; documented: boolean }[];
  /** ROUTE_BROKEN / SAME_ORIGIN_FAILURE with no route for the path is ROUTE_MISSING (10a). */
  reclassifiedAs: FindingCode | null;
  /** Why there is no verified trace, for the investigate prompt and the gap list. */
  reason: string | null;
}

const BAD_TOKEN = /^(undefined|null|nan|\[object object\])$/i;
const MAX_SITES = 5;

const pathOf = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

/** `/undefined/api/ping` → `/api/ping`: the static part the code appends after the bad value. */
export function undefinedSuffix(url: string): string | null {
  const p = pathOf(url);
  if (!p) return null;
  const segs = p.split("/");
  const i = segs.findIndex((s) => BAD_TOKEN.test(decodeURIComponent(s)));
  if (i < 0) return null;
  const rest = segs.slice(i + 1).join("/");
  return rest ? `/${rest}` : null;
}

/** The literal text after a template's last `${...}`, without query or hash. */
export function templateSuffix(template: string): string {
  const end = template.lastIndexOf("}");
  return (end >= 0 ? template.slice(end + 1) : template).split(/[?#]/)[0] as string;
}

/** `http://localhost:4000/data` → `localhost:4000` (no port when it is the scheme's default). */
export function hostPortOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Runtime messages carry a prefix the source does not: `Uncaught Error: x` → `x`. */
export function normalizeMessage(text: string): string {
  return text
    .replace(/^\s*(uncaught\s+(\(in promise\)\s+)?)?/i, "")
    .replace(/^[A-Z]?\w*(Error|Exception):\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A route pattern matches a request path: `[id]`, `:id` and `{id}` match one segment. */
export function routeMatches(pattern: string, path: string): boolean {
  const a = pattern.replace(/\/$/, "").split("/");
  const b = path.replace(/\/$/, "").split("/");
  if (a.some((s) => /^\[\.\.\..+\]$/.test(s))) {
    const i = a.findIndex((s) => /^\[\.\.\..+\]$/.test(s));
    return (
      b.length > i && routeMatches(a.slice(0, i).join("/") || "/", b.slice(0, i).join("/") || "/")
    );
  }
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === b[i] || /^(\[.+\]|:.+|\{.+\})$/.test(s));
}

function siteOf(n: LinkNode, graph: LinkGraph): TraceSite {
  const symbol =
    n.kind === "symbol"
      ? n.name
      : typeof n.meta.symbol === "string"
        ? n.meta.symbol
        : (graph.nodes
            .filter(
              (s) =>
                s.kind === "symbol" &&
                s.path === n.path &&
                s.line !== null &&
                n.line !== null &&
                s.line <= n.line,
            )
            .sort((x, y) => (y.line as number) - (x.line as number))[0]?.name ?? null);
  return {
    nodeId: n.id,
    path: n.path as string,
    line: n.line,
    symbol,
    excerpt: typeof n.meta.text === "string" ? n.meta.text : null,
  };
}

const byPlace = (a: LinkNode, b: LinkNode) =>
  `${a.path}:${String(a.line).padStart(8, "0")}`.localeCompare(
    `${b.path}:${String(b.line).padStart(8, "0")}`,
  );

function result(
  graph: LinkGraph,
  joinKey: string | null,
  matches: LinkNode[],
  missReason: string,
  extra: Partial<Trace> = {},
): Trace {
  const sites = [...new Map(matches.filter((m) => m.path).map((m) => [m.id, m])).values()]
    .sort(byPlace)
    .slice(0, MAX_SITES);
  const envNames = [
    ...new Set(
      sites.flatMap((s) => {
        const v = s.meta.envVars;
        return typeof v === "string" && v ? v.split(",") : [];
      }),
    ),
  ];
  return {
    verified: sites.length > 0,
    joinKey,
    sites: sites.map((s) => siteOf(s, graph)),
    envVars: envNames.map((name) => ({ name, documented: graph.documentedEnv.has(name) })),
    reclassifiedAs: null,
    reason: sites.length ? null : missReason,
    ...extra,
  };
}

const literals = (graph: LinkGraph, roles: string[]) =>
  graph.nodes.filter((n) => n.kind === "literal" && roles.includes(String(n.meta.role)));

const routesFor = (graph: LinkGraph, path: string, kinds: string[]) =>
  graph.nodes.filter(
    (n) =>
      kinds.includes(n.kind) &&
      typeof n.meta.routePath === "string" &&
      routeMatches(n.meta.routePath, path),
  );

/** Is this Scan locator (`path[:line][#symbol]`) a code location? */
const CODE_LOCATOR = /^(?<path>[^:#\s][^:#]*?)(?::(?<line>\d+))?(?:#.*)?$/;

/**
 * Traces one finding to code (Section 10a). A trace is verified only when the join key
 * taken from the runtime evidence equals a code fact exactly; there is no fuzzy or model
 * matching. Pure and deterministic.
 */
export function traceFinding(f: TraceFinding, graph: LinkGraph): Trace {
  switch (f.code) {
    case "UNDEFINED_IN_URL": {
      const key = undefinedSuffix(f.locator);
      if (!key) return result(graph, null, [], "no path after the undefined value to match");
      const hits = literals(graph, ["url_template"]).filter(
        (n) => templateSuffix(String(n.meta.value)) === key,
      );
      return result(graph, key, hits, `no URL template in the code ends with ${key}`);
    }
    case "LOCALHOST_CALL": {
      const key = hostPortOf(f.locator);
      if (!key) return result(graph, null, [], "the request URL could not be parsed");
      const hostRe = new RegExp(
        `(^|//|@)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$|\\?|#)`,
        "i",
      );
      const hits = literals(graph, ["url", "url_template"]).filter((n) =>
        hostRe.test(String(n.meta.value)),
      );
      return result(graph, key, hits, `no string literal in the code contains ${key}`);
    }
    case "SAME_ORIGIN_FAILURE":
    case "ROUTE_BROKEN": {
      const key = pathOf(f.locator);
      if (!key) return result(graph, null, [], "the request URL could not be parsed");
      const handlers = routesFor(graph, key, ["route", "api_handler"]);
      if (handlers.length) return result(graph, key, handlers, "");
      // No route or handler serves the path: it is missing, and the code that links or
      // calls it is where the fix starts.
      const callers = [
        ...literals(graph, ["href"]).filter((n) => n.meta.value === key),
        ...literals(graph, ["url"]).filter(
          (n) => pathOf(String(n.meta.value)) === key || n.meta.value === key,
        ),
      ];
      return result(
        graph,
        key,
        callers,
        `no route serves ${key}, and no link or call to it was found`,
        {
          reclassifiedAs: "ROUTE_MISSING",
        },
      );
    }
    case "ROUTE_MISSING": {
      const key = pathOf(f.locator);
      if (!key) return result(graph, null, [], "the request URL could not be parsed");
      return result(
        graph,
        key,
        literals(graph, ["href"]).filter((n) => n.meta.value === key),
        `no link to ${key} was found`,
      );
    }
    case "UNCAUGHT_EXCEPTION":
    case "CONSOLE_ERROR": {
      const raw = f.discriminator ?? f.message;
      const key = normalizeMessage(raw);
      if (!key) return result(graph, null, [], "the message is empty");
      const roles =
        f.code === "UNCAUGHT_EXCEPTION" ? ["throw", "error"] : ["console", "throw", "error"];
      const hits = literals(graph, roles).filter(
        (n) => normalizeMessage(String(n.meta.value)) === key,
      );
      return result(graph, key, hits, `no throw, Error(...) or console.error with this exact text`);
    }
    case "BLANK_PAGE": {
      const key = pathOf(f.locator) ?? "/";
      return result(
        graph,
        key,
        routesFor(graph, key, ["route"]),
        `no page component for ${key} in the code graph`,
      );
    }
    default:
      break;
  }
  // Scan findings already carry their file and line.
  const m = CODE_LOCATOR.exec(f.locator);
  if (m?.groups?.path && !/^https?:/i.test(f.locator)) {
    const path = m.groups.path;
    const line = m.groups.line ? Number(m.groups.line) : null;
    const file = graph.nodes.find((n) => n.kind === "file" && n.path === path);
    if (file) {
      const atLine =
        line === null
          ? null
          : graph.nodes.find((n) => n.path === path && n.line === line && n.kind !== "file");
      const node: LinkNode = atLine ?? { ...file, line };
      return result(graph, f.locator, [node], "");
    }
    return result(graph, f.locator, [], `${path} is not in the scanned snapshot`);
  }
  return result(graph, null, [], `no trace rule for ${f.code}`);
}
