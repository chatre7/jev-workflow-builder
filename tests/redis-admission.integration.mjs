import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createModuleLoader } from "./load-module.mjs";

const exec = promisify(execFile);
const container = process.env.TEST_REDIS_CONTAINER ?? "jev-security-redis";

async function redisCommand(...args) {
  const { stdout } = await exec("docker", ["exec", container, "redis-cli", "--json", ...args.map(String)]);
  const value = JSON.parse(stdout.trim());
  if (typeof value === "string" && value.startsWith("ERR ")) throw new Error(value);
  return value;
}

function loader(workspace) {
  return createModuleLoader({
    env: { UPSTASH_REDIS_REST_URL: "https://local-redis.test", UPSTASH_REDIS_REST_TOKEN: "local-only" },
    stubs: {
      "./liveblocks": { getWorkspaceId: () => workspace },
      "./auth": { getPrincipal: async () => null },
      "./execution-policy": { MAX_RUN_LLM_OUTPUT_TOKENS: 25 * 2048 },
      "@upstash/redis": { Redis: class {
        async eval(script, keys, args) { return redisCommand("EVAL", script, keys.length, ...keys, ...args); }
      } },
    },
  });
}

test("independent app instances cannot exceed the shared per-room lease", async () => {
  const workspace = randomUUID();
  const first = await loader(workspace)("app/workflow/server/run-admission.ts");
  const second = await loader(workspace)("app/workflow/server/run-admission.ts");
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    (i % 2 ? first : second).acquireRunLease(`member-${i}`, "same-room")));
  const accepted = attempts.filter(result => result.status === "fulfilled");
  assert.equal(accepted.length, 1);
  assert(attempts.filter(result => result.status === "rejected").every(result => result.reason.status === 429));
  await accepted[0].value.release();
  const next = await second.acquireRunLease("other-member", "same-room");
  // A duplicate release cannot remove a newer owner's reservation.
  await accepted[0].value.release();
  await assert.rejects(first.acquireRunLease("another-member", "same-room"), error => error.status === 429);
  await next.release();
});

test("shared workspace concurrency remains bounded across different rooms and users", async () => {
  const admission = await loader(randomUUID())("app/workflow/server/run-admission.ts");
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    admission.acquireRunLease(`member-${i}`, `room-${i}`)));
  const accepted = attempts.filter(result => result.status === "fulfilled");
  assert.equal(accepted.length, admission.ADMISSION_LIMITS.workspaceConcurrent);
  await Promise.all(accepted.map(result => result.value.release()));
});

test("release does not refund daily run or output-token reservations", async () => {
  const admission = await loader(randomUUID())("app/workflow/server/run-admission.ts");
  const prefix = `security-test:{${randomUUID()}}`;
  const keys = Array.from({ length: 9 }, (_, i) => `${prefix}:${i}`);
  // Two output-token reservations fit; the third must be refused even after release.
  const limits = [150000, 4, 2, 1, 100, 100, 100, 100, 20, 20, 10];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    const result = await redisCommand("EVAL", admission.ADMIT_RUN_SCRIPT, keys.length, ...keys, id, ...limits);
    assert.equal(result[0], 1);
    await redisCommand("EVAL", admission.RELEASE_RUN_SCRIPT, 3, ...keys.slice(0, 3), id);
  }
  const denied = await redisCommand("EVAL", admission.ADMIT_RUN_SCRIPT, keys.length, ...keys, randomUUID(), ...limits);
  assert.equal(denied[0], 0);
  assert.equal(denied[2], 3);
  assert(denied[1] > 0);
});

test("a Redis outage never falls back to unrestricted in-process admission", async () => {
  const load = createModuleLoader({
    env: { UPSTASH_REDIS_REST_URL: "https://local-redis.test", UPSTASH_REDIS_REST_TOKEN: "local-only" },
    stubs: {
      "./liveblocks": { getWorkspaceId: () => "test" },
      "./auth": { getPrincipal: async () => null },
      "./execution-policy": { MAX_RUN_LLM_OUTPUT_TOKENS: 51200 },
      "@upstash/redis": { Redis: class { async eval() { throw new Error("Unavailable"); } } },
    },
  });
  const admission = await load("app/workflow/server/run-admission.ts");
  await assert.rejects(admission.acquireRunLease("member", "room"), error => error.status === 503);
});
