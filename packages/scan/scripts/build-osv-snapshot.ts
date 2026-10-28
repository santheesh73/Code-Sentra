/**
 * Builds the offline OSV snapshot used by tests (fixtures/osv/). Downloads the official
 * per-ecosystem dumps (https://osv-vulnerabilities.storage.googleapis.com/<eco>/all.zip,
 * the same data osv-scanner's offline mode uses), keeps every record that names a package
 * from the given lockfiles, and writes SNAPSHOT.json with what it covers and when.
 * Ecosystems the lockfiles do not name keep their existing records and entry, so adding
 * an ecosystem does not refresh (and shift) the others.
 *
 *   pnpm --filter @codesentra/scan build
 *   node packages/scan/scripts/build-osv-snapshot.ts fixtures/osv <lockfile>...
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { normalizePyName, parseLockfile } from "../dist/audit/lockfiles.js";

const [outDir, ...lockfiles] = process.argv.slice(2);
if (!outDir || !lockfiles.length) {
  console.error("usage: build-osv-snapshot.ts <outDir> <lockfile>...");
  process.exit(2);
}

const wanted = new Map<string, Set<string>>();
for (const f of lockfiles) {
  const parsed = parseLockfile(
    f.split("/").slice(-1)[0].startsWith("requirements") ? f : f,
    await readFile(f, "utf8"),
  );
  if (!parsed) throw new Error(`cannot read ${f}`);
  const set = wanted.get(parsed.ecosystem) ?? new Set<string>();
  for (const p of parsed.packages)
    set.add(parsed.ecosystem === "PyPI" ? normalizePyName(p.name) : p.name);
  wanted.set(parsed.ecosystem, set);
}

const previous = await readFile(join(outDir, "SNAPSHOT.json"), "utf8")
  .then((t) => JSON.parse(t) as { ecosystems?: Record<string, unknown> })
  .catch(() => null);
const manifest: Record<string, unknown> = {
  source: "https://osv-vulnerabilities.storage.googleapis.com",
  fetchedAt: new Date().toISOString(),
  ecosystems: { ...(previous?.ecosystems ?? {}) },
};
for (const [eco, names] of wanted) {
  const url = `https://osv-vulnerabilities.storage.googleapis.com/${eco}/all.zip`;
  const zipPath = join(tmpdir(), `osv-${eco}-all.zip`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));
  const dir = join(outDir, eco);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const kept: string[] = [];
  await new Promise<void>((ok, fail) =>
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return fail(err);
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, s) => {
          if (err2 || !s) return fail(err2);
          const chunks: Buffer[] = [];
          s.on("data", (c) => chunks.push(c));
          s.on("end", async () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const rec = JSON.parse(text) as {
              id: string;
              affected?: { package?: { ecosystem?: string; name?: string } }[];
            };
            const hit = rec.affected?.some((a) => {
              const n = a.package?.name ?? "";
              return (
                a.package?.ecosystem === eco && names.has(eco === "PyPI" ? normalizePyName(n) : n)
              );
            });
            if (hit) {
              kept.push(rec.id);
              await writeFile(join(dir, `${rec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
            }
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => ok());
      zip.readEntry();
    }),
  );
  (manifest.ecosystems as Record<string, unknown>)[eco] = {
    fetchedAt: new Date().toISOString(),
    lastModified: res.headers.get("last-modified"),
    packages: [...names].sort(),
    records: kept.sort(),
  };
  await rm(zipPath, { force: true });
  console.log(`${eco}: ${names.size} packages, ${kept.length} records`);
}
await writeFile(join(outDir, "SNAPSHOT.json"), `${JSON.stringify(manifest, null, 2)}\n`);
