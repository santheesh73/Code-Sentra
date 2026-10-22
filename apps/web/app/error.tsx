"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-4">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">
        {error.digest ? `Reference ${error.digest}` : "Please try again."}
      </p>
      <button type="button" className="self-start underline" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
