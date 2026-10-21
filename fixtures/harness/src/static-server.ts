import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Headers every fixture app sends, so MISSING_SECURITY_HEADER never fires on the
 * fixtures by accident. `connect-src *` lets the browser attempt the requests the
 * fixtures are designed to make (e.g. localhost:4000) so Pulse can observe them.
 */
export const FIXTURE_SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Maps a URL path to a file inside `root` using Next.js static-export conventions. */
export function resolveExportPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rootAbs = resolve(root);
  const rel = normalize(decoded).replace(/^([/\\])+/, "");
  const base = resolve(rootAbs, rel);
  if (base !== rootAbs && !base.startsWith(rootAbs + sep)) return null;

  const candidates = decoded.endsWith("/")
    ? [join(base, "index.html")]
    : [base, `${base}.html`, join(base, "index.html")];
  return candidates.find(isFile) ?? null;
}

export function serveExport(root: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://fixture.local");
  const file = resolveExportPath(root, url.pathname);
  const notFound = join(root, "404.html");
  const target = file ?? (existsSync(notFound) ? notFound : null);
  const status = file ? 200 : 404;
  for (const [k, v] of Object.entries(FIXTURE_SECURITY_HEADERS)) res.setHeader(k, v);
  if (!target) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(status, {
    "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}
