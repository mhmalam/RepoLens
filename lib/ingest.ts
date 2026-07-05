import { Redis } from "@upstash/redis";
import { chunkHeader, chunkRepo } from "./chunker";
import { db } from "./db";
import { embedBatch, EMBED_BATCH } from "./embeddings";
import { downloadRepoFiles, RepoMeta } from "./github";

const INSERT_BATCH = 200;

/**
 * Phase 1 of ingestion: download tarball → filter → chunk → insert all chunks
 * with NULL embeddings, then mark the repo 'indexing'. Fast (no LLM calls),
 * fits comfortably in one serverless invocation.
 */
export async function startIngest(repoId: string, meta: RepoMeta): Promise<void> {
  const supabase = db();
  try {
    const files = await downloadRepoFiles(meta.owner, meta.name, meta.commitSha);
    const chunks = chunkRepo(files);
    if (chunks.length === 0) throw new Error("No indexable content found");

    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const batch = chunks.slice(i, i + INSERT_BATCH).map((c) => ({
        repo_id: repoId,
        file_path: c.filePath,
        start_line: c.startLine,
        end_line: c.endLine,
        language: c.language,
        content: c.content,
        embedding: null,
      }));
      const { error } = await supabase.from("chunks").insert(batch);
      if (error) throw new Error(`chunk insert failed: ${error.message}`);
    }

    await supabase
      .from("repos")
      .update({
        status: "indexing",
        file_count: files.length,
        chunk_count: chunks.length,
        indexed_files: 0,
      })
      .eq("id", repoId);
  } catch (err) {
    await supabase
      .from("repos")
      .update({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .eq("id", repoId);
  }
}

/**
 * Phase 2, resumable: embed the next batch(es) of NULL-embedding chunks.
 * Called repeatedly — from the ingest route while its invocation lasts, then
 * from every status poll — so ingestion survives serverless timeouts and
 * free-tier embedding quotas (429 retryDelay is honored inside embedBatch).
 * Returns the number of chunks still waiting.
 */
export async function pumpEmbeddings(
  repoId: string,
  opts: { maxBatches?: number } = {}
): Promise<{ remaining: number }> {
  const { maxBatches = 1 } = opts;
  const supabase = db();

  for (let b = 0; b < maxBatches; b++) {
    const { data: rows, error } = await supabase
      .from("chunks")
      .select("id,file_path,start_line,end_line,content")
      .eq("repo_id", repoId)
      .is("embedding", null)
      .order("id", { ascending: true })
      .limit(EMBED_BATCH);
    if (error) throw new Error(error.message);

    if (!rows || rows.length === 0) {
      const { count } = await supabase
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .eq("repo_id", repoId);
      await supabase
        .from("repos")
        .update({ status: "ready", indexed_files: count ?? 0 })
        .eq("id", repoId);
      return { remaining: 0 };
    }

    try {
      const texts = rows.map(
        (r) =>
          `${chunkHeader({
            filePath: r.file_path,
            startLine: r.start_line,
            endLine: r.end_line,
            language: "",
            content: "",
          })}\n${r.content}`
      );
      const vectors = await embedBatch(texts, "RETRIEVAL_DOCUMENT");

      await Promise.all(
        rows.map((r, i) =>
          supabase.from("chunks").update({ embedding: vectors[i] }).eq("id", r.id)
        )
      );
    } catch (err) {
      // Quota exhausted for now (or transient failure): record progress and
      // let the next poll resume. Only hard-fail if nothing was embedded yet.
      const { count: done } = await supabase
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .eq("repo_id", repoId)
        .not("embedding", "is", null);
      if (!done) {
        await supabase
          .from("repos")
          .update({ status: "failed", error: err instanceof Error ? err.message : String(err) })
          .eq("id", repoId);
      }
      const { count: left } = await supabase
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .eq("repo_id", repoId)
        .is("embedding", null);
      return { remaining: left ?? 0 };
    }

    const { count: embedded } = await supabase
      .from("chunks")
      .select("id", { count: "exact", head: true })
      .eq("repo_id", repoId)
      .not("embedding", "is", null);
    await supabase.from("repos").update({ indexed_files: embedded ?? 0 }).eq("id", repoId);
  }

  const { count: remaining } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("repo_id", repoId)
    .is("embedding", null);
  if ((remaining ?? 0) === 0) {
    const { count } = await supabase
      .from("chunks")
      .select("id", { count: "exact", head: true })
      .eq("repo_id", repoId);
    await supabase
      .from("repos")
      .update({ status: "ready", indexed_files: count ?? 0 })
      .eq("id", repoId);
  }
  return { remaining: remaining ?? 0 };
}

// The lock must outlive a full pump INCLUDING its 429 retry waits — if it
// expires mid-retry, another poller starts a second batch into the same
// exhausted quota window and the retriers starve each other forever.
const PUMP_LOCK_TTL = 150; // seconds — covers one pump with retries
const PUMP_COOLDOWN = 30; // seconds between successful slices ≈ 100 embeds/min

function pumpRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return Redis.fromEnv();
}

async function lockedPump(repoId: string): Promise<{ remaining: number }> {
  const redis = pumpRedis();
  const key = `repolens:pump:${repoId}`;
  try {
    return await pumpEmbeddings(repoId, { maxBatches: 1 });
  } finally {
    // Downgrade the long safety TTL to a short cooldown so the next slice
    // (from any poller) starts on quota-friendly pacing.
    if (redis) await redis.set(key, "1", { ex: PUMP_COOLDOWN }).catch(() => {});
  }
}

/**
 * Pump one batch only if no other invocation is pumping or cooling down
 * (NX lock). Returns null when another worker holds the lock.
 */
export async function guardedPump(repoId: string): Promise<{ remaining: number } | null> {
  const redis = pumpRedis();
  if (redis) {
    const ok = await redis.set(`repolens:pump:${repoId}`, "1", { nx: true, ex: PUMP_LOCK_TTL });
    if (ok !== "OK") return null;
  }
  return lockedPump(repoId);
}

/** Pump unconditionally, taking the lock so pollers stand down. */
export async function claimAndPump(repoId: string): Promise<{ remaining: number }> {
  const redis = pumpRedis();
  if (redis) await redis.set(`repolens:pump:${repoId}`, "1", { ex: PUMP_LOCK_TTL });
  return lockedPump(repoId);
}

/** Run start + pump to completion in-process (used by the eval runner / scripts). */
export async function ingestRepo(repoId: string, meta: RepoMeta): Promise<void> {
  await startIngest(repoId, meta);
  const supabase = db();
  const { data: repo } = await supabase.from("repos").select("status").eq("id", repoId).single();
  if (repo?.status !== "indexing") return;
  // ~EMBED_BATCH chunks per 31s keeps us under the 100/min free-tier quota.
  let lastRemaining = Infinity;
  let stalled = 0;
  while (true) {
    const { remaining } = await pumpEmbeddings(repoId, { maxBatches: 1 });
    if (remaining === 0) break;
    const { data: row } = await supabase.from("repos").select("status").eq("id", repoId).single();
    if (row?.status === "failed") return;
    stalled = remaining >= lastRemaining ? stalled + 1 : 0;
    if (stalled >= 10) throw new Error(`embedding stalled with ${remaining} chunks left (quota?)`);
    lastRemaining = remaining;
    await new Promise((r) => setTimeout(r, 31_000));
  }
}
