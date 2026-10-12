import "server-only";

import { getRedis, getRedisConfigurationError } from "./redis";

const CHECK_TIMEOUT_MS = 5_000;
// Health is read on page load and on a slow poll; never hammer the providers.
const CACHE_MS = 60_000;

export type ServiceStatus = "ok" | "mock" | "error";

export type HealthReport = {
  checkedAt: number;
  redis: { status: ServiceStatus; message?: string };
  openrouter: { status: ServiceStatus; message?: string; limitRemaining?: number | null };
};

let cached: { report: HealthReport; expiresAt: number } | undefined;

async function checkRedis(): Promise<HealthReport["redis"]> {
  const configurationError = getRedisConfigurationError();
  if (configurationError) return { status: "error", message: configurationError };
  try {
    const reply = await getRedis().ping();
    return reply === "PONG" ? { status: "ok" } : { status: "error", message: "Redis returned an unexpected reply." };
  } catch {
    return { status: "error", message: "Redis is unreachable. Check UPSTASH_REDIS_REST_URL and its token." };
  }
}

/** Reads the key's own metadata, which costs no credits. */
async function checkOpenRouter(): Promise<HealthReport["openrouter"]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { status: "mock", message: "OPENROUTER_API_KEY is not set. Jev and LLM nodes return labeled mock results." };
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { status: "error", message: "OpenRouter is unreachable." };
  }
  if (response.status === 401 || response.status === 403) {
    // Provider text such as "API key expired." is short and contains no secret.
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string") detail = ` ${body.error.message.slice(0, 120)}`;
    } catch { /* not JSON */ }
    return { status: "error", message: `OpenRouter rejected the API key.${detail} Replace OPENROUTER_API_KEY.` };
  }
  if (!response.ok) return { status: "error", message: `OpenRouter key check failed (${response.status}).` };
  try {
    const body = (await response.json()) as { data?: { limit_remaining?: unknown } };
    const remaining = body.data?.limit_remaining;
    return { status: "ok", limitRemaining: typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null };
  } catch {
    return { status: "ok", limitRemaining: null };
  }
}

export async function getHealthReport({ fresh = false } = {}): Promise<HealthReport> {
  const now = Date.now();
  if (!fresh && cached && cached.expiresAt > now) return cached.report;
  const [redis, openrouter] = await Promise.all([checkRedis(), checkOpenRouter()]);
  const report: HealthReport = { checkedAt: now, redis, openrouter };
  cached = { report, expiresAt: now + CACHE_MS };
  return report;
}
