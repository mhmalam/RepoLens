"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const SAMPLES = [
  { label: "honojs/hono", url: "https://github.com/honojs/hono", blurb: "web framework" },
  { label: "expressjs/express", url: "https://github.com/expressjs/express", blurb: "node classic" },
  { label: "sindresorhus/ky", url: "https://github.com/sindresorhus/ky", blurb: "http client" },
];

interface RepoStatus {
  id: string;
  status: "pending" | "indexing" | "ready" | "failed";
  file_count: number;
  chunk_count: number;
  indexed_files: number;
  error: string | null;
}

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RepoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const ingest = useCallback(
    async (repoUrl: string) => {
      setBusy(true);
      setError(null);
      setProgress(null);
      try {
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Ingestion failed");
        if (json.status === "ready") {
          router.push(`/repo/${json.repoId}`);
          return;
        }
        pollRef.current = setInterval(async () => {
          const r = await fetch(`/api/repos/${json.repoId}`);
          const status: RepoStatus = await r.json();
          setProgress(status);
          if (status.status === "ready") {
            if (pollRef.current) clearInterval(pollRef.current);
            router.push(`/repo/${json.repoId}`);
          } else if (status.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            setError(status.error ?? "Indexing failed");
            setBusy(false);
          }
        }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
        setBusy(false);
      }
    },
    [router]
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col items-center px-6 pt-28 pb-16">
      <h1 className="text-center text-4xl font-semibold tracking-tight sm:text-5xl">
        Ask questions about
        <br />
        <span className="text-accent">any GitHub repo</span>
      </h1>
      <p className="mt-5 max-w-xl text-center text-muted">
        Paste a public repo URL. RepoLens indexes the codebase and answers with
        citations that deep-link to the exact lines on GitHub.
      </p>

      <form
        className="mt-10 flex w-full max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && !busy) ingest(url.trim());
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          spellCheck={false}
          className="h-11 flex-1 rounded-md border border-border bg-surface px-4 text-sm outline-none transition-colors placeholder:text-muted/60 focus:border-accent/50"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="h-11 rounded-md bg-ink px-5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Indexing…" : "Index repo"}
        </button>
      </form>

      {busy && (
        <div className="mt-6 flex items-center gap-3 text-sm text-muted">
          <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-accent" />
          {progress?.status === "indexing" && progress.chunk_count > 0
            ? `Indexing… ${progress.indexed_files.toLocaleString()}/${progress.chunk_count.toLocaleString()} chunks embedded`
            : "Fetching repository…"}
        </div>
      )}
      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}

      <div className="mt-16 w-full max-w-xl">
        <p className="mb-3 text-xs uppercase tracking-widest text-muted/70">
          or try a sample — no signup
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {SAMPLES.map((s) => (
            <button
              key={s.label}
              disabled={busy}
              onClick={() => ingest(s.url)}
              className="group rounded-md border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-accent/40 disabled:opacity-40"
            >
              <span className="block text-sm font-medium group-hover:text-accent">
                {s.label}
              </span>
              <span className="block text-xs text-muted">{s.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
