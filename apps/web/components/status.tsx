import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Clock,
  LoaderCircle,
} from "lucide-react";
import type { RunStatus, StepStatus } from "@/lib/api";
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
 * Deployment status per environment. Pulse arrives in Phase 2; until an environment has
 * been checked it is shown as Not checked, never Live.
 */
export function EnvironmentStatusBadge() {
  return (
    <span
      className={cn(chip, "bg-muted text-muted-foreground")}
      title="Sentra Pulse is not available yet (Phase 2)"
    >
      <CircleDashed aria-hidden className="size-3.5" />
      Not checked
    </span>
  );
}
