"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardTitle,
  Input,
  Label,
  Notice,
  Select,
  Spinner,
} from "@/components/ui/primitives";
import {
  api,
  type NotificationChannel,
  type Project,
  problemMessage,
  type Schedule,
} from "@/lib/api";
import { formatTime } from "@/lib/utils";

export default function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<Project>(`/v1/projects/${id}`),
  });
  if (project.isPending) return <Spinner />;
  if (project.isError) return <Notice tone="danger">{problemMessage(project.error)}</Notice>;
  const p = project.data;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← {p.name}
        </Link>
        <h1 className="text-2xl font-semibold">Project settings</h1>
      </div>
      <GithubRepoCard project={p} />
      <BypassCard project={p} />
      <SchedulesCard project={p} />
      <NotificationsCard project={p} />
    </div>
  );
}

function GithubRepoCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [repo, setRepo] = useState(project.github_repo ?? "");
  const [onPush, setOnPush] = useState(project.check_on_push);
  const save = useMutation({
    mutationFn: () =>
      api<Project>(`/v1/projects/${project.id}`, {
        method: "PATCH",
        body: { github_repo: repo.trim() || null, check_on_push: onPush },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>GitHub repository</CardTitle>
      <p className="text-sm text-muted-foreground">
        With the GitHub App installed for this organization, pull requests on this repository get a
        CodeSentra check run, and successful preview deployments are checked by Pulse. A branch
        never changes this project's issues; the production deployment does.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gh-repo">Repository (owner/name)</Label>
          <Input
            id="gh-repo"
            placeholder="acme/web"
            pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onPush}
            onChange={(e) => setOnPush(e.target.checked)}
            className="size-4"
          />
          Run a full check on every push to the default branch
        </label>
        <Button type="submit" variant="outline" className="w-fit" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <p className="text-sm text-success">Saved.</p>}
        {save.isError && (
          <p role="alert" className="text-sm text-danger">
            {problemMessage(save.error)}
          </p>
        )}
      </form>
    </Card>
  );
}

const PRESETS = [
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 * * * *", label: "Hourly" },
  { cron: "0 */6 * * *", label: "Every 6 hours" },
  { cron: "0 6 * * *", label: "Daily at 06:00 UTC" },
];

function SchedulesCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const key = ["schedules", project.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Schedule[]>(`/v1/projects/${project.id}/schedules`),
  });
  const [env, setEnv] = useState(project.environments[0]?.id ?? "");
  const [cron, setCron] = useState(PRESETS[1]?.cron ?? "0 * * * *");
  const create = useMutation({
    mutationFn: () =>
      api<Schedule>(`/v1/projects/${project.id}/schedules`, {
        method: "POST",
        body: { environment_id: env, cron },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (sid: string) =>
      api(`/v1/projects/${project.id}/schedules?schedule_id=${sid}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const envName = (eid: string) => project.environments.find((e) => e.id === eid)?.name ?? eid;
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Schedules</CardTitle>
      <p className="text-sm text-muted-foreground">
        A recurring Pulse (then Link) of one environment. Times are UTC; the shortest interval is 5
        minutes.
      </p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Notice tone="danger">{problemMessage(q.error)}</Notice>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No schedules.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {q.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <code>{s.cron}</code> · {envName(s.environment_id)}
                <span className="block text-xs text-muted-foreground">
                  Next {formatTime(s.next_run_at)}
                  {s.last_run_id && (
                    <>
                      {" · "}
                      <Link href={`/runs/${s.last_run_id}`} className="hover:underline">
                        last run
                      </Link>
                    </>
                  )}
                </span>
                {s.last_error && <span className="block text-xs text-danger">{s.last_error}</span>}
              </span>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate(s.id)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {project.environments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a deploy URL to schedule a Pulse.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sched-env">Environment</Label>
            <Select id="sched-env" value={env} onChange={(e) => setEnv(e.target.value)}>
              {project.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sched-cron">Cron (minute hour day month weekday)</Label>
            <Input
              id="sched-cron"
              required
              list="cron-presets"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
            <datalist id="cron-presets">
              {PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
            </datalist>
          </div>
          <Button type="submit" variant="outline" disabled={create.isPending}>
            Add schedule
          </Button>
        </form>
      )}
      {(create.isError || remove.isError) && (
        <p role="alert" className="text-sm text-danger">
          {problemMessage(create.error ?? remove.error)}
        </p>
      )}
    </Card>
  );
}

function NotificationsCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const params = useSearchParams();
  const key = ["notifications", project.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<NotificationChannel[]>(`/v1/projects/${project.id}/notifications`),
  });
  const [email, setEmail] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api(`/v1/projects/${project.id}/notifications`, {
        method: "POST",
        body: { kind: "email", email },
      }),
    onSuccess: () => {
      setEmail("");
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({
    mutationFn: (cid: string) =>
      api(`/v1/projects/${project.id}/notifications?channel_id=${cid}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const slack = params.get("slack");
  useEffect(() => {
    if (slack === "connected")
      void qc.invalidateQueries({ queryKey: ["notifications", project.id] });
  }, [slack, qc, project.id]);
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Notifications</CardTitle>
      <p className="text-sm text-muted-foreground">
        When a check opens or regresses issues, each channel gets an alert with every issue's fix
        prompt.
      </p>
      {slack === "connected" && <Notice tone="success">Slack channel connected.</Notice>}
      {slack === "denied" && <Notice tone="warning">Slack was not connected.</Notice>}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Notice tone="danger">{problemMessage(q.error)}</Notice>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No channels.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {q.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="capitalize">{c.kind}</span> · {c.label}
                {c.last_error && (
                  <span className="block text-xs text-danger">
                    Last delivery failed: {c.last_error}
                  </span>
                )}
              </span>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate(c.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="notify-email">Email a member of the organization</Label>
          <Input
            id="notify-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={add.isPending}>
          Add email
        </Button>
      </form>
      <a
        href={`/api/v1/projects/${project.id}/notifications/slack/install`}
        className="inline-flex w-fit items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        Add to Slack
      </a>
      {(add.isError || remove.isError) && (
        <p role="alert" className="text-sm text-danger">
          {problemMessage(add.error ?? remove.error)}
        </p>
      )}
    </Card>
  );
}

function BypassCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [env, setEnv] = useState(project.environments[0]?.id ?? "");
  const [header, setHeader] = useState("x-vercel-protection-bypass");
  const [token, setToken] = useState("");
  const done = () => {
    setToken("");
    void qc.invalidateQueries({ queryKey: ["project", project.id] });
  };
  const save = useMutation({
    mutationFn: () =>
      api(`/v1/projects/${project.id}/environments/${env}/bypass-token`, {
        method: "PUT",
        body: { header, token },
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: (eid: string) =>
      api(`/v1/projects/${project.id}/environments/${eid}/bypass-token`, { method: "DELETE" }),
    onSuccess: done,
  });
  if (project.environments.length === 0) return null;
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Protected previews</CardTitle>
      <p className="text-sm text-muted-foreground">
        If an environment is behind access protection (e.g. Vercel Deployment Protection), give
        CodeSentra a bypass token. It is stored encrypted, never shown again, and sent only to that
        environment's own origin.
      </p>
      <ul className="divide-y divide-border text-sm">
        {project.environments.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {e.name} · {e.has_bypass_token ? "bypass token stored" : "no bypass token"}
            </span>
            {e.has_bypass_token && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate(e.id)}>
                Remove token
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-3 sm:grid-cols-[9rem_14rem_1fr_auto] sm:items-end"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bypass-env">Environment</Label>
          <Select id="bypass-env" value={env} onChange={(e) => setEnv(e.target.value)}>
            {project.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bypass-header">Header</Label>
          <Input
            id="bypass-header"
            required
            value={header}
            onChange={(e) => setHeader(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bypass-token">Bypass token</Label>
          <Input
            id="bypass-token"
            type="password"
            autoComplete="off"
            required
            minLength={8}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={save.isPending}>
          Save token
        </Button>
      </form>
      {(save.isError || remove.isError) && (
        <p role="alert" className="text-sm text-danger">
          {problemMessage(save.error ?? remove.error)}
        </p>
      )}
    </Card>
  );
}
