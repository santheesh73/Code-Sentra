import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-4">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-muted-foreground">
        This page does not exist, or you do not have access to it.
      </p>
      <Link href="/projects" className="underline">
        Back to projects
      </Link>
    </main>
  );
}
