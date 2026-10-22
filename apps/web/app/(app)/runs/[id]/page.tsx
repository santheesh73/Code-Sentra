"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PulseFindings } from "@/components/pulse-findings";
import { ScanReportView } from "@/components/scan-report";
import { PulseStatusBadge, RunStatusBadge, StepStatusIcon } from "@/components/status";
import { Card, CardTitle, Notice, Spinner } from "@/components/ui/primitives";
import { api, isPulseOutcome, problemMessage, type Run } from "@/lib/api";
import { cn, formatDuration, formatTime } from "@/lib/utils";

const TERMINAL = new Set(["succeeded", "failed", "partial"]);

const STEP_LABELS: Record<string, string> = {
  database: "Database round trip",
  queue: "Job queue pickup",
  object_storage: "Object storage write/read",
  reachability: "Reachability (DNS, TLS, main URL)",
  platform: "Hosting platform",
  render: "Browser render",
  routes: "Linked routes",
  hygiene: "Headers and hygiene",
  issues: "Issue tracking",
  ingest: "Ingest (extract or clone, limits)",
  map: "Map (manifests, code graph, routes, env vars)",
  history: "History (commits, hotspots, co-change)",
  probe: "Probes (install, build, tests in the sandbox; audit; secrets)",
  inventory: "Feature inventory",
  explain: "Report (claims verified against evidence)",
};

/** Subscribes to the run's SSE stream and keeps the query cache in step with it. */
function useLiveRun(id: string) {
  const qc = useQueryClient();
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "closed">(
    "connecting",
  );
  const query = useQuery({ queryKey: ["run", id], queryFn: () => api<Run>(`/v1/runs/${id}`) });
  const terminal = query.data ? TERMINAL.has(query.data.status) : false;

  useEffect(() => {
    if (terminal) {
      setConnection("closed");
      return;
    }
    const es = new EventSource(`/api/v1/runs/${id}/stream`);
    es.addEventListener("open", () => setConnection("live"));
    es.addEventListener("run", (e) => {
      const run = JSON.parse((e as MessageEvent<string>).data) as Run;
      qc.setQueryData(["run", id], run);
      if (TERMINAL.has(run.status)) {
        es.close();
        setConnection("closed");
        if (run.project_id) {
          void qc.invalidateQueries({ queryKey: ["runs", run.project_id] });
          void qc.invalidateQueries({ queryKey: ["project", run.project_id] });
          void qc.invalidateQueries({ queryKey: ["projects", run.org_id] });
        }
      }
    });
    es.addEventListener("error", () => {
      if (es.readyState === EventSource.CLOSED) setConnection("closed");
      else setConnection("reconnecting");
    });
    return () => es.close();
  }, [id, terminal, qc]);

  return { ...query, connection };
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const run = useLiveRun(id);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (run.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading run…
      </p>
    );
  }
  if (run.isError) {
    return (
      <Notice tone="danger" title="Could not load this run">
        {problemMessage(run.error)}
      </Notice>
    );
  }
  const r = run.data;
  const pulse = r.type === "pulse" && isPulseOutcome(r.outcome) ? r.outcome : null;
  // A Pulse outcome names gaps per check group (including ones no step records, such as
  // a blocked target); other runs report skipped steps.
  const gaps = pulse ? pulse.gaps.map((g) => ({ step: g.group, reason: g.reason })) : r.gaps;

  return (
    <div className="flex flex-col gap-6">
      <div>
        {r.project_id && (
          <Link
            href={`/projects/${r.project_id}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Project
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold capitalize">{r.type} run</h1>
          <span aria-live="polite" className="flex items-center gap-2">
            <RunStatusBadge status={r.status} />
            {pulse && <PulseStatusBadge status={pulse.pulse_status} gaps={pulse.gaps} />}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="connection">
            {run.connection === "live"
              ? "● Live"
              : run.connection === "reconnecting"
                ? "Reconnecting…"
                : run.connection === "connecting"
                  ? "Connecting…"
                  : ""}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Started {formatTime(r.started_at ?? r.created_at)}
          {r.finished_at && ` · finished ${formatTime(r.finished_at)}`}
        </p>
        {pulse && (
          <p className="text-sm text-muted-foreground">
            {pulse.final_url && (
              <>
                Final URL <span className="break-all font-mono text-xs">{pulse.final_url}</span>
              </>
            )}
            {pulse.platform && ` · ${pulse.platform.name} (${pulse.platform.environment})`}
          </p>
        )}
      </div>

      {r.error && (
        <Notice tone="danger" title="The run failed">
          {r.error}
        </Notice>
      )}
      {gaps.length > 0 && (
        <Notice tone="warning" title="Not everything was checked">
          <ul className="list-disc pl-5" data-testid="gaps">
            {gaps.map((g) => (
              <li key={g.step}>
                <span className="font-medium">{STEP_LABELS[g.step] ?? g.step}:</span> {g.reason}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <Card>
        <CardTitle className="mb-4">Steps</CardTitle>
        <ol className="flex flex-col" aria-label="Run steps">
          {r.steps.map((st, i) => (
            <li
              key={st.name}
              className="relative flex gap-3 pb-5 last:pb-0"
              data-testid={`step-${st.name}`}
              data-status={st.status}
            >
              {i < r.steps.length - 1 && (
                <span
                  aria-hidden
                  className="absolute left-[9px] top-6 h-[calc(100%-1.25rem)] w-px bg-border"
                />
              )}
              <StepStatusIcon status={st.status} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{STEP_LABELS[st.name] ?? st.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDuration(st.duration_ms)}
                  </span>
                </div>
                {st.status === "skipped" && st.gap_reason && (
                  <p className="text-sm text-warning">Not checked: {st.gap_reason}</p>
                )}
                {st.error && <p className="text-sm text-danger">{st.error}</p>}
                {st.log && (
                  <div>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline"
                      aria-expanded={open[st.name] ?? false}
                      onClick={() => setOpen({ ...open, [st.name]: !open[st.name] })}
                    >
                      {open[st.name] ? "Hide log" : "Show log"}
                    </button>
                    <pre
                      className={cn(
                        "mt-1 overflow-x-auto rounded bg-muted p-2 font-mono text-xs",
                        !open[st.name] && "hidden",
                      )}
                    >
                      {st.log}
                    </pre>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {r.type === "pulse" && TERMINAL.has(r.status) && <PulseFindings runId={r.id} />}
      {r.type === "scan" && TERMINAL.has(r.status) && <ScanReportView runId={r.id} />}
    </div>
  );
}
