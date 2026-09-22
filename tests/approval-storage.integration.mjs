import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { test } from "node:test";
import { createModuleLoader } from "./load-module.mjs";

const exec = promisify(execFile);
const container = process.env.TEST_REDIS_CONTAINER ?? "jev-security-redis";
const INITIAL_TOKEN = "initial-checkpoint-token-for-tests";

async function redisCommand(...args) {
  const { stdout } = await exec("docker", ["exec", container, "redis-cli", "--json", ...args.map(String)]);
  const value = JSON.parse(stdout.trim());
  if (typeof value === "string" && value.startsWith("ERR ")) throw new Error(value);
  return value;
}

function loader(workspace, evalOverride) {
  return createModuleLoader({
    env: { UPSTASH_REDIS_REST_URL: "https://local-redis.test", UPSTASH_REDIS_REST_TOKEN: "local-only" },
    stubs: {
      nanoid: { nanoid: randomUUID },
      "./liveblocks": { getWorkspaceId: () => workspace },
      "./auth": { getPrincipal: async () => null },
      "@upstash/redis": { Redis: class {
        async eval(script, keys, args) {
          return evalOverride ? evalOverride(script, keys, args) : redisCommand("EVAL", script, keys.length, ...keys, ...args);
        }
      } },
    },
  });
}

function checkpoint() {
  const now = Date.now();
  return {
    version: 1, roomId: `room-${randomUUID()}`, runId: `run-${randomUUID()}`, input: "request", trigger: "test", startedAt: now,
    graph: { nodes: [], edges: [] }, states: [], messages: [],
    pending: ["left", "right"].map((nodeId) => ({ nodeId, expiresAt: now + 24 * 60 * 60 * 1000 - 1000, state: { output: "request", answers: {}, firedHandles: [] } })),
    budget: { intermediate: 21, prompts: 14, feed: 400 }, executions: 2,
  };
}

function options(saved, nodeId = "left", decision = "approved", expectedToken = INITIAL_TOKEN) {
  return { roomId: saved.roomId, runId: saved.runId, nodeId, decision, actorId: "owner", expectedToken };
}

function storageKey(workspace, saved) {
  return `jev:approval:${createHash("sha256").update(JSON.stringify([workspace, saved.roomId, saved.runId])).digest("hex")}`;
}

test("restart reads durable snapshot; racing app instances claim exactly once and interrupted resumes stay consumed", async () => {
  const workspace = randomUUID();
  const first = await loader(workspace)("app/workflow/server/approvals");
  const saved = checkpoint();
  await first.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true);
  const ttl = await redisCommand("PTTL", storageKey(workspace, saved));
  assert(ttl > 23 * 60 * 60 * 1000 && ttl <= 24 * 60 * 60 * 1000);
  const second = await loader(workspace)("app/workflow/server/approvals");
  const races = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).claimApproval(options(saved))));
  const accepted = races.filter((item) => item.status === "fulfilled");
  assert.equal(accepted.length, 1);
  assert(races.filter((item) => item.status === "rejected").every((item) => item.reason.status === 409));
  const claim = accepted[0].value;
  assert.deepEqual(JSON.parse(JSON.stringify(claim.checkpoint)), saved);
  assert.equal(claim.decidedBy, "owner");
  assert(claim.decidedAt >= saved.startedAt && claim.decidedAt <= Date.now());
  assert.equal(await redisCommand("HEXISTS", storageKey(workspace, saved), "payload"), 0);
  // No resume/finalize is performed: a later process must not recover and replay side effects.
  const afterCrash = await loader(workspace)("app/workflow/server/approvals");
  await assert.rejects(afterCrash.claimApproval(options(saved)), (error) => error.status === 409);
});

test("workspace, room, run, node, owner and stored hash binding cannot be crossed", async () => {
  const workspace = randomUUID();
  const storage = await loader(workspace)("app/workflow/server/approvals");
  const saved = checkpoint();
  await storage.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true);
  const foreignWorkspace = await loader(randomUUID())("app/workflow/server/approvals");
  await assert.rejects(foreignWorkspace.claimApproval(options(saved)), (error) => error.status === 410);
  for (const changes of [{ roomId: "another-room" }, { runId: "run-another" }, { nodeId: "another-node" }]) {
    await assert.rejects(storage.claimApproval({ ...options(saved), ...changes }), (error) => error.status === 410);
  }
  await assert.rejects(storage.claimApproval({ ...options(saved), actorId: "api:automation" }), (error) => error.status === 400);
  const forged = await redisCommand("EVAL", storage.CLAIM_APPROVAL_SCRIPT, 1, storageKey(workspace, saved),
    workspace, "different-room", saved.runId, "left", "approved", "owner", "forged-token", 86400000, storage.MAX_APPROVAL_CHECKPOINT_BYTES, INITIAL_TOKEN);
  assert.equal(forged[0], 410);
  assert.equal((await storage.claimApproval(options(saved, "left", "rejected"))).decision, "rejected");
});

test("parallel approval decisions re-checkpoint with CAS and cannot resurrect a previous decision", async () => {
  const workspace = randomUUID();
  const storage = await loader(workspace)("app/workflow/server/approvals");
  const saved = checkpoint();
  await storage.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true);
  const left = await storage.claimApproval(options(saved));
  const next = { ...left.checkpoint, pending: left.checkpoint.pending.filter((item) => item.nodeId !== "left") };
  await storage.saveApprovalCheckpoint(next, left.token, false);
  await assert.rejects(storage.claimApproval(options(saved, "left", "approved", left.token)), (error) => error.status === 409);
  const right = await storage.claimApproval(options(saved, "right", "rejected", left.token));
  await assert.rejects(storage.saveApprovalCheckpoint(next, left.token, false), /consumed/);
  await storage.finishApprovalRun(saved.roomId, saved.runId, left.token, "error");
  // Stale completion cannot invalidate the current owner, who can write a new sequential approval.
  const sequential = { ...right.checkpoint, pending: [{ ...saved.pending[0], nodeId: "later" }] };
  await storage.saveApprovalCheckpoint(sequential, right.token, false);
  const later = await storage.claimApproval(options(saved, "later", "approved", right.token));
  await storage.finishApprovalRun(saved.roomId, saved.runId, later.token, "complete");
  await assert.rejects(storage.claimApproval(options(saved, "later")), (error) => error.status === 409);
});

test("expiry never auto-approves and an expired parallel member closes the entire checkpoint", async () => {
  const workspace = randomUUID();
  const storage = await loader(workspace)("app/workflow/server/approvals");
  const saved = checkpoint();
  await storage.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true);
  const expiredPending = saved.pending.map(({ nodeId, expiresAt }) => ({ nodeId, expiresAt: nodeId === "right" ? Date.now() - 1 : expiresAt }));
  await redisCommand("HSET", storageKey(workspace, saved), "pending", JSON.stringify(expiredPending));
  await assert.rejects(storage.claimApproval(options(saved)), (error) => error.status === 410);
  assert.equal(await redisCommand("HEXISTS", storageKey(workspace, saved), "payload"), 0);
  const expired = checkpoint();
  await storage.saveApprovalCheckpoint(expired, INITIAL_TOKEN, true);
  await redisCommand("PEXPIREAT", storageKey(workspace, expired), 1);
  await assert.rejects(storage.claimApproval(options(expired)), (error) => error.status === 410);
});

test("terminal tombstone prevents delayed initial SAVE from publishing a failed phase", async () => {
  const workspace = randomUUID();
  const storage = await loader(workspace)("app/workflow/server/approvals");
  const saved = checkpoint();
  await storage.finishApprovalRun(saved.roomId, saved.runId, INITIAL_TOKEN, "error");
  await assert.rejects(storage.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true), /consumed/);
  await assert.rejects(storage.claimApproval(options(saved)), (error) => error.status === 409);
  assert.equal(await redisCommand("HEXISTS", storageKey(workspace, saved), "payload"), 0);
});

test("checkpoint budgets and UTF-8 byte caps fail closed before oversized Redis requests", async () => {
  let requests = 0;
  const storage = await loader(randomUUID(), async () => { requests++; return 1; })("app/workflow/server/approvals");
  const saved = checkpoint();
  saved.input = "ก".repeat(140000);
  await assert.rejects(storage.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true), /checkpoint bytes/);
  assert.equal(requests, 0);
  saved.input = "x".repeat(storage.MAX_APPROVAL_CHECKPOINT_CHARS + 1);
  await assert.rejects(storage.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true), /Approval checkpoint/);
  assert.equal(requests, 0);
});

test("invalid persisted payload is consumed rather than retried, and transport errors stay sanitized", async () => {
  const workspace = randomUUID();
  const storage = await loader(workspace)("app/workflow/server/approvals");
  const saved = checkpoint();
  await storage.saveApprovalCheckpoint(saved, INITIAL_TOKEN, true);
  await redisCommand("HSET", storageKey(workspace, saved), "payload", "malformed-private-payload");
  await assert.rejects(storage.claimApproval(options(saved)), (error) => error.status === 410 && !error.message.includes("private"));
  await assert.rejects(storage.claimApproval(options(saved)), (error) => error.status === 409);
  const unavailable = await loader(randomUUID(), async () => { throw new Error("redis-token-do-not-leak"); })("app/workflow/server/approvals");
  await assert.rejects(unavailable.saveApprovalCheckpoint(checkpoint(), INITIAL_TOKEN, true), (error) => !error.message.includes("redis-token"));
  await assert.rejects(unavailable.claimApproval(options(saved)), (error) => error.status === 503 && !error.message.includes("redis-token"));
});

test("unpublished or old phase tokens cannot claim a possibly saved checkpoint", async () => {
  const workspace = randomUUID();
  const storage = await loader(workspace)("app/workflow/server/approvals");
  const saved = checkpoint();
  const unpublished = randomUUID();
  await storage.saveApprovalCheckpoint(saved, unpublished, true);
  await assert.rejects(storage.claimApproval(options(saved)), (error) => error.status === 410);
  // Only the acknowledged save's exact feed-published token can authorize claim.
  const first = await storage.claimApproval(options(saved, "left", "approved", unpublished));
  const next = { ...first.checkpoint, pending: first.checkpoint.pending.filter((item) => item.nodeId === "right") };
  await storage.saveApprovalCheckpoint(next, first.token, false);
  await assert.rejects(storage.claimApproval(options(saved, "right", "approved", unpublished)), (error) => error.status === 410);
  const accepted = await storage.claimApproval(options(saved, "right", "approved", first.token));
  assert.equal(accepted.nodeId, "right");
});
