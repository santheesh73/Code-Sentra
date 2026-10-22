import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHistoryRepo, HISTORY_EXPECTED } from "@codesentra/fixture-harness";
import { analyzeHistory, parseGitLog } from "@codesentra/graph";
import { defaultPolicy, testPolicy } from "@codesentra/ssrf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yazl from "yazl";
import { cloneRepo, GitError, gitLog } from "./git.js";
import { listTree, treeHash } from "./tree.js";
import { checkEntryName, DEFAULT_ZIP_LIMITS, extractZip, ZipRejected } from "./zip.js";

const tmp: string[] = [];
async function scratch() {
  const d = await mkdtemp(join(tmpdir(), "cs-ingest-test-"));
  tmp.push(d);
  return d;
}
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

// --- A raw zip writer: yazl refuses the malicious names this suite needs. -------------
interface RawEntry {
  name: string;
  data?: Buffer;
  /** Unix mode in the high 16 bits of external attributes. */
  mode?: number;
  deflate?: boolean;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
  encrypted?: boolean;
}
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const plain = e.deflate ? deflateRawSync(data) : data;
    // A well-formed (if fake) traditional-encryption entry carries a 12-byte header.
    const body = e.encrypted ? Buffer.concat([Buffer.alloc(12, 1), plain]) : plain;
    const name = Buffer.from(e.name, "utf8");
    const size = e.declaredSize ?? data.length;
    const flags = 0x0800 | (e.encrypted ? 1 : 0);
    const method = e.deflate ? 8 : 0;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
async function zipFile(entries: RawEntry[]): Promise<string> {
  const p = join(await scratch(), "in.zip");
  writeFileSync(p, rawZip(entries));
  return p;
}
async function rejectionOf(p: Promise<unknown>): Promise<ZipRejected> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ZipRejected) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}
const f = (name: string, text = "x") => ({ name, data: Buffer.from(text) });

describe("zip safety suite (Section 8.1)", () => {
  it("extracts a normal archive and unwraps a single top-level folder", async () => {
    const dest = await scratch();
    const r = await extractZip(
      await zipFile([
        f("proj-main/"),
        f("proj-main/README.md", "# hi"),
        f("proj-main/src/a.ts", "export {}"),
        { name: "proj-main/run.sh", data: Buffer.from("#!/bin/sh"), mode: 0o100755 },
      ]),
      join(dest, "out"),
    );
    expect(r.unwrapped).toBe("proj-main");
    expect(r.files.map((x) => x.path)).toEqual(["README.md", "run.sh", "src/a.ts"]);
    expect(readFileSync(join(dest, "out/src/a.ts"), "utf8")).toBe("export {}");
    expect(lstatSync(join(dest, "out/run.sh")).mode & 0o7777).toBe(0o755);
  });

  it("does not unwrap when there are several top-level entries", async () => {
    const r = await extractZip(await zipFile([f("a/x"), f("b.txt")]), join(await scratch(), "o"));
    expect(r.unwrapped).toBeNull();
  });

  it.each([
    ["symlink", { name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }],
    ["absolute_path", f("/etc/cron.d/evil")],
    ["absolute_path", f("C:/Windows/evil.dll")],
    ["path_traversal", f("../../outside.txt")],
    ["path_traversal", f("a/../../outside.txt")],
    // Backslashes are normalized to "/" first, so the ".." is caught.
    ["path_traversal", f("a\\..\\evil")],
    ["bad_name", f("nul\u0000byte")],
    ["encrypted", { ...f("secret.txt"), encrypted: true }],
  ] as const)("rejects %s (%j)", async (code, entry) => {
    const dest = join(await scratch(), "o");
    const e = await rejectionOf(extractZip(await zipFile([f("ok.txt"), entry as RawEntry]), dest));
    expect(e.code, e.message).toBe(code);
    // Nothing is written when validation fails.
    expect(existsSync(join(dest, "ok.txt"))).toBe(false);
    expect(existsSync(normalize(join(dest, "../outside.txt")))).toBe(false);
  });

  it("rejects duplicate paths (including case-only differences)", async () => {
    const e = await rejectionOf(
      extractZip(await zipFile([f("a.txt"), f("A.txt")]), join(await scratch(), "o")),
    );
    expect(e.code).toBe("duplicate_path");
  });

  it("enforces file count, depth and size limits", async () => {
    const limits = { ...DEFAULT_ZIP_LIMITS, maxFiles: 3, maxDepth: 4, maxBytes: 100 };
    const many = Array.from({ length: 4 }, (_, i) => f(`f${i}`));
    expect(
      (await rejectionOf(extractZip(await zipFile(many), join(await scratch(), "o"), limits))).code,
    ).toBe("too_many_files");
    const deep = f("a/b/c/d/e.txt");
    expect(
      (await rejectionOf(extractZip(await zipFile([deep]), join(await scratch(), "o"), limits)))
        .code,
    ).toBe("too_deep");
    const big = { name: "big", data: Buffer.alloc(101) };
    expect(
      (await rejectionOf(extractZip(await zipFile([big]), join(await scratch(), "o"), limits)))
        .code,
    ).toBe("too_large");
  });

  it("rejects a compression-ratio bomb from its headers", async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const e = await rejectionOf(
      extractZip(
        await zipFile([{ name: "zeros", data: zeros, deflate: true }]),
        join(await scratch(), "o"),
      ),
    );
    expect(e.code).toBe("zip_bomb");
  });

  it("does not trust a header that understates the size", async () => {
    const limits = { ...DEFAULT_ZIP_LIMITS, maxBytes: 1000 };
    const liar = { name: "liar", data: Buffer.alloc(5000, 7), deflate: true, declaredSize: 10 };
    const e = await rejectionOf(
      extractZip(await zipFile([liar]), join(await scratch(), "o"), limits),
    );
    expect(["too_large", "invalid_zip"]).toContain(e.code);
  });

  it("rejects something that is not a zip", async () => {
    const p = join(await scratch(), "x.zip");
    writeFileSync(p, "not a zip at all");
    expect((await rejectionOf(extractZip(p, join(await scratch(), "o")))).code).toBe("invalid_zip");
  });

  it("works with archives made by a real zip writer (yazl)", async () => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from("hello"), "repo/a.txt");
    z.end();
    const p = join(await scratch(), "y.zip");
    await new Promise<void>((ok) =>
      z.outputStream.pipe(createWriteStream(p)).on("close", () => ok()),
    );
    const r = await extractZip(p, join(await scratch(), "o"));
    expect(r.files).toEqual([{ path: "a.txt", size: 5 }]);
  });

  it("validates names directly", () => {
    expect(checkEntryName("src/./a.ts")).toBe("src/a.ts");
    expect(() => checkEntryName("..")).toThrow(ZipRejected);
  });
});

describe("tree listing and hash", () => {
  it("skips .git and symlinks, and hashes content deterministically", async () => {
    const d = await scratch();
    writeFileSync(join(d, "a.txt"), "1");
    execFileSync("mkdir", ["-p", join(d, ".git"), join(d, "src")]);
    writeFileSync(join(d, ".git/HEAD"), "ref");
    writeFileSync(join(d, "src/b.ts"), "2");
    execFileSync("ln", ["-s", "/etc/passwd", join(d, "evil")]);
    const t = await listTree(d);
    expect(t.files.map((x) => x.path)).toEqual(["a.txt", "src/b.ts"]);
    expect(t.skippedSymlinks).toEqual(["evil"]);
    const h1 = await treeHash(d, t.files);
    expect(h1).toBe(await treeHash(d, t.files));
    writeFileSync(join(d, "a.txt"), "changed");
    expect(await treeHash(d, t.files)).not.toBe(h1);
  });
});

describe("git ingest", () => {
  let server: Server;
  let base: string;
  let redirectBase: string;
  let redirector: Server;
  let repo: string;

  beforeAll(async () => {
    repo = createHistoryRepo(await scratch());
    // A symlink committed to the repo must be checked out as a plain file.
    execFileSync("ln", ["-s", "/etc/passwd", join(repo, "passwd-link")]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"]);
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "link"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-09T12:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-09T12:00:00Z",
        },
      },
    );
    const root = await scratch();
    execFileSync("git", ["clone", "-q", "--bare", repo, join(root, "repo.git")]);
    // Smart HTTP (shallow clones need it): `git http-backend` as CGI.
    server = createServer((req, res) => {
      const [pathInfo = "/", query = ""] = (req.url ?? "/").split("?");
      const cgi = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: decodeURIComponent(pathInfo),
          QUERY_STRING: query,
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          REMOTE_ADDR: "127.0.0.1",
        },
      });
      req.pipe(cgi.stdin);
      let head = Buffer.alloc(0);
      let headersDone = false;
      cgi.stdout.on("data", (chunk: Buffer) => {
        if (headersDone) {
          res.write(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        const sep = head.indexOf("\r\n\r\n");
        if (sep === -1) return;
        headersDone = true;
        let status = 200;
        for (const line of head.subarray(0, sep).toString().split("\r\n")) {
          const i = line.indexOf(":");
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
          else res.setHeader(k, v);
        }
        res.writeHead(status);
        res.write(head.subarray(sep + 4));
      });
      cgi.stdout.on("end", () => res.end());
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    redirector = createServer((_req, res) =>
      res.writeHead(302, { location: `${base}/repo.git/info/refs` }).end(),
    );
    await new Promise<void>((ok) => redirector.listen(0, "127.0.0.1", () => ok()));
    redirectBase = `http://127.0.0.1:${(redirector.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise((ok) => server?.close(ok));
    await new Promise((ok) => redirector?.close(ok));
  });

  const policy = () => testPolicy(["127.0.0.1"]);

  it("clones through the pinned address and yields the generated history", async () => {
    const dest = join(await scratch(), "clone");
    const { commitSha } = await cloneRepo(`${base}/repo.git`, dest, {
      policy: policy(),
      allowHttp: true,
    });
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    // Symlinks become plain files containing the link text.
    expect(lstatSync(join(dest, "passwd-link")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, "passwd-link"), "utf8")).toBe("/etc/passwd");
    const commits = parseGitLog(await gitLog(dest)).filter((c) => !c.files.includes("passwd-link"));
    const h = analyzeHistory(commits);
    expect(h.commits).toBe(HISTORY_EXPECTED.commits);
    expect(h.contributors).toBe(HISTORY_EXPECTED.contributors);
    expect(h.coChanges[0]).toEqual(HISTORY_EXPECTED.coChange);
  });

  it("caps history depth", async () => {
    const dest = join(await scratch(), "shallow");
    await cloneRepo(`${base}/repo.git`, dest, { policy: policy(), allowHttp: true, maxCommits: 3 });
    expect(parseGitLog(await gitLog(dest))).toHaveLength(3);
  });

  it("refuses private addresses under the default policy", async () => {
    await expect(
      cloneRepo(`https://127.0.0.1/repo.git`, join(await scratch(), "x"), {
        policy: defaultPolicy(),
      }),
    ).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("refuses plain http unless the host is on the test allowance", async () => {
    await expect(
      cloneRepo(`${base}/repo.git`, join(await scratch(), "x"), { policy: policy() }),
    ).rejects.toMatchObject({
      code: "invalid_url",
    });
    await expect(
      cloneRepo(`http://example.com/repo.git`, join(await scratch(), "x"), {
        policy: policy(),
        allowHttp: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("refuses other transports and credentials in the URL", async () => {
    for (const url of [
      "file:///etc",
      "ssh://git@example.com/x.git",
      "git://example.com/x",
      "ext::sh -c id",
      "https://u:p@example.com/x.git",
    ]) {
      await expect(
        cloneRepo(url, join(await scratch(), "x"), { policy: policy() }),
        url,
      ).rejects.toBeInstanceOf(GitError);
    }
  });

  it("does not follow redirects", async () => {
    await expect(
      cloneRepo(`${redirectBase}/repo.git`, join(await scratch(), "x"), {
        policy: policy(),
        allowHttp: true,
      }),
    ).rejects.toMatchObject({ code: "clone_failed" });
  });
});
