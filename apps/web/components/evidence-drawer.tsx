"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/primitives";
import type { Evidence } from "@/lib/api";
import { formatTime } from "@/lib/utils";

/** Shows one evidence record: what a claim or finding is based on. Native <dialog>. */
export function EvidenceDrawer({
  evidence,
  onClose,
}: {
  evidence: Evidence | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (evidence && !d.open) d.showModal();
    if (!evidence && d.open) d.close();
  }, [evidence]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="evidence-title"
      className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-xl bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
    >
      {evidence && (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-border p-4">
            <div className="min-w-0">
              <h2 id="evidence-title" className="font-semibold">
                Evidence · {evidence.kind.replace(/_/g, " ")}
              </h2>
              <p className="break-all text-sm text-muted-foreground">{evidence.locator}</p>
            </div>
            <Button variant="ghost" size="sm" aria-label="Close evidence" onClick={onClose}>
              <X aria-hidden className="size-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Recorded</dt>
              <dd>{formatTime(evidence.created_at)}</dd>
              <dt className="text-muted-foreground">Evidence id</dt>
              <dd className="break-all font-mono text-xs">{evidence.id}</dd>
              <dt className="text-muted-foreground">SHA-256</dt>
              <dd className="break-all font-mono text-xs">{evidence.hash}</dd>
            </dl>
            <pre className="overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(evidence.payload, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </dialog>
  );
}

export function EvidenceButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-muted-foreground underline hover:text-foreground"
    >
      {children ?? "View evidence"}
    </button>
  );
}
