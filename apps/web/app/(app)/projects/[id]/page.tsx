"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, FileArchive, GitBranch, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import {
  FeatureStatusBadge,
  IssueStatusBadge,
  PulseStatusBadge,
  RunStatusBadge,
  SeverityBadge,
} from "@/components/status";
import { Button, Card, CardTitle, Input, Label, Notice, Spinner } from "@/components/ui/primitives";
import {
  api,
  type Issue,
  isPulseOutcome,
  type Project,
  problemMessage,
  type RunSummary,
  type ScanReport,
  uploadZip,
} from "@/lib/api";
import { formatTime } from "@/lib/utils";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<Project>(`/v1/projects/${id}`),
  });
  const runs = useQuery({
    queryKey: ["runs", id],
    queryFn: () => api<RunSummary[]>(`/v1/projects/${id}/runs`),
  });

  const [showAll, setShowAll] = useState(false);
  const issues = useQuery({
    queryKey: ["issues", id, showAll],
    queryFn: () =>
      api<Issue[]>(`/v1/projects/${id}/issues${showAll ? "" : "?status=open,regressed"}`),
  });

  const pulse = useMutation({
    mutationFn: (environmentId: string) =>
      api<{ run_id: string }>(`/v1/projects/${id}/pulse`, {
        method: "POST",
        body: { environment_id: environmentId },
      }),
    onSuccess: ({ run_id }) => {
      void qc.invalidateQueries({ queryKey: ["runs", id] });
      router.push(`/runs/${run_id}`);
    },
  });

  const check = useMutation({
    mutationFn: () =>
      api<{ run_id: string }>(`/v1/projects/${id}/check`, { method: "POST", body: {} }),
    onSuccess: ({ run_id }) => {
      void qc.invalidateQueries({ queryKey: ["runs", id] });
      router.push(`/runs/${run_id}`);
    },
  });

  const diagnostic = useMutation({
    mutationFn: () => api<{ run_id: string }>(`/v1/projects/${id}/diagnostic`, { method: "POST" }),
    onSuccess: ({ run_id }) => {
      void qc.invalidateQueries({ queryKey: ["runs", id] });
      void qc.invalidateQueries({ queryKey: ["project", id] });
      router.push(`/runs/${run_id}`);
    },
  });

  if (project.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading project…
      </p>
    );
  }
  if (project.isError) {
    return (
      <Notice tone="danger" title="Could not load this project">
        {problemMessage(project.error)}
      </Notice>
    );
  }
  const p = project.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/projects" className="text-sm text-muted-foreground hover:underline">
            ← Projects
          </Link>
          <h1 className="text-2xl font-semibold">{p.name}</h1>
          {p.repo_url && <p className="truncate text-sm text-muted-foreground">{p.repo_url}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/projects/${id}/settings`}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Settings aria-hidden className="size-4" /> Settings
          </Link>
          <Button onClick={() => check.mutate()} disabled={check.isPending}>
            <ShieldCheck aria-hidden className="size-4" />
            {check.isPending ? "Starting…" : "Run full check"}
          </Button>
          <Button
            variant="outline"
            onClick={() => diagnostic.mutate()}
            disabled={diagnostic.isPending}
          >
            <Activity aria-hidden className="size-4" />
            {diagnostic.isPending ? "Starting…" : "Run diagnostic"}
          </Button>
        </div>
      </div>
      {check.isError && <Notice tone="danger">{problemMessage(check.error)}</Notice>}
      {diagnostic.isError && <Notice tone="danger">{problemMessage(diagnostic.error)}</Notice>}
      {pulse.isError && <Notice tone="danger">{problemMessage(pulse.error)}</Notice>}

      <div className="grid gap-6 lg:grid-cols-2">
        <ScanCard
          projectId={id}
          repoUrl={p.repo_url}
          latest={p.latest_scan}
          onStarted={(runId) => {
            void qc.invalidateQueries({ queryKey: ["runs", id] });
            router.push(`/runs/${runId}`);
          }}
        />
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{showAll ? "All issues" : "Open issues"}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show open only" : "Show all"}
            </Button>
          </div>
          {issues.isPending ? (
            <Spinner />
          ) : issues.isError ? (
            <Notice tone="danger">{problemMessage(issues.error)}</Notice>
          ) : issues.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {p.environments.some((e) => e.status)
                ? "No open issues from the latest checks."
                : "No issues yet: run Pulse on an environment to check it."}
            </p>
          ) : (
            <ul className="divide-y divide-border" aria-label="Issues">
              {issues.data.map((i) => (
                <li key={i.id}>
                  <Link
                    href={`/issues/${i.id}`}
                    className="flex flex-col gap-1 py-2 text-sm hover:underline"
                  >
                    <span className="font-medium">{i.title}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={i.severity} />
                      <IssueStatusBadge status={i.status} />
                      <code className="text-xs text-muted-foreground">{i.code}</code>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="flex flex-col gap-4">
        <CardTitle>Environments</CardTitle>
        {p.environments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deploy URLs yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {p.environments.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">{e.name}</span>{" "}
                  <a
                    href={e.url}
                    className="break-all text-muted-foreground hover:underline"
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {e.url}
                  </a>
                </span>
                <span className="flex items-center gap-2">
                  {e.status ? (
                    <Link
                      href={`/runs/${e.status.run_id}`}
                      title={`Checked ${formatTime(e.status.checked_at)}`}
                    >
                      <PulseStatusBadge status={e.status.pulse_status} gaps={e.status.gaps} />
                    </Link>
                  ) : (
                    <PulseStatusBadge status={null} />
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pulse.isPending}
                    onClick={() => pulse.mutate(e.id)}
                    aria-label={`Check ${e.name} now`}
                  >
                    Check now
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <AddEnvironment
          projectId={id}
          onAdded={() => qc.invalidateQueries({ queryKey: ["project", id] })}
        />
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Runs</CardTitle>
        {runs.isPending ? (
          <Spinner />
        ) : runs.isError ? (
          <Notice tone="danger">{problemMessage(runs.error)}</Notice>
        ) : runs.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs yet. A diagnostic run checks that the database, queue and object storage work
            end to end.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {runs.data.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/runs/${r.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:underline"
                >
                  <span>
                    <span className="font-medium capitalize">
                      {r.type === "link" ? "check" : r.type}
                    </span>{" "}
                    <span className="text-muted-foreground">{formatTime(r.created_at)}</span>
                  </span>
                  {isPulseOutcome(r.outcome) ? (
                    <PulseStatusBadge status={r.outcome.pulse_status} gaps={r.outcome.gaps} />
                  ) : (
                    <RunStatusBadge status={r.status} />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AddEnvironment({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api(`/v1/projects/${projectId}/environments`, { method: "POST", body: { name, url } }),
    onSuccess: () => {
      setName("");
      setUrl("");
      onAdded();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-env-name">Environment</Label>
        <Input
          id="new-env-name"
          required
          pattern="[a-z0-9][a-z0-9-]*"
          placeholder="preview"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-env-url">URL</Label>
        <Input
          id="new-env-url"
          required
          type="url"
          placeholder="https://preview.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <Button type="submit" variant="outline" disabled={add.isPending}>
        Add
      </Button>
      {add.isError && (
        <p role="alert" className="text-sm text-danger sm:col-span-3">
          {problemMessage(add.error)}
        </p>
      )}
    </form>
  );
}

/** Sentra Scan: upload a zip or scan the repository; links the latest scan's report. */
function ScanCard({
  projectId,
  repoUrl,
  latest,
  onStarted,
}: {
  projectId: string;
  repoUrl: string | null;
  latest: Project["latest_scan"];
  onStarted: (runId: string) => void;
}) {
  const report = useQuery({
    queryKey: ["report", latest?.run_id],
    queryFn: () => api<ScanReport>(`/v1/runs/${latest?.run_id}/report`),
    enabled: !!latest,
    retry: false,
  });
  const [file, setFile] = useState<File | null>(null);
  const start = useMutation({
    mutationFn: async (source: "zip" | "repo") => {
      const snapshotId =
        source === "zip" && file ? (await uploadZip(projectId, file)).id : undefined;
      return api<{ run_id: string }>(`/v1/projects/${projectId}/scan`, {
        method: "POST",
        body: snapshotId ? { snapshot_id: snapshotId } : {},
      });
    },
    onSuccess: ({ run_id }) => onStarted(run_id),
  });
  return (
    <Card className="flex flex-col gap-3" data-testid="scan-card">
      <CardTitle>Scan report</CardTitle>
      {latest ? (
        <>
          <Link
            href={`/runs/${latest.run_id}`}
            className="flex flex-wrap items-center justify-between gap-2 text-sm hover:underline"
          >
            <span>
              Latest scan{" "}
              <span className="text-muted-foreground">{formatTime(latest.finished_at)}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-medium" data-testid="project-health">
                Health {latest.health_score ?? "not measured"}
                {latest.health_score !== null && "/100"}
              </span>
              <RunStatusBadge status={latest.status} />
            </span>
          </Link>
          {report.data && (
            <>
              {[...report.data.sections.summary, ...report.data.sections.value].map((c) => (
                <p key={c.text} className="text-sm">
                  {c.text}
                </p>
              ))}
              {report.data.features.length > 0 && (
                <ul className="divide-y divide-border" aria-label="Feature inventory">
                  {report.data.features.map((f) => (
                    <li
                      key={f.name}
                      className="flex items-center justify-between gap-2 py-1.5 text-sm"
                    >
                      <span className="min-w-0 truncate">{f.name}</span>
                      <FeatureStatusBadge status={f.status} />
                    </li>
                  ))}
                </ul>
              )}
              {report.data.coverage.gaps.length > 0 && (
                <p className="text-xs text-warning">
                  Not checked: {report.data.coverage.gaps.map((g) => g.stage).join(", ")} (see the
                  report)
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No scan yet. Sentra Scan maps the code, runs install, build and tests in a sandbox, audits
          dependencies and secrets, and writes a report whose every claim cites evidence.
        </p>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          start.mutate("zip");
        }}
      >
        <Label htmlFor="scan-zip">Upload a zip of the source</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="scan-zip"
            type="file"
            accept=".zip,application/zip"
            className="max-w-xs"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button type="submit" variant="outline" disabled={!file || start.isPending}>
            <FileArchive aria-hidden className="size-4" />
            Scan zip
          </Button>
          {repoUrl && (
            <Button
              type="button"
              variant="outline"
              disabled={start.isPending}
              onClick={() => start.mutate("repo")}
            >
              <GitBranch aria-hidden className="size-4" />
              Scan repository
            </Button>
          )}
          {start.isPending && <Spinner label="Starting scan" />}
        </div>
      </form>
      {start.isError && (
        <p role="alert" className="text-sm text-danger">
          {problemMessage(start.error)}
        </p>
      )}
    </Card>
  );
}
