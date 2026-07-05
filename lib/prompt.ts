import { ChunkRow } from "./db";
import { ChatMessage } from "./llm/types";

export const SYSTEM_PROMPT = `You are RepoLens, a code assistant answering questions about ONE GitHub repository.

STRICT GROUNDING RULES:
- Answer ONLY from the provided code chunks. Do not use outside knowledge about this project.
- Cite every claim with the exact format [file_path:Lstart-Lend], e.g. [src/router.ts:L10-L42].
  Use the file paths and line numbers from the chunk headers. Cite as you go, inline.
- If the answer is not in the provided chunks, say "not found in the indexed code" and suggest
  what to search for instead. Never guess.
- Be concise and technical. Use short code excerpts when they clarify.`;

export function buildMessages(question: string, chunks: ChunkRow[]): ChatMessage[] {
  const context = chunks
    .map(
      (c) =>
        `// ${c.file_path} (lines ${c.start_line}-${c.end_line})\n${c.content}`
    )
    .join("\n\n---\n\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `CODE CHUNKS:\n\n${context}\n\nQUESTION: ${question}`,
    },
  ];
}
