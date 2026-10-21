"use client";

import { LogIn, Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, buttonVariants, Input, Label, Notice } from "@/components/ui/primitives";
import { api, problemMessage } from "@/lib/api";

export function SignInForm({
  providers,
  error,
  next,
}: {
  providers: { email: boolean; github: boolean };
  error?: string;
  next?: string;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState("sending");
    setFailure(null);
    try {
      await api("/v1/auth/email", { method: "POST", body: { email } });
      setState("sent");
    } catch (err) {
      setFailure(problemMessage(err));
      setState("idle");
    }
  };

  const githubHref = `/api/v1/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <div className="flex flex-col gap-5">
      {error && <Notice tone="danger">{error}</Notice>}
      {providers.github ? (
        <a href={githubHref} className={buttonVariants({ variant: "outline", size: "lg" })}>
          <LogIn aria-hidden className="size-4" />
          Continue with GitHub
        </a>
      ) : (
        <Notice tone="info">GitHub sign-in is not configured on this server.</Notice>
      )}
      {providers.email ? (
        state === "sent" ? (
          <Notice tone="success" title="Check your email">
            If <strong>{email}</strong> can sign in, a link is on its way. It works once and expires
            in 15 minutes.
          </Notice>
        ) : (
          <form
            onSubmit={submit}
            className="flex flex-col gap-3"
            aria-describedby={failure ? "signin-error" : undefined}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            {failure && (
              <p id="signin-error" role="alert" className="text-sm text-danger">
                {failure}
              </p>
            )}
            <Button type="submit" size="lg" disabled={state === "sending"}>
              <Mail aria-hidden className="size-4" />
              {state === "sending" ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </form>
        )
      ) : (
        <Notice tone="info">Email sign-in is not configured on this server.</Notice>
      )}
    </div>
  );
}
