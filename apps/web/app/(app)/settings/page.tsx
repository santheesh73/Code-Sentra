"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useOrg } from "@/components/app-shell";
import { AuditCard, GithubCard, TokensCard } from "@/components/org-integrations";
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
import { api, type Member, type Org, problemMessage, type Role } from "@/lib/api";
import { formatTime } from "@/lib/utils";

export default function SettingsPage() {
  const { org, me } = useOrg();
  const qc = useQueryClient();
  const canManage = org.role === "owner" || org.role === "admin";
  const members = useQuery({
    queryKey: ["members", org.id],
    queryFn: () => api<Member[]>(`/v1/orgs/${org.id}/members`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["members", org.id] });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api(`/v1/orgs/${org.id}/members/${userId}`, { method: "PATCH", body: { role } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/v1/orgs/${org.id}/members/${userId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Settings · {org.name}</h1>

      <Card className="flex flex-col gap-4">
        <CardTitle>Members</CardTitle>
        {members.isPending ? (
          <Spinner />
        ) : members.isError ? (
          <Notice tone="danger">{problemMessage(members.error)}</Notice>
        ) : (
          <ul className="divide-y divide-border">
            {members.data.map((m) => (
              <li
                key={m.user.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">{m.user.name ?? m.user.email}</span>
                  {m.user.name && <span className="text-muted-foreground"> · {m.user.email}</span>}
                  <span className="block text-xs text-muted-foreground">
                    Joined {formatTime(m.joined_at)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {org.role === "owner" ? (
                    <Select
                      aria-label={`Role for ${m.user.email}`}
                      value={m.role}
                      onChange={(e) =>
                        changeRole.mutate({ userId: m.user.id, role: e.target.value as Role })
                      }
                      className="h-8"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </Select>
                  ) : (
                    <span className="capitalize text-muted-foreground">{m.role}</span>
                  )}
                  {(canManage || m.user.id === me.user.id) && (
                    <Button variant="ghost" size="sm" onClick={() => remove.mutate(m.user.id)}>
                      {m.user.id === me.user.id ? "Leave" : "Remove"}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {(changeRole.isError || remove.isError) && (
          <p role="alert" className="text-sm text-danger">
            {problemMessage(changeRole.error ?? remove.error)}
          </p>
        )}
        {canManage && <AddMember orgId={org.id} isOwner={org.role === "owner"} onAdded={refresh} />}
      </Card>

      <CreateOrg />

      <GithubCard org={org} />
      <TokensCard org={org} />
      <p className="text-sm text-muted-foreground">
        Schedules, notifications and the GitHub repository are set per project, under the project's
        Settings.
      </p>
      <AuditCard org={org} />
    </div>
  );
}

function AddMember({
  orgId,
  isOwner,
  onAdded,
}: {
  orgId: string;
  isOwner: boolean;
  onAdded: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const add = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/members`, { method: "POST", body: { email, role } }),
    onSuccess: () => {
      setEmail("");
      onAdded();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="member-email">Add a member by email</Label>
        <Input
          id="member-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="member-role">Role</Label>
        <Select id="member-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          {isOwner && <option value="owner">Owner</option>}
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={add.isPending}>
        Add
      </Button>
      {add.isError && (
        <p role="alert" className="text-sm text-danger sm:col-span-3">
          {problemMessage(add.error)}
        </p>
      )}
    </form>
  );
}

function CreateOrg() {
  const router = useRouter();
  const qc = useQueryClient();
  const { setOrgId } = useOrg();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api<Org>("/v1/orgs", { method: "POST", body: { name } }),
    onSuccess: async (org) => {
      setName("");
      await qc.invalidateQueries({ queryKey: ["me"] });
      setOrgId(org.id);
      router.push("/projects");
    },
  });
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>New organization</CardTitle>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="org-name">Name</Label>
          <Input
            id="org-name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={create.isPending}>
          Create
        </Button>
      </form>
      {create.isError && (
        <p role="alert" className="text-sm text-danger">
          {problemMessage(create.error)}
        </p>
      )}
    </Card>
  );
}
