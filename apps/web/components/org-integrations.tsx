"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, GitPullRequest } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Card, CardTitle, Input, Label, Notice, Spinner } from "@/components/ui/primitives";
import {
  type ApiToken,
  type AuditEntry,
  api,
  type GithubInstallations,
  type Org,
  problemMessage,
} from "@/lib/api";
import { formatTime } from "@/lib/utils";

/** GitHub App installations linked to the org (Section 16). */
export function GithubCard({ org }: { org: Org }) {
  const canManage = org.role === "owner" || org.role === "admin";
  const q = useQuery({
    queryKey: ["github", org.id],
    queryFn: () => api<GithubInstallations>(`/v1/orgs/${org.id}/github/installations`),
  });
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>GitHub App</CardTitle>
      <p className="text-sm text-muted-foreground">
        Pull requests get a <span className="font-medium">CodeSentra</span> check run with new
        issues and their prompts; preview deployments are checked by Pulse. Bind a repository in a
        project's settings.
      </p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Notice tone="danger">{problemMessage(q.error)}</Notice>
      ) : !q.data.configured ? (
        <Notice tone="warning" title="Not configured on this server">
          The GitHub App needs GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET and the
          App's client id and secret (see docs/runbook.md).
        </Notice>
      ) : (
        <>
          {q.data.installations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No installation is linked yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {q.data.installations.map((i) => (
                <li key={i.installation_id} className="py-2">
                  <span className="font-medium">
                    {i.account ?? `Installation ${i.installation_id}`}
                  </span>
                  {i.suspended && <span className="text-danger"> · suspended</span>}
                  <span className="block truncate text-xs text-muted-foreground">
                    {i.repositories.length
                      ? i.repositories.join(", ")
                      : "Repositories not reported yet"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <a
              href={`/api/v1/github/install?org_id=${org.id}`}
              className="inline-flex w-fit items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <GitPullRequest aria-hidden className="size-4" /> Install the GitHub App
            </a>
          )}
        </>
      )}
    </Card>
  );
}

/** API tokens for the CLI (`codesentra login`). The token is shown once. */
export function TokensCard({ org }: { org: Org }) {
  const qc = useQueryClient();
  const key = ["tokens", org.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<ApiToken[]>(`/v1/orgs/${org.id}/tokens`),
  });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api<ApiToken & { token: string }>(`/v1/orgs/${org.id}/tokens`, {
        method: "POST",
        body: { name },
      }),
    onSuccess: (t) => {
      setCreated(t.token);
      setCopied(false);
      setName("");
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/orgs/${org.id}/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>API tokens</CardTitle>
      <p className="text-sm text-muted-foreground">
        For the CLI: <code>codesentra login --api {"<url>"} --token -</code>. A token acts as you,
        in {org.name} only, and expires after 90 days.
      </p>
      {created && (
        <Notice tone="success" title="Copy this token now: it is not shown again">
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-muted px-2 py-1 text-xs">{created}</code>
            <Button
              variant="outline"
              size="sm"
              aria-live="polite"
              onClick={async () => {
                await navigator.clipboard.writeText(created);
                setCopied(true);
              }}
            >
              <Copy aria-hidden className="size-4" /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Notice>
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Notice tone="danger">{problemMessage(q.error)}</Notice>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tokens.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {q.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium">{t.name}</span>{" "}
                <code className="text-xs text-muted-foreground">{t.prefix}…</code>
                <span className="block text-xs text-muted-foreground">
                  Created {formatTime(t.created_at)} ·{" "}
                  {t.last_used_at ? `last used ${formatTime(t.last_used_at)}` : "never used"}
                  {t.expires_at && ` · expires ${formatTime(t.expires_at)}`}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => revoke.mutate(t.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="token-name">New token name</Label>
          <Input
            id="token-name"
            required
            maxLength={100}
            placeholder="laptop, CI…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={create.isPending}>
          Create token
        </Button>
      </form>
      {(create.isError || revoke.isError) && (
        <p role="alert" className="text-sm text-danger">
          {problemMessage(create.error ?? revoke.error)}
        </p>
      )}
    </Card>
  );
}

/** Section 17 audit log, for admins. */
export function AuditCard({ org }: { org: Org }) {
  const q = useQuery({
    queryKey: ["audit", org.id],
    queryFn: () => api<AuditEntry[]>(`/v1/orgs/${org.id}/audit?limit=50`),
    enabled: org.role === "owner" || org.role === "admin",
  });
  if (org.role === "member") return null;
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Audit log</CardTitle>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Notice tone="danger">{problemMessage(q.error)}</Notice>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {q.data.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5">
              <span>
                <code className="text-xs">{e.action}</code>{" "}
                <span className="text-muted-foreground">{e.target}</span>
              </span>
              <span className="text-xs text-muted-foreground">{formatTime(e.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
