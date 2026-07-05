import { NextRequest, NextResponse } from "next/server";
import { extractCitations } from "@/lib/citations";
import { db, RepoRow } from "@/lib/db";
import { streamWithFallback } from "@/lib/llm/client";
import { routeQuestion } from "@/lib/llm/router";
import { buildMessages } from "@/lib/prompt";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";
import { retrieve } from "@/lib/retrieval";

export const maxDuration = 60;

const encoder = new TextEncoder();
const sse = (event: object) => encoder.encode(JSON.stringify(event) + "\n");

export async function POST(req: NextRequest) {
  let body: { repoId?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { repoId, question } = body;
  if (!repoId || !question?.trim()) {
    return NextResponse.json({ error: "repoId and question are required" }, { status: 400 });
  }

  // BYO keys (from localStorage, sent per-request) bypass the shared rate limit.
  const byoGemini = req.headers.get("x-byo-gemini-key") || undefined;
  const byoGroq = req.headers.get("x-byo-groq-key") || undefined;
  if (!byoGemini && !byoGroq) {
    const rl = await checkRateLimit(clientIp(req));
    if (!rl.ok) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message:
            "You've hit the free limit (10 questions/hour). Add your own free Gemini/Groq API keys to continue.",
          resetAt: rl.resetAt,
        },
        { status: 429 }
      );
    }
  }

  const { data: repo } = await db()
    .from("repos")
    .select("*")
    .eq("id", repoId)
    .maybeSingle<RepoRow>();
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (repo.status !== "ready") {
    return NextResponse.json({ error: `Repo is not ready (status: ${repo.status})` }, { status: 409 });
  }

  const started = Date.now();
  const chunks = await retrieve(repoId, question, byoGemini);
  const route = routeQuestion(question, chunks);
  const messages = buildMessages(question, chunks);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await streamWithFallback(route.tier, messages, {
          maxTokens: 1200,
          apiKeys: { gemini: byoGemini, groq: byoGroq },
        });
        controller.enqueue(
          sse({
            type: "start",
            tier: route.tier,
            model: `${result.provider.name}/${result.provider.model}`,
            routeReason: route.reason + (result.fellBack ? " (failover)" : ""),
          })
        );

        let answer = "";
        for await (const delta of result.stream) {
          answer += delta;
          controller.enqueue(sse({ type: "token", text: delta }));
        }

        const usage = await result.usage;
        const latencyMs = Date.now() - started;
        const citations = extractCitations(answer, repo);

        controller.enqueue(
          sse({
            type: "done",
            citations,
            latencyMs,
            model: `${result.provider.name}/${result.provider.model}`,
            tier: route.tier,
          })
        );

        await db().from("queries").insert({
          repo_id: repoId,
          question,
          model_used: `${result.provider.name}/${result.provider.model}`,
          route_reason: route.reason + (result.fellBack ? " (failover)" : ""),
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          latency_ms: latencyMs,
          retrieval_ids: chunks.map((c) => c.id),
        });
      } catch (err) {
        controller.enqueue(
          sse({ type: "error", message: err instanceof Error ? err.message : "LLM error" })
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
