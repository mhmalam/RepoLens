import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

let limiter: Ratelimit | null | undefined;

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    limiter = null; // no Redis configured (local dev) — no limiting
    return limiter;
  }
  limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(10, "1 h"),
    prefix: "repolens:ask",
  });
  return limiter;
}

export async function checkRateLimit(
  ip: string
): Promise<{ ok: boolean; remaining: number; resetAt: number }> {
  const l = getLimiter();
  if (!l) return { ok: true, remaining: 10, resetAt: 0 };
  const { success, remaining, reset } = await l.limit(ip);
  return { ok: success, remaining, resetAt: reset };
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "127.0.0.1";
}
