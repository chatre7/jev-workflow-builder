import "server-only";

import { Liveblocks, LiveblocksError, type RoomData } from "@liveblocks/node";
import { mutateFlow } from "@liveblocks/react-flow/node";
import { nanoid } from "nanoid";
import { createDemoWorkflow, DEMO_WORKFLOW_NAME } from "../demo";
import {
  WORKFLOW_APP_ID,
  FLOW_STORAGE_KEY,
  ROOM_ID_PREFIX,
  type WorkflowEdge,
  type WorkflowNode,
} from "../shared";
import type { Principal } from "./auth";
import {
  ExecutionError,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
} from "./execution-policy";

let client: Liveblocks | undefined;
const WORKFLOW_ID = /^[A-Za-z0-9_-]{10,64}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WORKFLOW_NAME_LENGTH = 120;

export function getWorkspaceId(): string {
  const workspaceId = process.env.WORKFLOW_WORKSPACE_ID ?? "private";
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new Error(
      "WORKFLOW_WORKSPACE_ID must contain 1–64 letters, numbers, underscores or hyphens."
    );
  }
  return workspaceId;
}

export function getLiveblocksConfigurationError(): string | null {
  if (!process.env.LIVEBLOCKS_SECRET_KEY?.trim()) {
    return "Set LIVEBLOCKS_SECRET_KEY to enable workflow storage.";
  }
  if (!process.env.LIVEBLOCKS_SECRET_KEY.startsWith("sk_")) {
    return "LIVEBLOCKS_SECRET_KEY must be a Liveblocks secret key.";
  }
  if (!WORKSPACE_ID.test(process.env.WORKFLOW_WORKSPACE_ID ?? "private")) {
    return "WORKFLOW_WORKSPACE_ID must contain 1–64 letters, numbers, underscores or hyphens.";
  }
  return null;
}

export function getLiveblocks(): Liveblocks {
  const configurationError = getLiveblocksConfigurationError();
  if (configurationError) {
    throw new Error(configurationError);
  }
  client ??= new Liveblocks({
    secret: process.env.LIVEBLOCKS_SECRET_KEY!,
    // Only set when running against the local Liveblocks dev server.
    baseUrl: process.env.LIVEBLOCKS_BASE_URL,
  });
  return client;
}

export type WorkflowSummary = {
  workflowId: string;
  name: string;
  createdAt: number;
  lastConnectionAt: number | null;
};

export function getRoomId(workflowId: string): string {
  if (typeof workflowId !== "string" || !WORKFLOW_ID.test(workflowId)) {
    throw new Error("Invalid workflow ID.");
  }
  return `${ROOM_ID_PREFIX}:${getWorkspaceId()}:${workflowId}`;
}

function assertPrincipal(principal: Principal): void {
  // Only trusted server callers construct principals, including run-only API
  // automation. Room membership comes from the deployment, never client input.
  if (!principal || typeof principal.id !== "string" || !principal.id) {
    throw new Error("Authentication required.");
  }
}

function matchesWorkflow(room: RoomData, workflowId: string): boolean {
  return (
    room.id === getRoomId(workflowId) &&
    room.metadata.app === WORKFLOW_APP_ID &&
    room.metadata.workspaceId === getWorkspaceId() &&
    room.metadata.workflowId === workflowId &&
    room.defaultAccesses.length === 0
  );
}

function summarizeWorkflow(room: RoomData, workflowId: string): WorkflowSummary {
  return {
    workflowId,
    name:
      typeof room.metadata.name === "string"
        ? room.metadata.name
        : "Untitled workflow",
    createdAt: new Date(room.createdAt).getTime(),
    lastConnectionAt: room.lastConnectionAt
      ? new Date(room.lastConnectionAt).getTime()
      : null,
  };
}

export async function listWorkflows(
  principal: Principal
): Promise<WorkflowSummary[]> {
  assertPrincipal(principal);
  const { data } = await getLiveblocks().getRooms({
    query: {
      metadata: { app: WORKFLOW_APP_ID, workspaceId: getWorkspaceId() },
      roomId: { startsWith: `${ROOM_ID_PREFIX}:${getWorkspaceId()}:` },
    },
    limit: 50,
  });

  return data
    .filter((room) => {
      const id = room.metadata.workflowId;
      return typeof id === "string" && WORKFLOW_ID.test(id) && matchesWorkflow(room, id);
    })
    .map((room) => summarizeWorkflow(room, room.metadata.workflowId as string))
    .sort(
      (a, b) =>
        (b.lastConnectionAt ?? b.createdAt) -
        (a.lastConnectionAt ?? a.createdAt)
    );
}

export async function getWorkflow(
  workflowId: string,
  principal: Principal
): Promise<WorkflowSummary | null> {
  assertPrincipal(principal);
  if (typeof workflowId !== "string" || !WORKFLOW_ID.test(workflowId)) {
    return null;
  }
  try {
    const room = await getLiveblocks().getRoom(getRoomId(workflowId));
    return matchesWorkflow(room, workflowId)
      ? summarizeWorkflow(room, workflowId)
      : null;
  } catch (error) {
    if (error instanceof LiveblocksError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function validateWorkflowName(name: string): string {
  if (typeof name !== "string" || name.length > MAX_WORKFLOW_NAME_LENGTH) {
    throw new Error(`Workflow names must be at most ${MAX_WORKFLOW_NAME_LENGTH} characters.`);
  }
  return name.trim() || "Untitled workflow";
}

export async function createWorkflow(
  principal: Principal,
  options: { name?: string; seedDemo?: boolean } = {}
): Promise<WorkflowSummary> {
  assertPrincipal(principal);
  const workflowId = nanoid(10);
  const roomId = getRoomId(workflowId);
  const name = validateWorkflowName(
    options.name ??
      (options.seedDemo ? DEMO_WORKFLOW_NAME : "Untitled workflow")
  );
  const liveblocks = getLiveblocks();
  const room = await liveblocks.createRoom(roomId, {
    defaultAccesses: [],
    metadata: {
      app: WORKFLOW_APP_ID,
      workspaceId: getWorkspaceId(),
      workflowId,
      name,
    },
  });

  const { nodes, edges } =
    options.seedDemo === true ? createDemoWorkflow() : { nodes: [], edges: [] };
  await mutateFlow<WorkflowNode, WorkflowEdge>(
    { client: liveblocks, roomId, storageKey: FLOW_STORAGE_KEY },
    (flow) => {
      flow.addNodes(nodes);
      flow.addEdges(edges);
    }
  );
  return summarizeWorkflow(room, workflowId);
}

export async function renameWorkflow(
  workflowId: string,
  principal: Principal,
  name: string
): Promise<void> {
  const nextName = validateWorkflowName(name);
  if (!(await getWorkflow(workflowId, principal))) {
    throw new Error("Workflow not found.");
  }
  await getLiveblocks().updateRoom(getRoomId(workflowId), {
    metadata: { name: nextName },
  });
}

function boundedGraphValues<T>(entries: object, limit: number): T[] {
  const values: T[] = [];
  for (const key in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) {
      continue;
    }
    if (values.length >= limit) {
      throw new ExecutionError("Workflow graph exceeds execution limits.");
    }
    values.push((entries as Record<string, T>)[key]);
  }
  return values;
}

/** Reads a privileged snapshot only after the caller authorizes the room. */
export async function readWorkflowGraph(
  roomId: string,
  signal?: AbortSignal
): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }> {
  const storage = (await getLiveblocks().getStorageDocument(roomId, "json", {
    signal,
  })) as Record<string, unknown>;
  const flow = storage[FLOW_STORAGE_KEY];
  if (flow === undefined) {
    return { nodes: [], edges: [] };
  }
  if (flow === null || typeof flow !== "object" || Array.isArray(flow)) {
    throw new Error("Invalid workflow storage.");
  }
  const { nodes, edges } = flow as Record<string, unknown>;
  if (
    nodes === null || typeof nodes !== "object" || Array.isArray(nodes) ||
    edges === null || typeof edges !== "object" || Array.isArray(edges)
  ) {
    throw new Error("Invalid workflow graph storage.");
  }
  // Liveblocks serializes the React Flow LiveMaps as keyed JSON objects.
  return {
    nodes: boundedGraphValues<WorkflowNode>(nodes, MAX_GRAPH_NODES),
    edges: boundedGraphValues<WorkflowEdge>(edges, MAX_GRAPH_EDGES),
  };
}
