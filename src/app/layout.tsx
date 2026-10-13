import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kayla 💕 Private Chat",
  description: "Private chat for us two",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
