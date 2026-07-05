import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = db();

  const [repos, queries, evalRuns] = await Promise.all([
    supabase.from("repos").select("id", { count: "exact", head: true }).eq("status", "ready"),
    supabase
      .from("queries")
      .select("latency_ms,model_used")
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase.from("eval_runs").select("*").order("created_at", { ascending: false }).limit(2),
  ]);

  const latencies = (queries.data ?? []).map((q) => q.latency_ms).sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : null;

  const byModel: Record<string, number> = {};
  for (const q of queries.data ?? []) {
    byModel[q.model_used] = (byModel[q.model_used] ?? 0) + 1;
  }

  const latest = evalRuns.data?.[0] ?? null;

  return NextResponse.json({
    reposIndexed: repos.count ?? 0,
    queriesServed: latencies.length,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    queriesByModel: byModel,
    latestEval: latest
      ? {
          gitSha: latest.git_sha,
          model: latest.model,
          passCount: latest.pass_count,
          failCount: latest.fail_count,
          avgScore: Number(latest.avg_score),
          retrievalHitRate: Number(latest.retrieval_hit_rate),
          at: latest.created_at,
        }
      : null,
  });
}
