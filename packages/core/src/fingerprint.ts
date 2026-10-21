import type { Module } from "./enums.js";
import { isUrlLocator, parseCodeLocator } from "./evidence.js";

const ASSET_EXT = /\.(?:m?js|css|map|woff2?|ttf|png|jpe?g|gif|svg|webp|avif|ico)$/i;
const TRAILING_LINE_COL = /:\d+(?::\d+)?$/;

/** Next.js-style build id directory: /_next/static/<buildId>/... */
const NEXT_BUILD_DIR = /\/_next\/static\/(?!chunks\/|css\/|media\/)[^/]+\//;

const looksLikeHash = (s: string): boolean =>
  s.length >= 6 && /\d/.test(s) && /^[A-Za-z0-9_~]+$/.test(s);

/** `main-3f2a9c1b.js` → `main-[hash].js`, `0a1b2c3d4e5f.js` → `[hash].js`. */
function normalizeAssetName(segment: string): string {
  const ext = ASSET_EXT.exec(segment)?.[0];
  if (!ext) return segment;
  const stem = segment.slice(0, segment.length - ext.length);
  const named = /^(?<name>.+)[.-](?<hash>[A-Za-z0-9_~]+)$/.exec(stem);
  if (named?.groups?.name && named.groups.hash && looksLikeHash(named.groups.hash)) {
    return `${named.groups.name}-[hash]${ext}`;
  }
  if (looksLikeHash(stem)) return `[hash]${ext}`;
  return segment;
}

function normalizeUrlLocator(raw: string): string {
  const withoutLineCol = raw.replace(TRAILING_LINE_COL, "");
  let url: URL;
  try {
    url = new URL(withoutLineCol);
  } catch {
    return withoutLineCol.trim();
  }
  let path = url.pathname.replace(/\/{2,}/g, "/");
  path = path.replace(NEXT_BUILD_DIR, "/_next/static/[build]/");
  const segments = path.split("/");
  path = segments.map((s, i) => (i === segments.length - 1 ? normalizeAssetName(s) : s)).join("/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // URL lowercases scheme and host and drops default ports; query and fragment are discarded.
  return `${url.protocol}//${url.host}${path}`;
}

function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");
}

/**
 * Normalizes a locator so the same problem across runs maps to the same issue.
 * - Pulse: drop query strings, fragments, build ids, asset content hashes and line/column.
 * - Scan: keep the repository path and symbol, drop line/column (lines move between commits).
 */
export function normalizeLocator(module: Module, locator: string): string {
  const raw = locator.trim();
  if (module === "pulse") {
    if (isUrlLocator(raw)) return normalizeUrlLocator(raw);
    return raw.replace(TRAILING_LINE_COL, "");
  }
  if (isUrlLocator(raw)) return normalizeUrlLocator(raw);
  const parsed = parseCodeLocator(raw);
  if (!parsed) return raw;
  const path = normalizeRepoPath(parsed.path);
  return parsed.symbol ? `${path}#${parsed.symbol}` : path;
}

/** Collapses whitespace so cosmetic differences in messages do not split issues. */
export function normalizeMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The exact string that is hashed into a fingerprint. Pure and isomorphic. */
export function fingerprintInput(
  code: string,
  module: Module,
  locator: string,
  discriminator?: string,
): string {
  const parts = [code, normalizeLocator(module, locator)];
  if (discriminator !== undefined) parts.push(normalizeMessage(discriminator));
  return parts.join("\n");
}
