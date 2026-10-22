"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { EvidenceButton, EvidenceDrawer } from "@/components/evidence-drawer";
import { PromptCard } from "@/components/prompt-card";
import { SeverityBadge } from "@/components/status";
import { Card, CardTitle, Notice, Spinner } from "@/components/ui/primitives";
import { api, type Evidence, problemMessage, type RunFindings } from "@/lib/api";

/**
 * A finished Pulse run's results: screenshot, the gaps it reports, and every finding
 * grouped into issues, each with its prompt (Rule 4) and the evidence behind it (Rule 1).
 */
export function PulseFindings({
  runId,
  screenshot = true,
}: {
  runId: string;
  /** Scan runs have no screenshot. */
  screenshot?: boolean;
}) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [shotOk, setShotOk] = useState(screenshot);
  const q = useQuery({
    queryKey: ["run-findings", runId],
    queryFn: () => api<RunFindings>(`/v1/runs/${runId}/findings`),
  });

  if (q.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading findings…
      </p>
    );
  }
  if (q.isError) {
    return (
      <Notice tone="danger" title="Could not load findings">
        {problemMessage(q.error)}
      </Notice>
    );
  }
  const d = q.data;
  const byId = new Map(d.findings.map((f) => [f.id, f]));
  const info = d.findings.filter((f) => f.severity === "info");

  return (
    <>
      <Card>
        <CardTitle className="mb-4">
          Issues found <span className="text-muted-foreground">({d.issues.length})</span>
        </CardTitle>
        {d.issues.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-issues">
            No issues found by the checks that ran
            {d.outcome?.gaps.length ? " (see what was not checked above)" : ""}.
          </p>
        ) : (
          <ul className="flex flex-col gap-6" data-testid="run-issues">
            {d.issues.map((i) => (
              <li
                key={i.finding_ids[0] ?? i.title}
                className="flex flex-col gap-3 border-t border-border pt-4 first:border-0 first:pt-0"
                data-code={i.code}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={i.severity} />
                  {i.issue_id ? (
                    <Link href={`/issues/${i.issue_id}`} className="font-medium hover:underline">
                      {i.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{i.title}</span>
                  )}
                  <span className="font-mono text-xs text-muted-foreground">{i.code}</span>
                </div>
                <ul className="flex flex-col gap-1 text-sm">
                  {i.finding_ids.map((fid) => {
                    const f = byId.get(fid);
                    if (!f) return null;
                    return (
                      <li key={fid} className="flex flex-wrap items-baseline gap-2">
                        <span>{f.message}</span>
                        <EvidenceButton onClick={() => setEvidence(f.evidence)} />
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-muted-foreground">Re-check: {i.recheck.expectation}</p>
                <PromptCard prompt={i.prompt} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {info.length > 0 && (
        <Card>
          <CardTitle className="mb-3">Notes</CardTitle>
          <ul className="flex flex-col gap-1 text-sm">
            {info.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-2">
                <span>{f.message}</span>
                <EvidenceButton onClick={() => setEvidence(f.evidence)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {shotOk && (
        <Card>
          <CardTitle className="mb-3">Screenshot</CardTitle>
          {/* biome-ignore lint/performance/noImgElement: authenticated API image, not a static asset */}
          <img
            src={`/api/v1/runs/${runId}/screenshot`}
            alt="The page as the browser rendered it during this check"
            className="max-h-[36rem] w-full rounded-md border border-border object-contain object-top"
            onError={() => setShotOk(false)}
          />
        </Card>
      )}

      <EvidenceDrawer evidence={evidence} onClose={() => setEvidence(null)} />
    </>
  );
}
