import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { getRedis, getRedisConfigurationError } from "./redis";
import { getWorkspaceId } from "./liveblocks";
import { MAX_RUN_LLM_OUTPUT_TOKENS } from "./execution-policy";
import { ApiError } from "./request-security";

export const ADMISSION_LIMITS = {
  workspaceConcurrent: 4,
  userConcurrent: 2,
  roomConcurrent: 1,
  workspacePerMinute: 30,
  userPerMinute: 6,
  workspacePerDay: 200,
  userPerDay: 50,
  workspaceOutputTokensPerDay: 5_120_000,
  userOutputTokensPerDay: 1_024_000,
  // Longer than the route's hosting cap (120s) and executor deadline (60s).
  leaseMs: 150_000,
} as const;

/** All checks and reservations are one transaction across every app instance. */
export const ADMIT_RUN_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local lease = tonumber(ARGV[2])
for i = 1, 3 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 2]) then
    local first = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    return {0, math.max(1, math.ceil((tonumber(first[2]) - now) / 1000)), 1}
  end
end
for i = 4, 9 do
  local amount = i >= 8 and tonumber(ARGV[12]) or 1
  if tonumber(redis.call('GET', KEYS[i]) or '0') + amount > tonumber(ARGV[i + 2]) then
    return {0, math.max(1, math.ceil(redis.call('PTTL', KEYS[i]) / 1000)), i < 6 and 2 or 3}
  end
end
for i = 1, 3 do
  redis.call('ZADD', KEYS[i], now + lease, ARGV[1])
  redis.call('PEXPIRE', KEYS[i], lease)
end
for i = 4, 9 do
  local amount = i >= 8 and tonumber(ARGV[12]) or 1
  redis.call('INCRBY', KEYS[i], amount)
  local window = i < 6 and 60000 or 86400000
  redis.call('PEXPIRE', KEYS[i], window - (now % window))
end
return {1, 0, 0}
`;

export const RELEASE_RUN_SCRIPT = `
for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1
`;

export type RunLease = { release: () => Promise<void> };

export async function acquireRunLease(userId: string, roomId: string): Promise<RunLease> {
  const configurationError = getRedisConfigurationError();
  if (configurationError) throw new ApiError(503, configurationError);
  const redis = getRedis();

  const workspace = createHash("sha256").update(getWorkspaceId()).digest("hex").slice(0, 24);
  const user = createHash("sha256").update(userId).digest("hex");
  const room = createHash("sha256").update(roomId).digest("hex");
  // The hash tag keeps all keys in the same slot on Redis Cluster.
  const prefix = `jev:admission:{${workspace}}`;
  const keys = [
    `${prefix}:active`, `${prefix}:user:${user}:active`, `${prefix}:room:${room}:active`,
    `${prefix}:minute`, `${prefix}:user:${user}:minute`,
    `${prefix}:day`, `${prefix}:user:${user}:day`,
    `${prefix}:output-tokens`, `${prefix}:user:${user}:output-tokens`,
  ];
  const leaseId = randomUUID();
  let result: number[];
  try {
    result = await redis.eval<(string | number)[], number[]>(ADMIT_RUN_SCRIPT, keys, [
      leaseId, ADMISSION_LIMITS.leaseMs,
      ADMISSION_LIMITS.workspaceConcurrent, ADMISSION_LIMITS.userConcurrent, ADMISSION_LIMITS.roomConcurrent,
      ADMISSION_LIMITS.workspacePerMinute, ADMISSION_LIMITS.userPerMinute,
      ADMISSION_LIMITS.workspacePerDay, ADMISSION_LIMITS.userPerDay,
      ADMISSION_LIMITS.workspaceOutputTokensPerDay, ADMISSION_LIMITS.userOutputTokensPerDay,
      MAX_RUN_LLM_OUTPUT_TOKENS,
    ]);
  } catch {
    // No memory fallback: an unavailable shared limiter must not allow work.
    throw new ApiError(503, "Run admission is temporarily unavailable. Try again later.");
  }
  if (!Array.isArray(result) || result.length !== 3 || ![0, 1].includes(result[0])) {
    throw new ApiError(503, "Run admission returned an invalid response.");
  }
  if (result[0] !== 1) {
    const message = result[2] === 1
      ? "Too many active runs. Wait for a run to finish."
      : result[2] === 2
        ? "Run rate limit reached. Try again shortly."
        : "Daily run or reserved output-token budget reached. Try again tomorrow.";
    throw new ApiError(429, message, Math.max(1, Math.ceil(result[1])));
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await redis.eval(RELEASE_RUN_SCRIPT, keys.slice(0, 3), [leaseId]);
      } catch {
        // Preserve the reservation until TTL rather than risk early admission.
        console.error("Run lease release failed; it will expire automatically.");
      }
    },
  };
}
