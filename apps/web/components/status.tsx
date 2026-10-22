import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  Clock,
  LoaderCircle,
} from "lucide-react";
import type { IssueStatus, PulseStatus, RunStatus, Severity, StepStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const chip =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium";

/**
 * Run status. `partial` is never green: some step did not run, and a skipped check is
 * never shown as a pass (Rule 2).
 */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { label: string; cls: string; Icon: typeof CircleCheck }> = {
    queued: { label: "Queued", cls: "bg-muted text-muted-foreground", Icon: Clock },
    running: { label: "Running", cls: "bg-info-soft text-info", Icon: LoaderCircle },
    succeeded: { label: "Succeeded", cls: "bg-success-soft text-success", Icon: CircleCheck },
    partial: { label: "Partial", cls: "bg-warning-soft text-warning", Icon: CircleAlert },
    failed: { label: "Failed", cls: "bg-danger-soft text-danger", Icon: CircleX },
  };
  const { label, cls, Icon } = map[status];
  return (
    <span
      className={cn(chip, cls)}
      title={status === "partial" ? "Finished, but some checks did not run" : undefined}
    >
      <Icon aria-hidden className={cn("size-3.5", status === "running" && "animate-spin")} />
      {label}
    </span>
  );
}

export function StepStatusIcon({ status }: { status: StepStatus }) {
  const map: Record<StepStatus, { label: string; cls: string; Icon: typeof CircleCheck }> = {
    pending: { label: "Pending", cls: "text-muted-foreground", Icon: CircleDashed },
    running: { label: "Running", cls: "text-info animate-spin", Icon: LoaderCircle },
    done: { label: "Done", cls: "text-success", Icon: CircleCheck },
    skipped: { label: "Skipped (not checked)", cls: "text-warning", Icon: CircleMinus },
    failed: { label: "Failed", cls: "text-danger", Icon: CircleX },
  };
  const { label, cls, Icon } = map[status];
  return <Icon role="img" aria-label={label} className={cn("size-5 shrink-0", cls)} />;
}

/**
 * Deployment status (Section 9). Only `live` is green. `unverified` means some check did
 * not run, so it is never shown as healthy (Rule 2); `null` means never checked.
 */
export function PulseStatusBadge({
  status,
  gaps = [],
}: {
  status: PulseStatus | null;
  gaps?: { group: string; reason: string }[];
}) {
  const map: Record<
    PulseStatus | "none",
    { label: string; cls: string; Icon: typeof CircleCheck }
  > = {
    live: { label: "Live", cls: "bg-success-soft text-success", Icon: CircleCheck },
    degraded: { label: "Degraded", cls: "bg-warning-soft text-warning", Icon: CircleAlert },
    down: { label: "Down", cls: "bg-danger-soft text-danger", Icon: CircleX },
    unverified: { label: "Unverified", cls: "bg-muted text-muted-foreground", Icon: CircleHelp },
    none: { label: "Not checked", cls: "bg-muted text-muted-foreground", Icon: CircleDashed },
  };
  const { label, cls, Icon } = map[status ?? "none"];
  const title =
    status === "unverified" && gaps.length
      ? `Not everything was checked: ${gaps.map((g) => `${g.group}: ${g.reason}`).join("; ")}`
      : status === null
        ? "No Pulse check has finished for this URL yet"
        : undefined;
  return (
    <span className={cn(chip, cls)} title={title} data-pulse-status={status ?? "none"}>
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const cls = {
    error: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-warning",
    info: "bg-info-soft text-info",
  }[severity];
  return <span className={cn(chip, cls, "capitalize")}>{severity}</span>;
}

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const map: Record<IssueStatus, { label: string; cls: string }> = {
    open: { label: "Open", cls: "bg-danger-soft text-danger" },
    regressed: { label: "Regressed", cls: "bg-danger-soft text-danger" },
    resolved: { label: "Resolved", cls: "bg-success-soft text-success" },
    dismissed: { label: "Dismissed", cls: "bg-muted text-muted-foreground" },
  };
  const { label, cls } = map[status];
  return (
    <span className={cn(chip, cls)} data-issue-status={status}>
      {label}
    </span>
  );
}
