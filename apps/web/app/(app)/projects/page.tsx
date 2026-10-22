"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useOrg } from "@/components/app-shell";
import { PulseStatusBadge } from "@/components/status";
import { buttonVariants, EmptyState, Notice, Spinner } from "@/components/ui/primitives";
import { api, type Project, problemMessage } from "@/lib/api";
import { formatTime } from "@/lib/utils";

export default function ProjectsPage() {
  const { org } = useOrg();
  const q = useQuery({
    queryKey: ["projects", org.id],
    queryFn: () => api<Project[]>(`/v1/projects?org_id=${org.id}`),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">{org.name}</p>
        </div>
        <Link href="/projects/new" className={buttonVariants()}>
          <Plus aria-hidden className="size-4" />
          New project
        </Link>
      </div>

      {q.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading projects…
        </div>
      ) : q.isError ? (
        <Notice tone="danger" title="Could not load projects">
          {problemMessage(q.error)}
        </Notice>
      ) : q.data.length === 0 ? (
        <EmptyState
          title="No projects yet"
          action={
            <Link href="/projects/new" className={buttonVariants()}>
              Create your first project
            </Link>
          }
        >
          A project is a repository, one or more deploy URLs, or both.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {q.data.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-5 hover:border-primary/60"
              >
                <h2 className="font-semibold">{p.name}</h2>
                {p.repo_url && (
                  <p className="truncate text-sm text-muted-foreground">{p.repo_url}</p>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Health score</dt>
                  <dd>Not scanned yet</dd>
                  <dt className="text-muted-foreground">Open issues</dt>
                  <dd data-testid="open-issues">{p.open_issues}</dd>
                </dl>
                {p.environments.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {p.environments.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">
                          <span className="font-medium">{e.name}</span>{" "}
                          <span className="text-muted-foreground">{new URL(e.url).host}</span>
                        </span>
                        <PulseStatusBadge
                          status={e.status?.pulse_status ?? null}
                          gaps={e.status?.gaps}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No deploy URLs</p>
                )}
                <p className="mt-auto text-xs text-muted-foreground">
                  Created {formatTime(p.created_at)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
