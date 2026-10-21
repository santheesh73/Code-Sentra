"use client";

import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    // Thrown from a timer so it escapes React and reaches window.onerror as a real uncaught exception.
    const timer = setTimeout(() => {
      throw new Error("CS_FIXTURE_BOOM");
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main>
      <h1>Dashboard</h1>
      <p>Loading widgets…</p>
    </main>
  );
}
