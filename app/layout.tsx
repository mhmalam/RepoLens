import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });

export const metadata: Metadata = {
  title: "RepoLens — ask questions about any GitHub repo",
  description:
    "Paste a public GitHub repo URL, ask questions, get streamed answers with line-level citations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/" className="font-heading text-lg font-semibold tracking-tight">
              repo<span className="text-accent">lens</span>
            </Link>
            <nav className="flex items-center gap-6 text-sm text-muted">
              <Link href="/stats" className="transition-colors hover:text-ink">
                stats
              </Link>
              <a
                href="https://github.com/mhmalam/repolens"
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-ink"
              >
                source
              </a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
