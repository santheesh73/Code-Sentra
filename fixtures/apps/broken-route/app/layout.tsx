import type { ReactNode } from "react";

export const metadata = { title: "CodeSentra fixture: broken-route" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
