"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useOrg } from "@/components/app-shell";
import { Button, Card, CardTitle, Input, Label } from "@/components/ui/primitives";
import { api, problemMessage } from "@/lib/api";

/** Quick Pulse: check any public URL without creating a project. */
export default function QuickPulsePage() {
  const { org } = useOrg();
  const router = useRouter();
  const [url, setUrl] = useState("");
  const run = useMutation({
    mutationFn: () =>
      api<{ run_id: string }>("/v1/pulse", { method: "POST", body: { url, org_id: org.id } }),
    onSuccess: ({ run_id }) => router.push(`/runs/${run_id}`),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run.mutate();
  };

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Quick Pulse</h1>
        <p className="text-sm text-muted-foreground">
          Check whether a deployed site is up and working: reachability, TLS, the rendered page, its
          linked routes and response headers. Results are not tracked as issues; add a project for
          that.
        </p>
      </div>
      <Card>
        <CardTitle className="mb-3">URL to check</CardTitle>
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="pulse-url">Public URL</Label>
            <Input
              id="pulse-url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </div>
          <Button type="submit" disabled={run.isPending}>
            {run.isPending ? "Starting…" : "Check now"}
          </Button>
        </form>
        {run.isError && (
          <p className="mt-2 text-sm text-danger" role="alert">
            {problemMessage(run.error)}
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Private, loopback and internal addresses are refused. At most 10 quick checks a minute.
          The run belongs to {org.name}.
        </p>
      </Card>
    </div>
  );
}
