"use client";

import { useEffect, useState } from "react";

interface Stats {
  reposIndexed: number;
  queriesServed: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  queriesByModel: Record<string, number>;
  latestEval: {
    gitSha: string;
    model: string;
    passCount: number;
    failCount: number;
    avgScore: number;
    retrievalHitRate: number;
    at: string;
  } | null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface p-5">
      <p className="text-xs uppercase tracking-widest text-muted/70">{label}</p>
      <p className="mt-2 font-heading text-3xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => setError(true));
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Live stats</h1>
      <p className="mt-2 text-sm text-muted">
        Real numbers, pulled from the database — nothing hand-typed.
      </p>

      {error && <p className="mt-8 text-sm text-red-400">Failed to load stats.</p>}
      {!stats && !error && <p className="mt-8 text-sm text-muted">Loading…</p>}

      {stats && (
        <>
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="repos indexed" value={stats.reposIndexed.toLocaleString()} />
            <Stat label="queries served" value={stats.queriesServed.toLocaleString()} />
            <Stat
              label="p50 latency"
              value={stats.p50LatencyMs != null ? `${(stats.p50LatencyMs / 1000).toFixed(1)}s` : "—"}
              hint={
                stats.p95LatencyMs != null
                  ? `p95 ${(stats.p95LatencyMs / 1000).toFixed(1)}s`
                  : undefined
              }
            />
            <Stat
              label="retrieval hit rate"
              value={
                stats.latestEval ? `${stats.latestEval.retrievalHitRate.toFixed(0)}%` : "—"
              }
              hint="from the eval suite"
            />
          </div>

          {stats.latestEval && (
            <section className="mt-12">
              <h2 className="text-xl font-semibold">Latest eval run</h2>
              <div className="mt-4 overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs uppercase tracking-wider text-muted/70">
                    <tr>
                      <th className="px-4 py-3">model</th>
                      <th className="px-4 py-3">pass</th>
                      <th className="px-4 py-3">fail</th>
                      <th className="px-4 py-3">avg score</th>
                      <th className="px-4 py-3">hit rate</th>
                      <th className="px-4 py-3">commit</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="px-4 py-3 font-mono text-xs">{stats.latestEval.model}</td>
                      <td className="px-4 py-3 text-accent">{stats.latestEval.passCount}</td>
                      <td className="px-4 py-3">{stats.latestEval.failCount}</td>
                      <td className="px-4 py-3">{stats.latestEval.avgScore.toFixed(2)} / 2</td>
                      <td className="px-4 py-3">{stats.latestEval.retrievalHitRate.toFixed(0)}%</td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {stats.latestEval.gitSha.slice(0, 7)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {Object.keys(stats.queriesByModel).length > 0 && (
            <section className="mt-12">
              <h2 className="text-xl font-semibold">Router distribution</h2>
              <div className="mt-4 space-y-2">
                {Object.entries(stats.queriesByModel).map(([model, count]) => {
                  const pct = (count / stats.queriesServed) * 100;
                  return (
                    <div key={model} className="flex items-center gap-3 text-sm">
                      <span className="w-64 shrink-0 font-mono text-xs text-muted">{model}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface">
                        <div
                          className="h-full rounded-full bg-accent/70"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-12 text-right text-xs text-muted">{count}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
