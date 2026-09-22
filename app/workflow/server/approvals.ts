import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { APPROVAL_TTL_MS, type AnswerValue, type WorkflowEdge, type WorkflowNode } from "../shared";
import type { NodeResultData, RunTrigger } from "../runs";
import { ExecutionError, RunBudget, checkLimit, jsonSize, type RunBudgetState } from "./execution-policy";
import { getRedis } from "./redis";
import { getWorkspaceId } from "./liveblocks";
import { ApiError } from "./request-security";

// Leave room for the Lua script and the REST envelope below Redis's 1 MiB request limit.
export const MAX_APPROVAL_CHECKPOINT_CHARS = 512_000;
export const MAX_APPROVAL_CHECKPOINT_BYTES = 384 * 1024;
export const MAX_APPROVAL_REQUEST_BYTES = 768 * 1024;

export type SavedNodeState = {
  output: string;
  answers: Record<string, AnswerValue>;
  firedHandles: string[];
};
export type PendingApproval = { nodeId: string; expiresAt: number; state: SavedNodeState };
export type ApprovalCheckpoint = {
  version: 1;
  roomId: string;
  runId: string;
  input: string;
  trigger: RunTrigger;
  startedAt: number;
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  states: Array<{ nodeId: string; state: SavedNodeState | null }>;
  pending: PendingApproval[];
  messages: NodeResultData[];
  budget: RunBudgetState;
  executions: number;
};
export type ClaimedApproval = {
  checkpoint: ApprovalCheckpoint;
  token: string;
  nodeId: string;
  decision: "approved" | "rejected";
  decidedAt: number;
  decidedBy: string;
};

export const SAVE_APPROVAL_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local pending = cjson.decode(ARGV[6])
local expires = now
if #pending == 0 then return 0 end
for _, item in ipairs(pending) do
  if item.expiresAt <= now or item.expiresAt > now + tonumber(ARGV[7]) then return 0 end
  expires = math.max(expires, item.expiresAt)
end
if ARGV[8] == 'initial' then
  if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
else
  if redis.call('HGET', KEYS[1], 'status') ~= 'running' or redis.call('HGET', KEYS[1], 'token') ~= ARGV[4] then return 0 end
  if redis.call('HGET', KEYS[1], 'workspace') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'room') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'run') ~= ARGV[3] then return 0 end
end
redis.call('HSET', KEYS[1], 'workspace', ARGV[1], 'room', ARGV[2], 'run', ARGV[3], 'token', ARGV[4], 'status', 'waiting', 'payload', ARGV[5], 'pending', ARGV[6])
redis.call('PEXPIREAT', KEYS[1], expires)
return 1
`;

export const CLAIM_APPROVAL_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {410} end
if redis.call('HGET', KEYS[1], 'workspace') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'room') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'run') ~= ARGV[3] then return {410} end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'expired' then return {410} end
if status ~= 'waiting' then return {409} end
if redis.call('HGET', KEYS[1], 'token') ~= ARGV[10] then return {410} end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local found = false
for _, item in ipairs(cjson.decode(redis.call('HGET', KEYS[1], 'pending'))) do
  if item.expiresAt <= now then
    redis.call('HSET', KEYS[1], 'status', 'expired')
    redis.call('HDEL', KEYS[1], 'payload', 'pending')
    return {410}
  end
  if item.nodeId == ARGV[4] then found = true end
end
if not found then
  if redis.call('HEXISTS', KEYS[1], 'decided:' .. ARGV[4]) == 1 then return {409} end
  return {410}
end
local payload = redis.call('HGET', KEYS[1], 'payload')
if not payload or string.len(payload) > tonumber(ARGV[9]) then return {410} end
redis.call('HSET', KEYS[1], 'status', 'running', 'token', ARGV[7], 'decided:' .. ARGV[4], cjson.encode({decision = ARGV[5], actor = ARGV[6], at = now}))
-- Consume the only resumable copy before returning it. A crashed worker cannot replay it.
redis.call('HDEL', KEYS[1], 'payload', 'pending')
redis.call('PEXPIRE', KEYS[1], ARGV[8])
return {1, payload, now}
`;

export const FINISH_APPROVAL_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'token') ~= ARGV[4] then return 0 end
  if redis.call('HGET', KEYS[1], 'workspace') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'room') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'run') ~= ARGV[3] then return 0 end
end
-- A tombstone also prevents a timed-out initial SAVE arriving after failure.
redis.call('HSET', KEYS[1], 'workspace', ARGV[1], 'room', ARGV[2], 'run', ARGV[3], 'token', ARGV[4], 'status', ARGV[5])
redis.call('HDEL', KEYS[1], 'payload', 'pending')
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return 1
`;

function binding(roomId: string, runId: string): { key: string; workspace: string } {
  const workspace = getWorkspaceId();
  const scope = createHash("sha256").update(JSON.stringify([workspace, roomId, runId])).digest("hex");
  return { key: `jev:approval:${scope}`, workspace };
}

export async function saveApprovalCheckpoint(
  checkpoint: ApprovalCheckpoint,
  token: string,
  initial: boolean
): Promise<void> {
  jsonSize(checkpoint, MAX_APPROVAL_CHECKPOINT_CHARS, "Approval checkpoint");
  const payload = JSON.stringify(checkpoint);
  checkLimit(Buffer.byteLength(payload, "utf8"), MAX_APPROVAL_CHECKPOINT_BYTES, "Approval checkpoint bytes");
  const pending = JSON.stringify(checkpoint.pending.map(({ nodeId, expiresAt }) => ({ nodeId, expiresAt })));
  const { key, workspace } = binding(checkpoint.roomId, checkpoint.runId);
  const args = [workspace, checkpoint.roomId, checkpoint.runId, token, payload, pending, APPROVAL_TTL_MS, initial ? "initial" : "resume"];
  checkLimit(Buffer.byteLength(JSON.stringify(["EVAL", SAVE_APPROVAL_SCRIPT, 1, key, ...args]), "utf8"), MAX_APPROVAL_REQUEST_BYTES, "Approval storage request");
  let result: unknown;
  try {
    result = await getRedis().eval(SAVE_APPROVAL_SCRIPT, [key], args);
  } catch {
    throw new ExecutionError("Approval storage is unavailable. The workflow cannot wait safely.");
  }
  if (result !== 1) throw new ExecutionError("Approval checkpoint expired or was already consumed.");
}

export async function claimApproval(options: {
  roomId: string;
  runId: string;
  nodeId: string;
  decision: "approved" | "rejected";
  actorId: string;
  expectedToken: string;
}): Promise<ClaimedApproval> {
  const { roomId, runId, nodeId, decision, actorId, expectedToken } = options;
  if (!/^run-[A-Za-z0-9_-]{1,64}$/.test(runId) || !/^[A-Za-z0-9_-]{1,96}$/.test(nodeId) ||
      !["approved", "rejected"].includes(decision) || actorId !== "owner" ||
      typeof expectedToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(expectedToken)) {
    throw new ApiError(400, "Invalid approval decision.");
  }
  const { key, workspace } = binding(roomId, runId);
  const token = randomUUID();
  let response: unknown;
  try {
    response = await getRedis().eval(CLAIM_APPROVAL_SCRIPT, [key], [
      workspace, roomId, runId, nodeId, decision, actorId, token, APPROVAL_TTL_MS, MAX_APPROVAL_CHECKPOINT_BYTES, expectedToken,
    ]);
  } catch {
    throw new ApiError(503, "Approval storage is unavailable. No execution was started.");
  }
  if (!Array.isArray(response)) throw new ApiError(503, "Approval storage returned an invalid response.");
  if (response[0] === 409) throw new ApiError(409, "This approval was already decided or its run is busy.");
  if (response[0] !== 1) throw new ApiError(410, "This approval expired or is no longer available.");
  try {
    const [, payload, decidedAt] = response;
    if (typeof payload !== "string" || payload.length > MAX_APPROVAL_CHECKPOINT_CHARS ||
        Buffer.byteLength(payload, "utf8") > MAX_APPROVAL_CHECKPOINT_BYTES || !Number.isSafeInteger(decidedAt)) throw new Error();
    const checkpoint = JSON.parse(payload) as ApprovalCheckpoint;
    if (checkpoint.version !== 1 || checkpoint.roomId !== roomId || checkpoint.runId !== runId ||
        !Array.isArray(checkpoint.pending) || !checkpoint.pending.some((item) => item.nodeId === nodeId && item.expiresAt > decidedAt)) throw new Error();
    jsonSize(checkpoint, MAX_APPROVAL_CHECKPOINT_CHARS, "Approval checkpoint");
    new RunBudget(checkpoint.budget);
    return { checkpoint, token, nodeId, decision, decidedAt, decidedBy: actorId };
  } catch {
    // The claim is deliberately consumed even if the saved data cannot be read.
    throw new ApiError(410, "This approval checkpoint is unavailable and cannot be resumed.");
  }
}

export async function finishApprovalRun(roomId: string, runId: string, token: string, status: "complete" | "error"): Promise<void> {
  const { key, workspace } = binding(roomId, runId);
  try {
    await getRedis().eval(FINISH_APPROVAL_SCRIPT, [key], [workspace, roomId, runId, token, status, APPROVAL_TTL_MS]);
  } catch {
    // A consumed claim stays closed even if the terminal marker cannot be written.
    // An ambiguous checkpoint write is never retried automatically.
    throw new ExecutionError("Approval storage is unavailable. The workflow cannot finish safely.");
  }
}
