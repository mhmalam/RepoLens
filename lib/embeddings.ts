import pLimit from "p-limit";

const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const EMBED_DIM = 768;
const BATCH_SIZE = 100;

function apiKey(byoKey?: string): string {
  const key = byoKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  return key;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const retryable = msg.includes("429") || msg.includes("503") || msg.includes("500");
      if (!retryable || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i + Math.random() * 500));
    }
  }
  throw lastErr;
}

async function embedBatch(texts: string[], taskType: string, key: string): Promise<number[][]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: text.slice(0, 30000) }] },
          taskType,
          outputDimensionality: EMBED_DIM,
        })),
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini embeddings error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.embeddings.map((e: { values: number[] }) => e.values);
}

/** Embed document chunks in batches of 100, concurrency 2, retry on 429/5xx. */
export async function embedDocuments(
  texts: string[],
  onProgress?: (done: number) => void
): Promise<number[][]> {
  const key = apiKey();
  const limit = pLimit(2);
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }
  let done = 0;
  const results = await Promise.all(
    batches.map((batch, idx) =>
      limit(async () => {
        const vecs = await withRetry(() => embedBatch(batch, "RETRIEVAL_DOCUMENT", key));
        done += batch.length;
        onProgress?.(done);
        return { idx, vecs };
      })
    )
  );
  return results
    .sort((a, b) => a.idx - b.idx)
    .flatMap((r) => r.vecs);
}

export async function embedQuery(text: string, byoKey?: string): Promise<number[]> {
  const [vec] = await withRetry(() => embedBatch([text], "RETRIEVAL_QUERY", apiKey(byoKey)));
  return vec;
}
