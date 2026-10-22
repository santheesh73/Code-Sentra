import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMe, webConfig } from "@/lib/server-api";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  github_denied: "GitHub sign-in was cancelled.",
  github_state: "That GitHub sign-in expired or was not started here. Please try again.",
  github_no_verified_email:
    "Your GitHub account has no verified primary email. Verify one on GitHub, or use an email link.",
  github_failed: "GitHub sign-in failed. Please try again.",
};

async function providers(): Promise<{ email: boolean; github: boolean }> {
  const res = await fetch(new URL("/v1/auth/providers", webConfig().API_INTERNAL_URL), {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`API /v1/auth/providers returned ${res.status}`);
  return (await res.json()) as { email: boolean; github: boolean };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await getMe()) redirect("/projects");
  const { error, next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <div>
        <h1 className="text-2xl font-semibold">Sign in to CodeSentra</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Evidence-linked reports, live deployment status and verified fixes.
        </p>
      </div>
      <SignInForm
        providers={await providers()}
        error={error ? (ERRORS[error] ?? "Sign-in failed. Please try again.") : undefined}
        next={next}
      />
    </main>
  );
}
