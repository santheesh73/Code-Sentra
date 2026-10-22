"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { Button, Select } from "@/components/ui/primitives";
import { api, type Me, type Org } from "@/lib/api";
import { cn } from "@/lib/utils";

interface OrgState {
  me: Me;
  org: Org;
  setOrgId(id: string): void;
}

const OrgContext = createContext<OrgState | null>(null);

export function useOrg(): OrgState {
  const v = useContext(OrgContext);
  if (!v) throw new Error("useOrg outside AppShell");
  return v;
}

const ORG_KEY = "codesentra.org";

function readStoredOrg(): string | null {
  try {
    return window.localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

export function AppShell({ me: initial, children }: { me: Me; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: me = initial } = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/v1/me"),
    initialData: initial,
  });
  const [orgId, setOrgIdState] = useState<string | null>(null);

  useEffect(() => {
    setOrgIdState(readStoredOrg());
  }, []);

  const org = useMemo(
    () => me.organizations.find((o) => o.id === orgId) ?? me.organizations[0],
    [me, orgId],
  );

  const setOrgId = (id: string) => {
    setOrgIdState(id);
    try {
      window.localStorage.setItem(ORG_KEY, id);
    } catch {
      /* storage unavailable: selection lasts for this page only */
    }
    if (pathname !== "/projects" && pathname !== "/settings") router.push("/projects");
  };

  const signOut = async () => {
    await api("/v1/auth/logout", { method: "POST" });
    router.replace("/signin");
    router.refresh();
  };

  const nav = [
    { href: "/projects", label: "Projects" },
    { href: "/pulse", label: "Quick Pulse" },
    { href: "/settings", label: "Settings" },
  ];

  if (!org) {
    return (
      <main className="mx-auto max-w-lg p-8">
        <p>You are not a member of any organization yet.</p>
      </main>
    );
  }

  return (
    <OrgContext.Provider value={{ me, org, setOrgId }}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-card focus:p-2"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link href="/projects" className="flex items-center gap-2 font-semibold">
            <ShieldCheck aria-hidden className="size-5 text-primary" />
            CodeSentra
          </Link>
          <nav aria-label="Main" className="flex gap-1">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={pathname.startsWith(n.href) ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm hover:bg-muted",
                  pathname.startsWith(n.href) && "bg-muted font-medium",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="org-switcher" className="sr-only">
              Organization
            </label>
            <Select
              id="org-switcher"
              value={org.id}
              onChange={(e) => setOrgId(e.target.value)}
              className="h-8 max-w-[11rem]"
            >
              {me.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
            <span className="hidden text-sm text-muted-foreground sm:inline" title={me.user.email}>
              {me.user.name ?? me.user.email}
            </span>
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        {children}
      </main>
    </OrgContext.Provider>
  );
}
