const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const EMBED_DIM = 768;

/**
 * Gemini free tier counts every text in a batchEmbedContents call against the
 * ~100 embed-requests/minute quota, so batches are kept small and 429s are
 * retried after the retryDelay Google returns.
 */
export const EMBED_BATCH = 50;

function apiKey(byoKey?: string): string {
  const key = byoKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  return key;
}

function parseRetryDelayMs(errText: string): number | null {
  const m = errText.match(/retryDelay[^\d]*(\d+)/i) ?? errText.match(/retry in (\d+)/i);
  return m ? (parseInt(m[1], 10) + 2) * 1000 : null;
}

async function embedBatchRaw(texts: string[], taskType: string, key: string): Promise<number[][]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: text.slice(0, 8000) }] },
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

/**
 * Embed one batch, retrying on 429/5xx. On quota errors, honors the
 * retryDelay from the error payload (capped by maxWaitMs per attempt).
 */
export async function embedBatch(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  opts: { byoKey?: string; tries?: number; maxWaitMs?: number } = {}
): Promise<number[][]> {
  const { byoKey, tries = 4, maxWaitMs = 70_000 } = opts;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await embedBatchRaw(texts, taskType, apiKey(byoKey));
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (!/\b(429|500|502|503)\b/.test(msg) || i === tries - 1) throw err;
      const wait = Math.min(parseRetryDelayMs(msg) ?? 3000 * 2 ** i, maxWaitMs);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function embedQuery(text: string, byoKey?: string): Promise<number[]> {
  const [vec] = await embedBatch([text], "RETRIEVAL_QUERY", { byoKey });
  return vec;
}
