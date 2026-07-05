import { gemini } from "./gemini";
import { groq } from "./groq";
import { ChatMessage, Provider, StreamResult, Tier } from "./types";

const TIER_PROVIDER: Record<Tier, Provider> = {
  fast: groq,
  smart: gemini,
};

export function providerForTier(tier: Tier): Provider {
  return TIER_PROVIDER[tier];
}

function fallbackFor(p: Provider): Provider {
  return p.name === "groq" ? gemini : groq;
}

function isTransient(err: unknown): boolean {
  const msg = String(err);
  return /\b(429|500|502|503|504)\b/.test(msg);
}

export interface RoutedStream extends StreamResult {
  provider: Provider;
  fellBack: boolean;
}

/**
 * Stream from the tier's primary provider; on 429/5xx before the first token,
 * automatically fall back to the other provider.
 */
export async function streamWithFallback(
  tier: Tier,
  messages: ChatMessage[],
  opts: { maxTokens?: number; apiKeys?: { gemini?: string; groq?: string } } = {}
): Promise<RoutedStream> {
  const primary = providerForTier(tier);
  const keyFor = (p: Provider) =>
    p.name === "gemini" ? opts.apiKeys?.gemini : opts.apiKeys?.groq;
  try {
    const r = await primary.stream(messages, { maxTokens: opts.maxTokens, apiKey: keyFor(primary) });
    return { ...r, provider: primary, fellBack: false };
  } catch (err) {
    if (!isTransient(err)) throw err;
    const secondary = fallbackFor(primary);
    const r = await secondary.stream(messages, {
      maxTokens: opts.maxTokens,
      apiKey: keyFor(secondary),
    });
    return { ...r, provider: secondary, fellBack: true };
  }
}

export { gemini, groq };
