import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { fetchRepoMeta, parseRepoUrl } from "@/lib/github";
import { claimAndPump, startIngest } from "@/lib/ingest";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: { repoUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.repoUrl) {
    return NextResponse.json({ error: "repoUrl is required" }, { status: 400 });
  }

  const rl = await checkRateLimit(`ingest:${clientIp(req)}`);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded — try again later." },
      { status: 429 }
    );
  }

  try {
    const { owner, name } = parseRepoUrl(body.repoUrl);
    const meta = await fetchRepoMeta(owner, name);

    const supabase = db();

    // Already indexed at this commit? Reuse it.
    const { data: existing } = await supabase
      .from("repos")
      .select("id,status")
      .eq("owner", owner)
      .eq("name", name)
      .eq("commit_sha", meta.commitSha)
      .maybeSingle();
    if (existing && existing.status !== "failed") {
      return NextResponse.json({ repoId: existing.id, status: existing.status });
    }
    if (existing?.status === "failed") {
      await supabase.from("repos").delete().eq("id", existing.id);
    }

    const { data: repo, error } = await supabase
      .from("repos")
      .insert({
        owner,
        name,
        default_branch: meta.defaultBranch,
        commit_sha: meta.commitSha,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // Continue after the response is sent: insert chunks fast, then embed in
    // quota-paced slices for as long as this invocation lives. If it dies
    // first, status polls (GET /api/repos/[id]) resume the pumping.
    after(async () => {
      await startIngest(repo.id, meta);
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const { remaining } = await claimAndPump(repo.id);
        if (remaining === 0) break;
        await new Promise((r) => setTimeout(r, 31_000));
      }
    });

    return NextResponse.json({ repoId: repo.id, status: "pending" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
