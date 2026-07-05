import { ChunkRow } from "../db";
import { Tier } from "./types";

export interface Route {
  tier: Tier;
  reason: string;
}

const SMART_SIGNALS =
  /\b(how|why|architecture|flow|design|end.to.end|lifecycle|interact|relationship|compare|trade.?offs?|walk\s*(me\s*)?through|explain|overview|refactor|implement)\b/i;
const FAST_SIGNALS =
  /\b(where|what is|which file|find|defined?|declaration|located?|list|name of|signature|type of|import(ed)?)\b/i;

/**
 * Cost-based heuristic router:
 * - lookup-style questions → fast tier (Groq llama-3.1-8b-instant)
 * - architectural / multi-file questions → smart tier (Gemini Flash)
 * Signals: question phrasing, question length, and retrieval spread
 * (how many distinct files the top chunks span).
 */
export function routeQuestion(question: string, topChunks: ChunkRow[]): Route {
  const words = question.trim().split(/\s+/).length;
  const distinctFiles = new Set(topChunks.slice(0, 8).map((c) => c.file_path)).size;

  if (FAST_SIGNALS.test(question) && !SMART_SIGNALS.test(question) && words <= 15) {
    return { tier: "fast", reason: `lookup-style question (${words} words)` };
  }
  if (SMART_SIGNALS.test(question)) {
    return { tier: "smart", reason: "architectural/explanatory phrasing" };
  }
  if (distinctFiles >= 5) {
    return {
      tier: "smart",
      reason: `retrieval spans ${distinctFiles} files — multi-file synthesis`,
    };
  }
  if (words > 25) {
    return { tier: "smart", reason: `long question (${words} words)` };
  }
  return { tier: "fast", reason: "short single-topic question — default to cheap tier" };
}
