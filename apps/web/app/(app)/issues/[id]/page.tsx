"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { EvidenceButton, EvidenceDrawer } from "@/components/evidence-drawer";
import { PromptCard } from "@/components/prompt-card";
import { IssueStatusBadge, SeverityBadge } from "@/components/status";
import { Button, Card, CardTitle, Input, Label, Notice, Spinner } from "@/components/ui/primitives";
import { api, type Evidence, type Issue, type IssueDetail, problemMessage } from "@/lib/api";
import { formatTime } from "@/lib/utils";

const EVENT_LABEL: Record<string, string> = {
  opened: "Opened",
  seen: "Seen again",
  resolved: "Resolved (re-check passed)",
  regressed: "Regressed",
  dismissed: "Dismissed",
};

export default function IssuePage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [reason, setReason] = useState("");
  const q = useQuery({
    queryKey: ["issue", id],
    queryFn: () => api<IssueDetail>(`/v1/issues/${id}`),
  });
  const router = useRouter();
  const recheck = useMutation({
    mutationFn: () => api<{ run_id: string }>(`/v1/issues/${id}/recheck`, { method: "POST" }),
    onSuccess: ({ run_id }) => router.push(`/runs/${run_id}`),
  });
  const dismiss = useMutation({
    mutationFn: () => api<Issue>(`/v1/issues/${id}/dismiss`, { method: "POST", body: { reason } }),
    onSuccess: (issue) => {
      setReason("");
      void qc.invalidateQueries({ queryKey: ["issue", id] });
      void qc.invalidateQueries({ queryKey: ["issues", issue.project_id] });
      void qc.invalidateQueries({ queryKey: ["project", issue.project_id] });
    },
  });

  if (q.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading issue…
      </p>
    );
  }
  if (q.isError) {
    return (
      <Notice tone="danger" title="Could not load this issue">
        {problemMessage(q.error)}
      </Notice>
    );
  }
  const i = q.data;
  const onDismiss = (e: FormEvent) => {
    e.preventDefault();
    dismiss.mutate();
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/projects/${i.project_id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Project
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{i.title}</h1>
          <IssueStatusBadge status={i.status} />
          <SeverityBadge severity={i.severity} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono text-xs">{i.code}</span>
          {i.corroborating_codes.length > 0 &&
            ` · also shown by ${i.corroborating_codes.join(", ")}`}
          {" · "}first seen in{" "}
          <Link href={`/runs/${i.first_seen_run_id}`} className="underline">
            this run
          </Link>
          , last seen in{" "}
          <Link href={`/runs/${i.last_seen_run_id}`} className="underline">
            this run
          </Link>
        </p>
      </div>

      {i.status === "dismissed" && i.dismissed_reason && (
        <Notice title="Dismissed">{i.dismissed_reason}</Notice>
      )}

      <Card>
        <CardTitle className="mb-3">What was observed</CardTitle>
        <p className="mb-3 text-sm">{i.summary}</p>
        <ul className="flex flex-col gap-1 text-sm" data-testid="observed">
          {i.observed.map((f) => (
            <li key={f.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground">{f.code}</span>
              <span>{f.message}</span>
              <EvidenceButton onClick={() => setEvidence(f.evidence)} />
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" data-testid="recheck">
            Re-check ({i.recheck.module} · {i.recheck.check_group}): {i.recheck.expectation}
          </p>
          {i.status !== "dismissed" && (
            <Button
              variant="outline"
              size="sm"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              {recheck.isPending ? "Starting…" : "Re-check now"}
            </Button>
          )}
        </div>
        {recheck.isError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {problemMessage(recheck.error)}
          </p>
        )}
      </Card>

      <Card data-testid="trace">
        <CardTitle className="mb-3">Where it comes from</CardTitle>
        {i.traces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Not traced to code yet: CodeSentra links an issue to a file only on an exact match with
            a Scan of the project (run a full check after uploading the source). The prompt below is
            an unconfirmed lead until then.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {i.traces.map((t) => (
              <li key={`${t.path}:${t.line}`} className="flex flex-col gap-1 text-sm">
                <span>
                  <code className="font-mono" data-testid="trace-location">
                    {t.line ? `${t.path}:${t.line}` : t.path}
                  </code>
                  {t.symbol && <span className="text-muted-foreground"> in {t.symbol}</span>}
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · verified on <code className="font-mono">{t.join_key}</code>
                  </span>
                </span>
                {t.excerpt && (
                  <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                    {t.excerpt}
                  </pre>
                )}
                {t.env_vars.length > 0 && (
                  <span className="text-xs" data-testid="trace-env">
                    Environment variables:{" "}
                    {t.env_vars.map((v, n) => (
                      <span key={v.name}>
                        {n > 0 && ", "}
                        <code className="font-mono">{v.name}</code>
                        {v.documented ? " (documented)" : " (not in .env.example)"}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {i.blast_radius.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-1 text-sm font-semibold">Blast radius</h3>
            <ul className="flex flex-col gap-1 text-sm" data-testid="blast-radius">
              {i.blast_radius.map((b) => (
                <li key={b.path}>
                  <code className="font-mono text-xs">{b.path}</code>{" "}
                  <span className="text-muted-foreground">— {b.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle className="mb-3">Fix prompt</CardTitle>
        <PromptCard prompt={i.prompt} />
      </Card>

      <Card>
        <CardTitle className="mb-3">History</CardTitle>
        <ol className="flex flex-col gap-2 text-sm" aria-label="Issue history">
          {i.events.map((ev) => (
            <li key={`${ev.kind}-${ev.at}`} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{EVENT_LABEL[ev.kind] ?? ev.kind}</span>
              <span className="text-muted-foreground">{formatTime(ev.at)}</span>
              {ev.run_id && (
                <Link href={`/runs/${ev.run_id}`} className="text-xs underline">
                  run
                </Link>
              )}
              {ev.note && <span className="text-muted-foreground">— {ev.note}</span>}
            </li>
          ))}
        </ol>
      </Card>

      {i.status !== "dismissed" && (
        <Card>
          <CardTitle className="mb-3">Dismiss</CardTitle>
          <form onSubmit={onDismiss} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="dismiss-reason">Reason (kept in the audit log)</Label>
              <Input
                id="dismiss-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                maxLength={500}
                required
                placeholder="e.g. Intentional: this route is behind a login"
              />
            </div>
            <Button type="submit" variant="outline" disabled={dismiss.isPending}>
              {dismiss.isPending ? "Dismissing…" : "Dismiss issue"}
            </Button>
          </form>
          {dismiss.isError && (
            <p className="mt-2 text-sm text-danger" role="alert">
              {problemMessage(dismiss.error)}
            </p>
          )}
        </Card>
      )}

      <EvidenceDrawer evidence={evidence} onClose={() => setEvidence(null)} />
    </div>
  );
}
