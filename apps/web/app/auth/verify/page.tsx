"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Notice } from "@/components/ui/primitives";
import { api, problemMessage } from "@/lib/api";

/**
 * The token arrives in the URL fragment, which browsers never send to a server. An
 * explicit click exchanges it, so link-preview bots that fetch the URL cannot burn it.
 */
export default function VerifyPage() {
  const router = useRouter();
  // undefined until the fragment has been read on the client.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<"ready" | "working" | "error">("ready");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(t);
    // Drop the token from the address bar and history.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const confirm = async () => {
    if (!token) return;
    setState("working");
    try {
      await api("/v1/auth/email/verify", { method: "POST", body: { token } });
      router.replace("/projects");
      router.refresh();
    } catch (e) {
      setError(problemMessage(e));
      setState("error");
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-4 py-12">
      <h1 className="text-2xl font-semibold">Finish signing in</h1>
      {token === undefined ? null : token === null ? (
        <Notice tone="warning">
          This page needs the link from your sign-in email.{" "}
          <a className="underline" href="/signin">
            Request a new link
          </a>
          .
        </Notice>
      ) : state === "error" ? (
        <Notice tone="danger" title="Could not sign you in">
          {error}{" "}
          <a className="underline" href="/signin">
            Request a new link
          </a>
          .
        </Notice>
      ) : (
        <Button size="lg" onClick={confirm} disabled={state === "working"}>
          {state === "working" ? "Signing in…" : "Sign in to CodeSentra"}
        </Button>
      )}
    </main>
  );
}
