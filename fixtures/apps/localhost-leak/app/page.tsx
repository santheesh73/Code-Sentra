"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    fetch("http://localhost:4000/data")
      .then((res) => res.json() as Promise<string[]>)
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  return (
    <main>
      <h1>Inventory</h1>
      <p>{items.length === 0 ? "No items loaded yet." : `${items.length} items`}</p>
    </main>
  );
}
