"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useOrg } from "@/components/app-shell";
import { Button, Card, CardTitle, Input, Label, NotYetAvailable } from "@/components/ui/primitives";
import { api, type Project, problemMessage } from "@/lib/api";

interface EnvRow {
  key: number;
  name: string;
  url: string;
}

export default function NewProjectPage() {
  const { org } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [envs, setEnvs] = useState<EnvRow[]>([{ key: 0, name: "production", url: "" }]);

  const create = useMutation({
    mutationFn: () =>
      api<Project>("/v1/projects", {
        method: "POST",
        body: {
          org_id: org.id,
          name,
          ...(repoUrl ? { repo_url: repoUrl } : {}),
          environments: envs
            .filter((e) => e.url.trim())
            .map((e) => ({ name: e.name.trim(), url: e.url.trim() })),
        },
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["projects", org.id] });
      router.push(`/projects/${p.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">New project</h1>
      <form onSubmit={submit} className="flex flex-col gap-6">
        <Card className="flex flex-col gap-4">
          <CardTitle>Project</CardTitle>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repo">Repository URL (optional)</Label>
            <Input
              id="repo"
              type="url"
              placeholder="https://github.com/acme/shop"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </div>
          <NotYetAvailable
            feature="Connecting a GitHub repository or uploading a zip for Sentra Scan"
            phase="Phase 3"
          />
        </Card>

        <Card className="flex flex-col gap-4">
          <CardTitle>Deploy URLs</CardTitle>
          <p className="text-sm text-muted-foreground">
            Sentra Pulse checks these once it is available (Phase 2). Leave a URL blank to skip it.
          </p>
          {envs.map((env, i) => (
            <fieldset
              key={env.key}
              className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
            >
              <legend className="sr-only">Environment {i + 1}</legend>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`env-name-${env.key}`}>Environment</Label>
                <Input
                  id={`env-name-${env.key}`}
                  required
                  pattern="[a-z0-9][a-z0-9-]*"
                  title="lowercase letters, digits and dashes"
                  value={env.name}
                  onChange={(e) =>
                    setEnvs(
                      envs.map((x) => (x.key === env.key ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`env-url-${env.key}`}>URL</Label>
                <Input
                  id={`env-url-${env.key}`}
                  type="url"
                  placeholder="https://shop.example.com"
                  value={env.url}
                  onChange={(e) =>
                    setEnvs(
                      envs.map((x) => (x.key === env.key ? { ...x, url: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove environment ${env.name || i + 1}`}
                onClick={() => setEnvs(envs.filter((x) => x.key !== env.key))}
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() =>
              setEnvs([
                ...envs,
                { key: Date.now(), name: envs.length === 0 ? "production" : "preview", url: "" },
              ])
            }
          >
            <Plus aria-hidden className="size-4" />
            Add environment
          </Button>
        </Card>

        {create.isError && (
          <p role="alert" className="text-sm text-danger">
            {problemMessage(create.error)}
          </p>
        )}
        <div className="flex gap-3">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
