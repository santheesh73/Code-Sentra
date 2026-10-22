"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import type { Prompt } from "@/lib/api";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<Prompt["type"], { label: string; cls: string; help: string }> = {
  code_fix: {
    label: "Code fix",
    cls: "bg-info-soft text-info",
    help: "Traced to a file and line.",
  },
  config_fix: {
    label: "Config fix",
    cls: "bg-info-soft text-info",
    help: "A setting on your hosting platform.",
  },
  outage_triage: {
    label: "Outage triage",
    cls: "bg-danger-soft text-danger",
    help: "The site is unreachable; work through the checklist.",
  },
  investigate: {
    label: "Unconfirmed lead",
    cls: "bg-warning-soft text-warning",
    help: "Not traced to code yet; confirm the cause before editing.",
  },
};

/** The fix prompt, ready to hand to a coding agent or follow yourself. */
export function PromptCard({ prompt }: { prompt: Prompt }) {
  const [copied, setCopied] = useState(false);
  const t = TYPE_LABEL[prompt.type];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="prompt">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", t.cls)}
            data-prompt-type={prompt.type}
          >
            {t.label}
          </span>
          <span className="text-xs text-muted-foreground">
            {t.help}
            {prompt.version !== null && ` · version ${prompt.version}`} · {prompt.template_version}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={copy} aria-live="polite">
          {copied ? (
            <Check aria-hidden className="size-4" />
          ) : (
            <Copy aria-hidden className="size-4" />
          )}
          {copied ? "Copied" : "Copy prompt"}
        </Button>
      </div>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed">
        {prompt.body}
      </pre>
    </div>
  );
}
