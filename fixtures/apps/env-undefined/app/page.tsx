"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [status, setStatus] = useState("Checking the API…");

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/ping`)
      .then((res) => setStatus(res.ok ? "API is reachable." : `API returned ${res.status}.`))
      .catch(() => setStatus("API is unreachable."));
  }, []);

  return (
    <main>
      <h1>Status board</h1>
      <p>{status}</p>
    </main>
  );
}
