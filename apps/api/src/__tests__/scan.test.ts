import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  FIXTURE_MODEL_NAME,
  FIXTURE_REPOS_DIR,
  fixtureReportModel,
  loadFixtureRepos,
} from "@codesentra/fixture-harness";
import { listTree, offlineSource } from "@codesentra/scan";
import { scanHandler } from "@codesentra/scan/job";
import { testPolicy } from "@codesentra/ssrf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yazl from "yazl";
import { as, memoryStore, signIn, startTestApi, type TestApi } from "./helpers.js";

/**
 * Scan through the API: zip upload → scan run → report. The sandbox is withheld here, so
 * the probe stage is a gap (Rule 2); the sandboxed gate runs in packages/scan and e2e.
 */
let api: TestApi;
let cookie: string;
let orgId: string;
let zipBody: Buffer;
let work: string;
const store = memoryStore();
const repo = loadFixtureRepos().find((r) => r.expected.name === "ts-taskboard");

beforeAll(async () => {
  if (!repo) throw new Error("ts-taskboard fixture missing");
  work = await mkdtemp(join(tmpdir(), "cs-api-scan-"));
  const zip = new yazl.ZipFile();
  for (const f of (await listTree(repo.repoDir)).files)
    zip.addFile(join(repo.repoDir, f.path), f.path);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(join(work, "repo.zip")));
  zipBody = await readFile(join(work, "repo.zip"));
  const osv = await offlineSource(join(FIXTURE_REPOS_DIR, "../osv"));
  api = await startTestApi({
    store,
    env: { PULSE_TEST_ALLOW_HOSTS: "127.0.0.1" },
    handlers: {
      "scan.run": scanHandler({
        store,
        sandbox: async () => ({ sandbox: null, reason: "no sandbox in API tests" }),
        osv: { source: osv },
        secrets: { enabled: false, reason: "gitleaks not run in API tests" },
        model: { model: fixtureReportModel() },
        gitPolicy: testPolicy(["127.0.0.1"]),
        allowHttpGit: true,
        maxCommits: 100,
      }),
    },
  });
  cookie = await signIn(api, "scan@example.com");
  orgId = (await api.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).json()
    .organizations[0].id;
}, 180_000);

afterAll(async () => {
  await api?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

async function project(name: string, repoUrl?: string) {
  const res = await api.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: as(cookie),
    payload: { org_id: orgId, name, ...(repoUrl ? { repo_url: repoUrl } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function upload(projectId: string, body: Buffer) {
  return api.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/snapshots`,
    headers: { ...as(cookie), "content-type": "application/zip" },
    payload: body,
  });
}

async function scan(projectId: string, snapshotId?: string) {
  const res = await api.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/scan`,
    headers: as(cookie),
    payload: snapshotId ? { snapshot_id: snapshotId } : {},
  });
  expect(res.statusCode, res.body).toBe(202);
  const runId = res.json().run_id as string;
  for (let i = 0; i < 600; i++) {
    const run = (
      await api.app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie } })
    ).json();
    if (["succeeded", "failed", "partial"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("scan did not finish");
}

describe("Scan API", () => {
  it("scans an uploaded zip and serves a report whose claims cite stored evidence", async () => {
    const id = await project("taskboard");
    const up = await upload(id, zipBody);
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json()).toMatchObject({ kind: "zip", size_bytes: zipBody.length });
    expect(store.objects.has(`snapshots/${orgId}/${up.json().id}.zip`)).toBe(true);

    const run = await scan(id, up.json().id);
    expect(run.type).toBe("scan");
    const steps = Object.fromEntries(
      run.steps.map((s: { name: string; status: string }) => [s.name, s.status]),
    );
    expect(steps).toMatchObject({ ingest: "done", map: "done", probe: "skipped" });
    // A skipped probe is a gap, never a pass (Rule 2).
    expect(run.status).toBe("partial");

    const res = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/report`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json();
    expect(report.cached).toBe(false);
    expect(report.model).toBe(FIXTURE_MODEL_NAME);
    expect(report.features.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining(repo?.expected.features.map((f) => f.name) ?? []),
    );
    expect(report.claims_dropped).toBeGreaterThan(0);
    expect(report.dropped_claims.every((c: { reason: string }) => c.reason.length > 0)).toBe(true);
    expect(report.coverage.gaps.map((g: { stage: string }) => g.stage)).toContain("probe");

    // Deductions cite stored evidence, not internal keys.
    const deductions = report.health.components.flatMap(
      (c: { deductions: { points: number; evidence_ids: string[] }[] }) => c.deductions,
    );
    expect(
      deductions.some(
        (d: { points: number; evidence_ids: string[] }) =>
          d.points > 0 && d.evidence_ids.length > 0,
      ),
    ).toBe(true);

    // Every Scan issue has a prompt (Rule 4), pointing at its file and line.
    const found = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/findings`,
      headers: { cookie },
    });
    expect(found.statusCode, found.body).toBe(200);
    const issues = found.json().issues as {
      code: string;
      prompt: { type: string; body: string };
    }[];
    expect(issues.length).toBeGreaterThan(0);
    const stub = issues.find((i) => i.code === "STUB_IMPLEMENTATION");
    expect(stub?.prompt.type).toBe("code_fix");
    expect(stub?.prompt.body).toContain("src/lib/csv.ts:4");

    // Every cited id resolves to evidence of this run.
    const cited = new Set<string>();
    for (const list of Object.values(report.sections) as { evidence_ids: string[] }[][])
      for (const c of list) for (const e of c.evidence_ids) cited.add(e);
    expect(cited.size).toBeGreaterThan(0);
    for (const e of cited) {
      const ev = await api.app.inject({
        method: "GET",
        url: `/v1/evidence/${e}`,
        headers: { cookie },
      });
      expect(ev.statusCode, e).toBe(200);
      expect(ev.json().run_id).toBe(run.id);
    }
  }, 300_000);

  it("reuses the report of an identical tree and says so", async () => {
    const id = await project("taskboard-again");
    const first = await scan(id, (await upload(id, zipBody)).json().id);
    const second = await scan(id, (await upload(id, zipBody)).json().id);
    expect(second.outcome).toMatchObject({ cached: true, source_run_id: first.id });
    expect(
      second.steps
        .filter((s: { name: string }) => s.name !== "ingest")
        .every((s: { status: string }) => s.status === "skipped"),
    ).toBe(true);
    const report = (
      await api.app.inject({
        method: "GET",
        url: `/v1/runs/${second.id}/report`,
        headers: { cookie },
      })
    ).json();
    expect(report).toMatchObject({ cached: true, source_run_id: first.id, run_id: second.id });
  }, 300_000);

  it("rejects a hostile zip at ingest without running anything else", async () => {
    const id = await project("evil-zip");
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from("x"), "a.txt");
    zip.end();
    const chunks: Buffer[] = [];
    for await (const c of zip.outputStream) chunks.push(c as Buffer);
    // Rewrite the stored name to a traversal of the same length.
    const evil = Buffer.from(
      Buffer.concat(chunks).toString("latin1").replaceAll("a.txt", "../ab"),
      "latin1",
    );
    const run = await scan(id, (await upload(id, evil)).json().id);
    expect(run.status).toBe("failed");
    const ingest = run.steps.find((s: { name: string }) => s.name === "ingest");
    expect(ingest.error).toMatch(/path_traversal/);
    const report = await api.app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/report`,
      headers: { cookie },
    });
    expect(report.statusCode).toBe(404);
  }, 120_000);

  it("refuses bodies that are not zips, and git URLs that are not public https", async () => {
    const id = await project("refusals");
    expect((await upload(id, Buffer.from("not a zip at all"))).statusCode).toBe(400);
    for (const url of [
      "http://example.com/repo.git",
      "https://10.0.0.5/repo.git",
      "https://169.254.169.254/latest",
      "https://localhost/repo.git",
    ]) {
      const res = await api.app.inject({
        method: "POST",
        url: `/v1/projects/${id}/snapshots`,
        headers: as(cookie),
        payload: { kind: "git", url },
      });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(400);
    }
    const noRepo = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${id}/scan`,
      headers: as(cookie),
      payload: {},
    });
    expect(noRepo.statusCode).toBe(400);
  });

  it("will not scan a snapshot that belongs to another project", async () => {
    const a = await project("owner-a");
    const b = await project("owner-b");
    const snap = (await upload(a, zipBody)).json().id;
    const res = await api.app.inject({
      method: "POST",
      url: `/v1/projects/${b}/scan`,
      headers: as(cookie),
      payload: { snapshot_id: snap },
    });
    expect(res.statusCode).toBe(404);
  });
});
