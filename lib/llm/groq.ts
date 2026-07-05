import { ChatMessage, Provider, StreamResult, Usage } from "./types";

const MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const URL = "https://api.groq.com/openai/v1/chat/completions";

function key(byo?: string): string {
  const k = byo || process.env.GROQ_API_KEY;
  if (!k) throw new Error("GROQ_API_KEY not set");
  return k;
}

async function request(messages: ChatMessage[], stream: boolean, maxTokens: number, apiKey?: string) {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key(apiKey)}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
  return res;
}

export const groq: Provider = {
  name: "groq",
  model: MODEL,

  async stream(messages, opts = {}): Promise<StreamResult> {
    const res = await request(messages, true, opts.maxTokens ?? 1024, opts.apiKey);
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
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) yield delta as string;
            if (json.usage) {
              finalUsage = {
                promptTokens: json.usage.prompt_tokens ?? 0,
                completionTokens: json.usage.completion_tokens ?? 0,
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
    const res = await request(messages, false, opts.maxTokens ?? 1024, opts.apiKey);
    const json = await res.json();
    return {
      text: json.choices[0].message.content as string,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  },
};
