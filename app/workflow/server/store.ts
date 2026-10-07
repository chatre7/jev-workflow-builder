import "server-only";

import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { createDemoWorkflow, DEMO_WORKFLOW_NAME } from "../demo";
import type { NodeResultData, RunMetadata } from "../runs";
import { ROOM_ID_PREFIX, toStoredGraph, type WorkflowEdge, type WorkflowNode } from "../shared";
import type { Principal } from "./auth";
import { ExecutionError, MAX_GRAPH_EDGES, MAX_GRAPH_NODES, MAX_GRAPH_STORAGE_CHARS, checkLimit, jsonSize } from "./execution-policy";
import { getRedis, getRedisConfigurationError } from "./redis";
import { ApiError } from "./request-security";

/**
 * Redis is the only store: workflows, their graphs and every run trace live in
 * one hash each, under a per-workspace hash tag so all keys share a slot.
 *
 *   jev:store:{ws}:workflows      ZSET  workflowId -> updatedAt
 *   jev:store:{ws}:wf:<id>        HASH  name, createdAt, updatedAt, version, graph
 *   jev:store:{ws}:wf:<id>:runs   ZSET  runId -> startedAt (newest MAX_STORED_RUNS kept)
 *   jev:store:{ws}:run:<runId>    HASH  metadata fields + node:<nodeId> -> JSON trace
 */
const WORKFLOW_ID = /^[A-Za-z0-9_-]{10,64}$/;
const RUN_ID = /^run-[A-Za-z0-9_-]{1,64}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WORKFLOW_NAME_LENGTH = 120;
export const MAX_STORED_RUNS = 50;
export const MAX_LISTED_WORKFLOWS = 200;
export { MAX_GRAPH_STORAGE_CHARS };
const NODE_FIELD = "node:";

export type WorkflowSummary = {
  workflowId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

export type RunRecord = { runId: string; metadata: RunMetadata };

export function getWorkspaceId(): string {
  const workspaceId = process.env.WORKFLOW_WORKSPACE_ID ?? "private";
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new Error("WORKFLOW_WORKSPACE_ID must contain 1–64 letters, numbers, underscores or hyphens.");
  }
  return workspaceId;
}

export function getStoreConfigurationError(): string | null {
  if (!WORKSPACE_ID.test(process.env.WORKFLOW_WORKSPACE_ID ?? "private")) {
    return "WORKFLOW_WORKSPACE_ID must contain 1–64 letters, numbers, underscores or hyphens.";
  }
  return getRedisConfigurationError();
}

/** Stable per-workflow scope used by admission and approval keys. */
export function getRoomId(workflowId: string): string {
  if (typeof workflowId !== "string" || !WORKFLOW_ID.test(workflowId)) {
    throw new Error("Invalid workflow ID.");
  }
  return `${ROOM_ID_PREFIX}:${getWorkspaceId()}:${workflowId}`;
}

export function workflowIdFromRoomId(roomId: string): string {
  const prefix = `${ROOM_ID_PREFIX}:${getWorkspaceId()}:`;
  const workflowId = typeof roomId === "string" && roomId.startsWith(prefix) ? roomId.slice(prefix.length) : "";
  if (!WORKFLOW_ID.test(workflowId)) throw new Error("Invalid workflow scope.");
  return workflowId;
}

function keys() {
  const tag = createHash("sha256").update(getWorkspaceId()).digest("hex").slice(0, 24);
  const prefix = `jev:store:{${tag}}`;
  return {
    workflows: `${prefix}:workflows`,
    workflow: (id: string) => `${prefix}:wf:${id}`,
    runs: (id: string) => `${prefix}:wf:${id}:runs`,
    run: (runId: string) => `${prefix}:run:${runId}`,
  };
}

function assertPrincipal(principal: Principal): void {
  // Only trusted server callers construct principals, including run-only API
  // automation. Workspace membership comes from the deployment, never client input.
  if (!principal || typeof principal.id !== "string" || !principal.id) {
    throw new Error("Authentication required.");
  }
}

function assertWorkflowId(workflowId: unknown): asserts workflowId is string {
  if (typeof workflowId !== "string" || !WORKFLOW_ID.test(workflowId)) throw new Error("Invalid workflow ID.");
}

function assertRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("Invalid run ID.");
}

function validateWorkflowName(name: string): string {
  if (typeof name !== "string" || name.length > MAX_WORKFLOW_NAME_LENGTH) {
    throw new Error(`Workflow names must be at most ${MAX_WORKFLOW_NAME_LENGTH} characters.`);
  }
  return name.trim() || "Untitled workflow";
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type StoredStrings = Record<string, string>;

/**
 * With automatic deserialization off, HMGET answers with an array aligned to
 * the requested fields and HGETALL with a flat field/value array. Both are
 * read here as string records; a hash with no fields reads as null.
 */
function fieldsFrom(names: readonly string[], raw: unknown): StoredStrings | null {
  const result: StoredStrings = {};
  let any = false;
  if (Array.isArray(raw)) {
    names.forEach((name, index) => {
      if (typeof raw[index] === "string") {
        result[name] = raw[index];
        any = true;
      }
    });
  } else if (raw && typeof raw === "object") {
    for (const name of names) {
      const value = (raw as Record<string, unknown>)[name];
      if (typeof value === "string") {
        result[name] = value;
        any = true;
      }
    }
  }
  return any ? result : null;
}

function hashFrom(raw: unknown): StoredStrings | null {
  const result: StoredStrings = {};
  let any = false;
  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      if (typeof raw[index] === "string" && typeof raw[index + 1] === "string") {
        result[raw[index]] = raw[index + 1];
        any = true;
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") {
        result[key] = value;
        any = true;
      }
    }
  }
  return any ? result : null;
}

const WORKFLOW_FIELDS = ["name", "createdAt", "updatedAt"] as const;

function summarize(workflowId: string, fields: StoredStrings | null): WorkflowSummary | null {
  if (!fields) return null;
  const createdAt = integer(fields.createdAt);
  const updatedAt = integer(fields.updatedAt);
  if (createdAt === null || updatedAt === null) return null;
  return {
    workflowId,
    name: typeof fields.name === "string" && fields.name ? fields.name : "Untitled workflow",
    createdAt,
    updatedAt,
  };
}

/* ------------------------------- Workflows -------------------------------- */

export async function listWorkflows(principal: Principal): Promise<WorkflowSummary[]> {
  assertPrincipal(principal);
  const redis = getRedis();
  const k = keys();
  const ids = await redis.zrange<string[]>(k.workflows, 0, MAX_LISTED_WORKFLOWS - 1, { rev: true });
  const valid = ids.filter((id) => typeof id === "string" && WORKFLOW_ID.test(id));
  if (valid.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const id of valid) pipeline.hmget(k.workflow(id), ...WORKFLOW_FIELDS);
  const rows = await pipeline.exec<unknown[]>();
  return valid
    .map((id, index) => summarize(id, fieldsFrom(WORKFLOW_FIELDS, rows[index])))
    .filter((summary): summary is WorkflowSummary => summary !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getWorkflow(workflowId: string, principal: Principal): Promise<WorkflowSummary | null> {
  assertPrincipal(principal);
  if (typeof workflowId !== "string" || !WORKFLOW_ID.test(workflowId)) return null;
  const fields = await getRedis().hmget(keys().workflow(workflowId), ...WORKFLOW_FIELDS);
  return summarize(workflowId, fieldsFrom(WORKFLOW_FIELDS, fields));
}

function graphText(graph: WorkflowGraph): string {
  const stored = toStoredGraph(graph);
  checkLimit(stored.nodes.length, MAX_GRAPH_NODES, "Workflow nodes");
  checkLimit(stored.edges.length, MAX_GRAPH_EDGES, "Workflow connections");
  jsonSize(stored, MAX_GRAPH_STORAGE_CHARS, "Stored graph");
  return JSON.stringify(stored);
}

export async function createWorkflow(
  principal: Principal,
  options: {
    name?: string;
    seedDemo?: boolean;
    // Already validated by the caller (backup import); never raw client input.
    graph?: WorkflowGraph;
  } = {}
): Promise<WorkflowSummary> {
  assertPrincipal(principal);
  const workflowId = nanoid(10);
  const name = validateWorkflowName(options.name ?? (options.seedDemo ? DEMO_WORKFLOW_NAME : "Untitled workflow"));
  const graph = options.graph ?? (options.seedDemo === true ? createDemoWorkflow() : { nodes: [], edges: [] });
  const now = Date.now();
  const k = keys();
  const pipeline = getRedis().pipeline();
  pipeline.hset(k.workflow(workflowId), {
    name, createdAt: String(now), updatedAt: String(now), version: "1", graph: graphText(graph),
  });
  pipeline.zadd(k.workflows, { score: now, member: workflowId });
  await pipeline.exec();
  return { workflowId, name, createdAt: now, updatedAt: now };
}

export async function renameWorkflow(workflowId: string, principal: Principal, name: string): Promise<void> {
  const nextName = validateWorkflowName(name);
  if (!(await getWorkflow(workflowId, principal))) throw new Error("Workflow not found.");
  const now = Date.now();
  const k = keys();
  const pipeline = getRedis().pipeline();
  pipeline.hset(k.workflow(workflowId), { name: nextName, updatedAt: String(now) });
  pipeline.zadd(k.workflows, { score: now, member: workflowId });
  await pipeline.exec();
}

function parseGraph(text: unknown): WorkflowGraph {
  if (text === null || text === undefined) return { nodes: [], edges: [] };
  if (typeof text !== "string" || text.length > MAX_GRAPH_STORAGE_CHARS) throw new Error("Invalid workflow storage.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid workflow storage.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid workflow storage.");
  const { nodes, edges } = parsed as Record<string, unknown>;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error("Invalid workflow graph storage.");
  if (nodes.length > MAX_GRAPH_NODES || edges.length > MAX_GRAPH_EDGES) {
    throw new ExecutionError("Workflow graph exceeds execution limits.");
  }
  return { nodes: nodes as WorkflowNode[], edges: edges as WorkflowEdge[] };
}

/** Reads the saved graph of an already-authorized workflow scope. */
export async function readWorkflowGraph(roomId: string, signal?: AbortSignal): Promise<WorkflowGraph> {
  signal?.throwIfAborted();
  const workflowId = workflowIdFromRoomId(roomId);
  const text = await getRedis().hget<string>(keys().workflow(workflowId), "graph");
  return parseGraph(text);
}

export async function getWorkflowGraph(
  workflowId: string,
  principal: Principal
): Promise<{ graph: WorkflowGraph; version: number } | null> {
  assertPrincipal(principal);
  if (typeof workflowId !== "string" || !WORKFLOW_ID.test(workflowId)) return null;
  const names = ["graph", "version", "createdAt"] as const;
  const fields = fieldsFrom(names, await getRedis().hmget(keys().workflow(workflowId), ...names));
  if (!fields || integer(fields.createdAt) === null) return null;
  return { graph: parseGraph(fields.graph), version: integer(fields.version) ?? 0 };
}

// Compare-and-set so a stale tab cannot overwrite a newer save.
export const SAVE_GRAPH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1, 0} end
local version = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
if version ~= tonumber(ARGV[1]) then return {0, version} end
redis.call('HSET', KEYS[1], 'graph', ARGV[2], 'version', version + 1, 'updatedAt', ARGV[3])
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[4])
return {1, version + 1}
`;

export async function saveWorkflowGraph(
  workflowId: string,
  principal: Principal,
  graph: WorkflowGraph,
  expectedVersion: number
): Promise<{ version: number }> {
  assertPrincipal(principal);
  assertWorkflowId(workflowId);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new ApiError(400, "Invalid graph version.");
  const k = keys();
  const result = await getRedis().eval<(string | number)[], number[]>(
    SAVE_GRAPH_SCRIPT, [k.workflow(workflowId), k.workflows],
    [expectedVersion, graphText(graph), Date.now(), workflowId]
  );
  if (!Array.isArray(result) || result.length !== 2) throw new Error("Workflow storage returned an invalid response.");
  if (result[0] === -1) throw new ApiError(404, "Workflow not found.");
  if (result[0] !== 1) throw new ApiError(409, "This workflow was changed elsewhere. Reload to continue editing.");
  return { version: Number(result[1]) };
}

/* ---------------------------------- Runs ---------------------------------- */

export type RunStore = {
  createRun(args: { roomId: string; runId: string; metadata: RunMetadata }, options?: { signal?: AbortSignal }): Promise<void>;
  updateRun(args: { roomId: string; runId: string; metadata: RunMetadata }, options?: { signal?: AbortSignal }): Promise<void>;
  writeNode(args: { roomId: string; runId: string; data: NodeResultData }, options?: { signal?: AbortSignal }): Promise<void>;
};

function metadataFields(metadata: RunMetadata): StoredStrings {
  const fields: StoredStrings = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" && !key.startsWith(NODE_FIELD)) fields[key] = value;
  }
  fields.updatedAt = String(Date.now());
  return fields;
}

// Registers a run and evicts the oldest beyond MAX_STORED_RUNS, returning their IDs.
export const CREATE_RUN_SCRIPT = `
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[2])
local evicted = redis.call('ZRANGE', KEYS[1], 0, -(tonumber(ARGV[3]) + 1))
if #evicted > 0 then redis.call('ZREM', KEYS[1], unpack(evicted)) end
return evicted
`;

export const DELETE_RUN_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'running' then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

export function getRunStore(): RunStore {
  const redis = getRedis();
  const k = keys();
  return {
    async createRun({ roomId, runId, metadata }) {
      const workflowId = workflowIdFromRoomId(roomId);
      assertRunId(runId);
      const startedAt = integer(metadata.startedAt) ?? Date.now();
      await redis.hset(k.run(runId), { ...metadataFields(metadata), workflowId });
      const evicted = await redis.eval<(string | number)[], string[]>(
        CREATE_RUN_SCRIPT, [k.runs(workflowId)], [startedAt, runId, MAX_STORED_RUNS]
      );
      const stale = Array.isArray(evicted) ? evicted.filter((id): id is string => typeof id === "string" && RUN_ID.test(id)) : [];
      if (stale.length > 0) await redis.del(...stale.map((id) => k.run(id)));
    },
    async updateRun({ roomId, runId, metadata }) {
      workflowIdFromRoomId(roomId);
      assertRunId(runId);
      await redis.hset(k.run(runId), metadataFields(metadata));
    },
    async writeNode({ roomId, runId, data }) {
      workflowIdFromRoomId(roomId);
      assertRunId(runId);
      if (typeof data.nodeId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(data.nodeId)) throw new Error("Invalid node ID.");
      await redis.hset(k.run(runId), { [`${NODE_FIELD}${data.nodeId}`]: JSON.stringify(data), updatedAt: String(Date.now()) });
    },
  };
}

const METADATA_KEYS = [
  "status", "trigger", "input", "question", "startedAt", "completedAt", "error",
  "approvalToken", "inputTokens", "outputTokens", "cost",
] as const;

function readMetadata(fields: StoredStrings, workflowId: string): RunMetadata | null {
  if (fields.workflowId !== workflowId) return null;
  if (!["running", "waiting", "complete", "error"].includes(fields.status)) return null;
  if (fields.trigger !== "test" && fields.trigger !== "api") return null;
  if (integer(fields.startedAt) === null) return null;
  const metadata: Record<string, string> = {};
  for (const key of METADATA_KEYS) if (typeof fields[key] === "string") metadata[key] = fields[key];
  return metadata as unknown as RunMetadata;
}

/** Only the metadata: what the approval route needs to admit a decision. */
export async function getRunMetadata(workflowId: string, runId: string): Promise<RunMetadata | null> {
  assertWorkflowId(workflowId);
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return null;
  const names = ["workflowId", ...METADATA_KEYS] as const;
  const fields = fieldsFrom(names, await getRedis().hmget(keys().run(runId), ...names));
  return fields ? readMetadata(fields, workflowId) : null;
}

export async function listRuns(workflowId: string): Promise<RunRecord[]> {
  assertWorkflowId(workflowId);
  const redis = getRedis();
  const k = keys();
  const ids = await redis.zrange<string[]>(k.runs(workflowId), 0, MAX_STORED_RUNS - 1, { rev: true });
  const valid = ids.filter((id) => typeof id === "string" && RUN_ID.test(id));
  if (valid.length === 0) return [];
  const names = ["workflowId", ...METADATA_KEYS] as const;
  const pipeline = redis.pipeline();
  for (const id of valid) pipeline.hmget(k.run(id), ...names);
  const rows = await pipeline.exec<unknown[]>();
  const runs: RunRecord[] = [];
  valid.forEach((runId, index) => {
    const fields = fieldsFrom(names, rows[index]);
    const metadata = fields ? readMetadata(fields, workflowId) : null;
    if (metadata) runs.push({ runId, metadata });
  });
  return runs;
}

export async function getRun(
  workflowId: string,
  runId: string
): Promise<{ runId: string; metadata: RunMetadata; nodes: NodeResultData[]; updatedAt: number } | null> {
  assertWorkflowId(workflowId);
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return null;
  const fields = hashFrom(await getRedis().hgetall(keys().run(runId)));
  if (!fields) return null;
  const metadata = readMetadata(fields, workflowId);
  if (!metadata) return null;
  const nodes: NodeResultData[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!field.startsWith(NODE_FIELD)) continue;
    try {
      const data = JSON.parse(value) as NodeResultData;
      if (data && typeof data === "object" && data.nodeId === field.slice(NODE_FIELD.length)) nodes.push(data);
    } catch {
      // A damaged node entry hides only itself, never the run.
    }
  }
  nodes.sort((a, b) => a.startedAt - b.startedAt);
  return { runId, metadata, nodes, updatedAt: integer(fields.updatedAt) ?? 0 };
}

export async function deleteRun(workflowId: string, runId: string): Promise<boolean> {
  assertWorkflowId(workflowId);
  assertRunId(runId);
  const k = keys();
  const result = await getRedis().eval<(string | number)[], number>(
    DELETE_RUN_SCRIPT, [k.run(runId), k.runs(workflowId)], [runId]
  );
  return result === 1;
}
