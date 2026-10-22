import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export interface ZipLimits {
  /** Total uncompressed bytes (default 200 MB). */
  maxBytes: number;
  maxFiles: number;
  maxDepth: number;
  /** Uncompressed/compressed ratio above which an entry (or the archive) is a bomb. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxBytes: 200 * 1024 * 1024,
  maxFiles: 50_000,
  maxDepth: 30,
  maxRatio: 100,
};

export type ZipRejectCode =
  | "invalid_zip"
  | "encrypted"
  | "symlink"
  | "absolute_path"
  | "path_traversal"
  | "bad_name"
  | "duplicate_path"
  | "too_many_files"
  | "too_large"
  | "too_deep"
  | "zip_bomb";

export class ZipRejected extends Error {
  constructor(
    readonly code: ZipRejectCode,
    message: string,
    readonly entry: string | null = null,
  ) {
    super(message);
    this.name = "ZipRejected";
  }
}

export interface ExtractResult {
  files: { path: string; size: number }[];
  bytes: number;
  /** The single top-level folder that was unwrapped, if any. */
  unwrapped: string | null;
}

/** Ratios are only meaningful for entries large enough to matter. */
const RATIO_MIN_BYTES = 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function open(path: string): Promise<ZipFile> {
  return new Promise((ok, fail) =>
    yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: false,
        decodeStrings: true,
      },
      (err, zip) =>
        err || !zip
          ? fail(new ZipRejected("invalid_zip", err?.message ?? "unreadable zip"))
          : ok(zip),
    ),
  );
}

/** yauzl validates names itself while reading the central directory; keep its reason precise. */
function fromYauzl(e: Error): ZipRejected {
  const m = e.message;
  if (/^absolute path/.test(m)) return new ZipRejected("absolute_path", m);
  if (/^invalid relative path/.test(m)) return new ZipRejected("path_traversal", m);
  if (/^invalid characters/.test(m)) return new ZipRejected("bad_name", m);
  if (/encrypt/i.test(m)) return new ZipRejected("encrypted", m);
  return new ZipRejected("invalid_zip", m);
}

function readEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((ok, fail) => {
    const out: Entry[] = [];
    zip.on("entry", (e: Entry) => {
      out.push(e);
      zip.readEntry();
    });
    zip.on("end", () => ok(out));
    zip.on("error", (e: Error) => fail(fromYauzl(e)));
    zip.readEntry();
  });
}

/** Validates one entry name and returns its normalized repo-relative path. */
export function checkEntryName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (!name || /[\u0000-\u001f]/.test(name))
    throw new ZipRejected("bad_name", "entry name has control characters", name);
  if (name.includes("\\"))
    throw new ZipRejected("bad_name", "entry name contains a backslash", name);
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name))
    throw new ZipRejected("absolute_path", `absolute path in archive: ${name}`, name);
  const segs = name.split("/");
  if (segs.some((s) => s === ".."))
    throw new ZipRejected("path_traversal", `".." segment in archive: ${name}`, name);
  return posix.normalize(name).replace(/\/$/, "");
}

/**
 * Extracts an uploaded zip into `dest` under hard limits (Section 8.1). Every entry is
 * validated from the central directory before anything is written: symlinks, absolute
 * paths, `..` segments, encrypted entries, too many files, too deep, too large, and
 * compression-ratio bombs are rejected. Sizes are enforced again on the actual bytes
 * while extracting, so a lying header cannot get past the limit. A single top-level
 * folder is unwrapped.
 */
export async function extractZip(
  zipPath: string,
  dest: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<ExtractResult> {
  const zip = await open(zipPath);
  try {
    const entries = await readEntries(zip);
    const files: { entry: Entry; path: string }[] = [];
    let declared = 0;
    let compressed = 0;
    for (const e of entries) {
      const path = checkEntryName(e.fileName);
      const mode = (e.externalFileAttributes >>> 16) & S_IFMT;
      if (mode === S_IFLNK)
        throw new ZipRejected("symlink", `symlink in archive: ${e.fileName}`, e.fileName);
      if ((e.generalPurposeBitFlag & 0x1) !== 0)
        throw new ZipRejected("encrypted", `encrypted entry: ${e.fileName}`, e.fileName);
      if (e.fileName.endsWith("/")) continue;
      if (!path || path === ".") continue;
      if (path.split("/").length > limits.maxDepth)
        throw new ZipRejected(
          "too_deep",
          `deeper than ${limits.maxDepth} levels: ${e.fileName}`,
          e.fileName,
        );
      if (
        e.uncompressedSize >= RATIO_MIN_BYTES &&
        e.uncompressedSize / Math.max(1, e.compressedSize) > limits.maxRatio
      )
        throw new ZipRejected(
          "zip_bomb",
          `compression ratio over ${limits.maxRatio}:1 in ${e.fileName}`,
          e.fileName,
        );
      declared += e.uncompressedSize;
      compressed += e.compressedSize;
      files.push({ entry: e, path });
    }
    if (files.length > limits.maxFiles)
      throw new ZipRejected(
        "too_many_files",
        `${files.length} files; the limit is ${limits.maxFiles}`,
      );
    if (declared > limits.maxBytes)
      throw new ZipRejected(
        "too_large",
        `${declared} bytes uncompressed; the limit is ${limits.maxBytes}`,
      );
    if (declared >= RATIO_MIN_BYTES && declared / Math.max(1, compressed) > limits.maxRatio)
      throw new ZipRejected("zip_bomb", `archive compression ratio over ${limits.maxRatio}:1`);

    // Unwrap a single top-level folder (`project-main/...`).
    const tops = new Set(files.map((f) => f.path.split("/")[0]));
    const unwrapped =
      tops.size === 1 && files.every((f) => f.path.includes("/")) ? ([...tops][0] as string) : null;
    const seen = new Set<string>();
    const root = resolve(dest);
    await mkdir(root, { recursive: true });

    let written = 0;
    const out: ExtractResult["files"] = [];
    for (const f of files) {
      const rel = unwrapped ? f.path.slice(unwrapped.length + 1) : f.path;
      const key = rel.toLowerCase();
      if (seen.has(key))
        throw new ZipRejected("duplicate_path", `duplicate path: ${rel}`, f.entry.fileName);
      seen.add(key);
      const target = join(root, ...rel.split("/"));
      const back = relative(root, target);
      if (back.startsWith("..") || back.split(sep).includes(".."))
        throw new ZipRejected(
          "path_traversal",
          `escapes the extraction root: ${rel}`,
          f.entry.fileName,
        );
      await mkdir(dirname(target), { recursive: true });
      const stream = await new Promise<NodeJS.ReadableStream>((ok, fail) =>
        zip.openReadStream(f.entry, (err, s) =>
          err || !s
            ? fail(new ZipRejected("invalid_zip", err?.message ?? "unreadable entry"))
            : ok(s),
        ),
      );
      let entryBytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          entryBytes += chunk.length;
          written += chunk.length;
          if (written > limits.maxBytes) {
            cb(
              new ZipRejected(
                "too_large",
                `more than ${limits.maxBytes} bytes after decompression`,
                f.entry.fileName,
              ),
            );
            return;
          }
          cb(null, chunk);
        },
      });
      // Regular files only: never setuid/setgid; keep the owner-execute bit for scripts.
      const exec = ((f.entry.externalFileAttributes >>> 16) & 0o100) !== 0;
      try {
        await pipeline(
          stream,
          meter,
          createWriteStream(target, { flags: "wx", mode: exec ? 0o755 : 0o644 }),
        );
      } catch (e) {
        if (e instanceof ZipRejected) throw e;
        throw new ZipRejected("invalid_zip", (e as Error).message, f.entry.fileName);
      }
      out.push({ path: rel, size: entryBytes });
    }
    return { files: out.sort((a, b) => a.path.localeCompare(b.path)), bytes: written, unwrapped };
  } finally {
    zip.close();
  }
}
