import { ChatMessage, Provider, StreamResult, Usage } from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function key(byo?: string): string {
  const k = byo || process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY not set");
  return k;
}

function toGeminiBody(messages: ChatMessage[], maxTokens: number) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 },
  };
}

export const gemini: Provider = {
  name: "gemini",
  model: MODEL,

  async stream(messages, opts = {}): Promise<StreamResult> {
    const res = await fetch(
      `${BASE}/${MODEL}:streamGenerateContent?alt=sse&key=${key(opts.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toGeminiBody(messages, opts.maxTokens ?? 1024)),
      }
    );
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);

    let resolveUsage!: (u: Usage) => void;
    const usage = new Promise<Usage>((r) => (resolveUsage = r));

    async function* iterate() {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalUsage: Usage = { promptTokens: 0, completionTokens: 0 };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const json = JSON.parse(line.slice(6));
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) yield text as string;
            if (json.usageMetadata) {
              finalUsage = {
                promptTokens: json.usageMetadata.promptTokenCount ?? 0,
                completionTokens: json.usageMetadata.candidatesTokenCount ?? 0,
              };
            }
          }
        }
      } finally {
        resolveUsage(finalUsage);
      }
    }
    return { stream: iterate(), usage };
  },

  async complete(messages, opts = {}) {
    const res = await fetch(`${BASE}/${MODEL}:generateContent?key=${key(opts.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toGeminiBody(messages, opts.maxTokens ?? 1024)),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text =
      json.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    return {
      text,
      usage: {
        promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
};
