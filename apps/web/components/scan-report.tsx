"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EvidenceButton, EvidenceDrawer } from "@/components/evidence-drawer";
import { PulseFindings } from "@/components/pulse-findings";
import { FeatureStatusBadge } from "@/components/status";
import { Card, CardTitle, Notice, Spinner } from "@/components/ui/primitives";
import {
  ApiError,
  api,
  type Evidence,
  problemMessage,
  type ReportClaim,
  type ScanReport,
} from "@/lib/api";

const SECTION_TITLES: Record<keyof ScanReport["sections"], string> = {
  summary: "What it is",
  value: "Who it is for",
  features: "Features",
  issues: "Issues",
  remaining: "What remains",
};

const STAGE_LABELS: Record<string, string> = {
  ingest: "Ingest",
  map: "Map",
  history: "History",
  probe: "Probes",
  inventory: "Inventory",
  explain: "Report",
};

const DROP_REASONS: Record<string, string> = {
  no_evidence: "cited no evidence",
  unknown_evidence: "cited evidence that does not exist",
  foreign_evidence: "cited evidence from another run",
  unsupported_token: "named something its evidence does not contain",
  number_mismatch: "stated a number its evidence does not contain",
  status_contradiction: "contradicted the evidence-based feature status",
  skipped_check_asserted: "asserted the result of a check that did not run",
};

function Cites({ ids, onOpen }: { ids: string[]; onOpen: (id: string) => Promise<void> }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id, i) => (
        <EvidenceButton key={id} onClick={() => void onOpen(id)}>
          [{i + 1}]
        </EvidenceButton>
      ))}
    </span>
  );
}

function Claims({ list, onOpen }: { list: ReportClaim[]; onOpen: (id: string) => Promise<void> }) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {list.map((c) => (
        <li key={c.text}>
          {c.text} <Cites onOpen={onOpen} ids={c.evidence_ids} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A Scan report (Section 8): every sentence shown cites evidence and passed verification
 * (Rule 1); dropped claims are counted and listed; what was not checked is a gap (Rule 2).
 */
export function ScanReportView({ runId }: { runId: string }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const q = useQuery({
    queryKey: ["report", runId],
    queryFn: () => api<ScanReport>(`/v1/runs/${runId}/report`),
  });
  const open = async (id: string) => setEvidence(await api<Evidence>(`/v1/evidence/${id}`));

  if (q.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading report…
      </p>
    );
  }
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <p className="text-sm text-muted-foreground" data-testid="no-report">
          This scan wrote no report: it stopped before the report stage (see the steps above).
        </p>
      );
    return (
      <Notice tone="danger" title="Could not load the report">
        {problemMessage(q.error)}
      </Notice>
    );
  }
  const r = q.data;
  const summary = r.summary as {
    languages?: Record<string, number>;
    frameworks?: string[];
    package_manager?: string | null;
    routes?: number;
    env_vars?: number;
    probes?: { name: string; status: string; reason: string | null }[] | null;
    sandbox_runtime?: string | null;
  };

  return (
    // Report text carries paths and package coordinates, long unbroken tokens that must
    // wrap on a phone. `contents` keeps the parent's layout.
    <div className="contents [overflow-wrap:anywhere]">
      {r.cached && (
        <Notice tone="info" title="Reused report">
          This tree is identical to one already scanned, so that scan&apos;s report is shown.
        </Notice>
      )}
      {r.coverage.gaps.length > 0 && (
        <Notice tone="warning" title="Not everything was checked">
          <ul className="list-disc pl-5" data-testid="scan-gaps">
            {r.coverage.gaps.map((g) => (
              <li key={`${g.stage}:${g.reason}`}>
                <span className="font-medium">{STAGE_LABELS[g.stage] ?? g.stage}:</span> {g.reason}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card className="flex flex-col gap-3" data-testid="health">
          <CardTitle>Health score</CardTitle>
          <p className="text-4xl font-semibold" data-testid="health-score">
            {r.health.score ?? "—"}
            <span className="text-base font-normal text-muted-foreground"> / 100</span>
          </p>
          {r.health.score === null && (
            <p className="text-sm text-muted-foreground">Nothing could be measured.</p>
          )}
          <ul className="flex flex-col gap-3 text-sm">
            {r.health.components.map((c) => (
              <li key={c.component} className="flex flex-col gap-1">
                <span className="flex justify-between gap-2">
                  <span className="font-medium capitalize">{c.component.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">
                    {c.measured ? `${Math.round(c.ratio * 100)}%` : "not measured"} · weight{" "}
                    {c.weight}
                  </span>
                </span>
                {c.deductions
                  .filter((d) => d.points > 0)
                  .map((d) => (
                    <span key={d.reason} className="text-xs text-muted-foreground">
                      −{d.points} {d.reason} <Cites onOpen={open} ids={d.evidence_ids} />
                    </span>
                  ))}
                {c.not_measured.length > 0 && (
                  <span className="text-xs text-warning">
                    Not measured: {c.not_measured.join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex flex-col gap-5" data-testid="report-sections">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>Report</CardTitle>
            <span className="text-xs text-muted-foreground" data-testid="claims-count">
              {r.claims_total - r.claims_dropped} of {r.claims_total} claims verified against
              evidence
              {r.model ? ` · written by ${r.model}` : ""}
            </span>
          </div>
          {(Object.keys(SECTION_TITLES) as (keyof ScanReport["sections"])[])
            .filter((k) => r.sections[k].length > 0)
            .map((k) => (
              <section key={k} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{SECTION_TITLES[k]}</h3>
                <Claims onOpen={open} list={r.sections[k]} />
              </section>
            ))}
          {Object.values(r.sections).every((l) => l.length === 0) && (
            <p className="text-sm text-muted-foreground">
              No prose survived verification
              {r.model ? "" : " (no report model ran; see what was not checked above)"}.
            </p>
          )}
          {r.claims_dropped > 0 && (
            <div>
              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                aria-expanded={showDropped}
                onClick={() => setShowDropped(!showDropped)}
              >
                {showDropped ? "Hide" : "Show"} {r.claims_dropped} dropped claim
                {r.claims_dropped === 1 ? "" : "s"}
              </button>
              {showDropped && (
                <ul className="mt-2 flex flex-col gap-1.5 text-sm" data-testid="dropped-claims">
                  {r.dropped_claims.map((c) => (
                    <li key={`${c.section}:${c.text}`} className="text-muted-foreground">
                      <s>{c.text}</s> — {DROP_REASONS[c.reason] ?? c.reason}
                      {c.detail ? ` (${c.detail})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card className="flex flex-col gap-3">
        <CardTitle>Feature inventory</CardTitle>
        {r.features.length === 0 ? (
          <p className="text-sm text-muted-foreground">No features were identified.</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="features">
            {r.features.map((f) => (
              <li
                key={f.name}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                data-feature={f.name}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{f.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {f.reason} <Cites onOpen={open} ids={f.evidence_ids} />
                  </span>
                </span>
                <FeatureStatusBadge status={f.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Project facts</CardTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {summary.languages && (
            <>
              <dt className="text-muted-foreground">Languages</dt>
              <dd>
                {Object.entries(summary.languages)
                  .map(([l, n]) => `${l} (${n} files)`)
                  .join(", ")}
              </dd>
            </>
          )}
          {summary.frameworks && summary.frameworks.length > 0 && (
            <>
              <dt className="text-muted-foreground">Frameworks</dt>
              <dd>{summary.frameworks.join(", ")}</dd>
            </>
          )}
          {summary.package_manager && (
            <>
              <dt className="text-muted-foreground">Package manager</dt>
              <dd>{summary.package_manager}</dd>
            </>
          )}
          {summary.probes && (
            <>
              <dt className="text-muted-foreground">Probes</dt>
              <dd>
                {summary.probes
                  .map((p) => `${p.name}: ${p.status}${p.reason ? ` (${p.reason})` : ""}`)
                  .join("; ")}
                {summary.sandbox_runtime ? ` · sandbox ${summary.sandbox_runtime}` : ""}
              </dd>
            </>
          )}
          {Object.entries(r.coverage.checks).length > 0 && (
            <>
              <dt className="text-muted-foreground">Checks</dt>
              <dd>
                {Object.entries(r.coverage.checks)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("; ")}
              </dd>
            </>
          )}
        </dl>
      </Card>

      <PulseFindings runId={r.source_run_id} screenshot={false} />
      <EvidenceDrawer evidence={evidence} onClose={() => setEvidence(null)} />
    </div>
  );
}
