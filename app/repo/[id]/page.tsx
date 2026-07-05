"use client";

import { use, useEffect, useRef, useState } from "react";

interface Repo {
  id: string;
  owner: string;
  name: string;
  commit_sha: string;
  chunk_count: number;
  status: string;
}

interface Citation {
  raw: string;
  filePath: string;
  startLine: number;
  endLine: number;
  url: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  meta?: { model: string; tier: string; latencyMs: number; citations: Citation[] };
  error?: boolean;
}

const SUGGESTIONS = [
  "Where does request routing happen?",
  "How does the middleware chain work end to end?",
  "What external dependencies does this project have?",
];

function AnswerText({ text, citations }: { text: string; citations: Citation[] }) {
  const byRaw = new Map(citations.map((c) => [c.raw, c]));
  const parts = text.split(/(\[[\w~$@][\w./~$@-]*:L\d+(?:-L?\d+)?\]|```[\s\S]*?```)/g);
  return (
    <div className="space-y-0 whitespace-pre-wrap text-[15px] leading-relaxed">
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const code = part.replace(/^```\w*\n?/, "").replace(/```$/, "");
          return (
            <pre
              key={i}
              className="my-2 overflow-x-auto rounded-md border border-border bg-bg p-3 text-[13px] leading-relaxed whitespace-pre"
            >
              {code}
            </pre>
          );
        }
        const cite = byRaw.get(part);
        if (cite) {
          return (
            <a
              key={i}
              href={cite.url}
              target="_blank"
              rel="noreferrer"
              className="mx-0.5 inline-block rounded border border-accent/30 bg-accent-dim px-1.5 py-px align-baseline font-mono text-[12px] text-accent no-underline transition-colors hover:border-accent/70"
              title={`${cite.filePath} L${cite.startLine}-${cite.endLine}`}
            >
              {cite.filePath.split("/").pop()}:{cite.startLine}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
  );
}

export default function RepoChat({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/repos/${id}`).then(async (r) => setRepo(await r.json()));
    setGeminiKey(localStorage.getItem("repolens:gemini-key") ?? "");
    setGroqKey(localStorage.getItem("repolens:groq-key") ?? "");
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function ask(question: string) {
    if (streaming || !question.trim()) return;
    setInput("");
    setStreaming(true);
    setMessages((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "" }]);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (geminiKey) headers["x-byo-gemini-key"] = geminiKey;
    if (groqKey) headers["x-byo-groq-key"] = groqKey;

    const update = (fn: (last: Message) => Message) =>
      setMessages((m) => [...m.slice(0, -1), fn(m[m.length - 1])]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers,
        body: JSON.stringify({ repoId: id, question }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message ?? json.error ?? "Request failed");
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "token") {
            update((last) => ({ ...last, content: last.content + event.text }));
          } else if (event.type === "done") {
            update((last) => ({
              ...last,
              meta: {
                model: event.model,
                tier: event.tier,
                latencyMs: event.latencyMs,
                citations: event.citations,
              },
            }));
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
    } catch (err) {
      update((last) => ({
        ...last,
        error: true,
        content: err instanceof Error ? err.message : "Something went wrong",
      }));
    } finally {
      setStreaming(false);
    }
  }

  function saveKeys() {
    localStorage.setItem("repolens:gemini-key", geminiKey);
    localStorage.setItem("repolens:groq-key", groqKey);
    setShowKeys(false);
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-61px)] max-w-3xl flex-col px-6">
      <div className="flex items-center justify-between border-b border-border py-4">
        <div>
          <h1 className="font-heading text-lg font-semibold">
            {repo ? `${repo.owner}/${repo.name}` : "…"}
          </h1>
          {repo && (
            <p className="text-xs text-muted">
              {repo.chunk_count.toLocaleString()} chunks · pinned at{" "}
              <span className="font-mono">{repo.commit_sha?.slice(0, 7)}</span>
            </p>
          )}
        </div>
        <button
          onClick={() => setShowKeys((s) => !s)}
          className="text-xs text-muted transition-colors hover:text-ink"
        >
          {geminiKey || groqKey ? "using your keys" : "bring your own keys"}
        </button>
      </div>

      {showKeys && (
        <div className="mt-4 space-y-2 rounded-md border border-border bg-surface p-4 text-sm">
          <p className="text-xs text-muted">
            Stored in localStorage only, sent per-request. Bypasses the shared 10/hour limit.
          </p>
          <input
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
            placeholder="Gemini API key (free at aistudio.google.com)"
            className="h-9 w-full rounded border border-border bg-bg px-3 text-xs outline-none focus:border-accent/50"
          />
          <input
            value={groqKey}
            onChange={(e) => setGroqKey(e.target.value)}
            placeholder="Groq API key (free at console.groq.com)"
            className="h-9 w-full rounded border border-border bg-bg px-3 text-xs outline-none focus:border-accent/50"
          />
          <button
            onClick={saveKeys}
            className="rounded bg-ink px-3 py-1.5 text-xs font-medium text-bg"
          >
            Save
          </button>
        </div>
      )}

      <div className="flex-1 space-y-6 py-8">
        {messages.length === 0 && (
          <div className="space-y-2 pt-8">
            <p className="text-xs uppercase tracking-widest text-muted/70">try asking</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                className="block w-full rounded-md border border-border bg-surface px-4 py-3 text-left text-sm text-muted transition-colors hover:border-accent/40 hover:text-ink"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg bg-surface px-4 py-2.5 text-[15px]">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {m.content === "" && !m.error ? (
                <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-accent" />
              ) : m.error ? (
                <p className="text-sm text-red-400">{m.content}</p>
              ) : (
                <AnswerText text={m.content} citations={m.meta?.citations ?? []} />
              )}
              {m.meta && (
                <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-muted">
                  <span className="rounded-full border border-border px-2 py-0.5 font-mono">
                    {m.meta.model}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5">
                    {m.meta.tier} tier
                  </span>
                  <span>{(m.meta.latencyMs / 1000).toFixed(1)}s</span>
                </div>
              )}
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="sticky bottom-0 flex gap-2 border-t border-border bg-bg py-4"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={repo ? `Ask about ${repo.owner}/${repo.name}…` : "Ask…"}
          className="h-11 flex-1 rounded-md border border-border bg-surface px-4 text-sm outline-none transition-colors placeholder:text-muted/60 focus:border-accent/50"
        />
        <button
          type="submit"
          disabled={streaming || !input.trim()}
          className="h-11 rounded-md bg-ink px-5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </main>
  );
}
