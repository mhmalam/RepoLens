import { ChunkRow, db } from "./db";
import { embedQuery } from "./embeddings";

const VECTOR_TOP_K = 20;
export const CONTEXT_TOP_K = 8;

/** Terms worth boosting: identifiers, file names, camelCase / snake_case symbols. */
function extractTerms(question: string): string[] {
  const words = question.match(/[A-Za-z_][\w./-]{2,}/g) ?? [];
  const stop = new Set([
    "the", "and", "for", "how", "what", "where", "why", "which", "does", "this",
    "that", "with", "from", "are", "you", "can", "when", "into", "work", "works",
    "code", "file", "files", "repo", "repository", "function", "defined", "used",
  ]);
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => !stop.has(w)))];
}

/**
 * pgvector cosine top-20 → keyword-boost rerank (filename mention, symbol match)
 * → top-8 kept for the prompt.
 */
export async function retrieve(
  repoId: string,
  question: string,
  byoGeminiKey?: string
): Promise<ChunkRow[]> {
  const embedding = await embedQuery(question, byoGeminiKey);
  const { data, error } = await db().rpc("match_chunks", {
    p_repo_id: repoId,
    p_query_embedding: embedding,
    p_match_count: VECTOR_TOP_K,
  });
  if (error) throw new Error(`match_chunks failed: ${error.message}`);
  const candidates = (data ?? []) as ChunkRow[];

  const terms = extractTerms(question);
  const scored = candidates.map((c) => {
    let boost = 0;
    const pathLower = c.file_path.toLowerCase();
    const contentLower = c.content.toLowerCase();
    for (const t of terms) {
      if (pathLower.includes(t)) boost += 0.08; // filename mention
      else if (contentLower.includes(t)) boost += 0.03; // symbol/content match
    }
    return { chunk: c, score: c.similarity + Math.min(boost, 0.24) };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, CONTEXT_TOP_K)
    .map((s) => s.chunk);
}
