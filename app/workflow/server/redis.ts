import "server-only";

import { Redis } from "@upstash/redis";

let client: Redis | undefined;

export function getRedisConfigurationError(): string | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable sign-in and workflow runs.";
  }
  try {
    if (new URL(process.env.UPSTASH_REDIS_REST_URL).protocol !== "https:") {
      return "Redis must use HTTPS.";
    }
  } catch {
    return "UPSTASH_REDIS_REST_URL must be a valid HTTPS URL.";
  }
  return null;
}

export function getRedis(): Redis {
  const configurationError = getRedisConfigurationError();
  if (configurationError) throw new Error(configurationError);
  client ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    retry: false,
    enableTelemetry: false,
    enableAutoPipelining: false,
    // Keep checkpoint JSON as text until its byte limits have been checked.
    automaticDeserialization: false,
    signal: () => AbortSignal.timeout(5_000),
  });
  return client;
}
