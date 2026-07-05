import { chunkHeader, chunkRepo } from "./chunker";
import { db } from "./db";
import { embedDocuments } from "./embeddings";
import { downloadRepoFiles, RepoMeta } from "./github";

const INSERT_BATCH = 200;

/**
 * Full ingestion for one repo row: download tarball → filter → chunk → embed
 * (batches of 100) → insert. Updates repos.status/progress as it goes.
 */
export async function ingestRepo(repoId: string, meta: RepoMeta): Promise<void> {
  const supabase = db();
  const fail = async (message: string) => {
    await supabase.from("repos").update({ status: "failed", error: message }).eq("id", repoId);
  };

  try {
    await supabase.from("repos").update({ status: "indexing" }).eq("id", repoId);

    const files = await downloadRepoFiles(meta.owner, meta.name, meta.commitSha);
    await supabase.from("repos").update({ file_count: files.length }).eq("id", repoId);

    const chunks = chunkRepo(files);
    if (chunks.length === 0) throw new Error("No indexable content found");

    // Embed with the context header prepended, tracking file-level progress.
    const texts = chunks.map((c) => `${chunkHeader(c)}\n${c.content}`);
    const fileOfChunk = chunks.map((c) => c.filePath);
    const embeddings = await embedDocuments(texts, async (done) => {
      const filesDone = new Set(fileOfChunk.slice(0, done)).size;
      await supabase.from("repos").update({ indexed_files: filesDone }).eq("id", repoId);
    });

    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const batch = chunks.slice(i, i + INSERT_BATCH).map((c, j) => ({
        repo_id: repoId,
        file_path: c.filePath,
        start_line: c.startLine,
        end_line: c.endLine,
        language: c.language,
        content: c.content,
        embedding: embeddings[i + j],
      }));
      const { error } = await supabase.from("chunks").insert(batch);
      if (error) throw new Error(`chunk insert failed: ${error.message}`);
    }

    await supabase
      .from("repos")
      .update({
        status: "ready",
        chunk_count: chunks.length,
        indexed_files: files.length,
      })
      .eq("id", repoId);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}
