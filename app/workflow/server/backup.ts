import "server-only";

import type { WorkflowEdge, WorkflowNode } from "../shared";
import type { Principal } from "./auth";
import { ExecutionError, MAX_GRAPH_EDGES, MAX_GRAPH_NODES, checkLimit, jsonSize } from "./execution-policy";
import { MAX_GRAPH_STORAGE_CHARS, validateWorkflowGraph } from "./execution-validation";
import {
  createWorkflow,
  getRoomId,
  getWorkflow,
  listWorkflows,
  readWorkflowGraph,
  type WorkflowSummary,
} from "./liveblocks";

export const BACKUP_FORMAT = "jev-workflow-backup";
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_WORKFLOWS = 50;
export const MAX_WORKFLOW_NAME_CHARS = 120;
// Canvas coordinates: generous for layout, but never Infinity/NaN or huge.
const MAX_POSITION = 1_000_000;
const RESERVED_KEYS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };

export type ExportedWorkflow = {
  // Informational only: imports always create a new workflow.
  sourceWorkflowId?: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type WorkflowBackup = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  workflows: ExportedWorkflow[];
};

export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

/** Keeps the saved shape only: layout, type and data. React Flow runtime state is dropped. */
export function serializeGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      data: node.data,
    }) as WorkflowNode),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      type: edge.type,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      ...(edge.targetHandle === undefined || edge.targetHandle === null ? {} : { targetHandle: edge.targetHandle }),
    }) as WorkflowEdge),
  };
}

function backup(workflows: ExportedWorkflow[]): WorkflowBackup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), workflows };
}

async function exportOne(workflow: WorkflowSummary, signal?: AbortSignal): Promise<ExportedWorkflow> {
  const graph = serializeGraph(await readWorkflowGraph(getRoomId(workflow.workflowId), signal));
  return { sourceWorkflowId: workflow.workflowId, name: workflow.name, ...graph };
}

export async function exportWorkflow(
  workflowId: string,
  principal: Principal,
  signal?: AbortSignal
): Promise<WorkflowBackup | null> {
  const workflow = await getWorkflow(workflowId, principal);
  if (!workflow) return null;
  return backup([await exportOne(workflow, signal)]);
}

export async function exportAllWorkflows(principal: Principal, signal?: AbortSignal): Promise<WorkflowBackup> {
  const workflows: ExportedWorkflow[] = [];
  // Sequential reads keep storage load bounded; the list is at most 50 workflows.
  for (const workflow of await listWorkflows(principal)) {
    workflows.push(await exportOne(workflow, signal));
  }
  return backup(workflows);
}

function record(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExecutionError(message);
}

function coordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_POSITION) {
    throw new ExecutionError("Backup node positions must be finite numbers.");
  }
  return value;
}

function workflowName(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_WORKFLOW_NAME_CHARS) {
    throw new ExecutionError(`Backup workflow names must be text of at most ${MAX_WORKFLOW_NAME_CHARS} characters.`);
  }
  return value.trim() || "Untitled workflow";
}

/**
 * Accepts only the fields an export writes, then applies the same validation a
 * run uses. An empty canvas is allowed so new, unfinished workflows round-trip.
 */
function importedGraph(value: Record<string, unknown>): WorkflowGraph {
  const { nodes, edges } = value;
  if (!Array.isArray(nodes) || nodes.length > MAX_GRAPH_NODES || !Array.isArray(edges) || edges.length > MAX_GRAPH_EDGES) {
    throw new ExecutionError(`Backup workflows allow at most ${MAX_GRAPH_NODES} nodes and ${MAX_GRAPH_EDGES} connections.`);
  }
  if (nodes.length === 0 && edges.length === 0) return { nodes: [], edges: [] };
  const graph = serializeGraph({
    nodes: nodes.map((node) => {
      record(node, "Backup nodes must be objects.");
      record(node.position, "Backup nodes require a position.");
      if (typeof node.type !== "string" || Object.hasOwn(RESERVED_KEYS, node.type)) {
        throw new ExecutionError("Backup nodes require a node type.");
      }
      record(node.data, "Backup nodes require data.");
      return {
        id: node.id, type: node.type,
        position: { x: coordinate(node.position.x), y: coordinate(node.position.y) },
        data: node.data,
      } as WorkflowNode;
    }),
    edges: edges.map((edge) => {
      record(edge, "Backup connections must be objects.");
      if (edge.type !== "smoothstep") throw new ExecutionError("Backup connections use the workflow edge type.");
      return edge as WorkflowEdge;
    }),
  });
  return validateWorkflowGraph(graph);
}

export function parseBackup(value: unknown): ExportedWorkflow[] {
  record(value, "Backup files contain a JSON object.");
  if (value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) {
    throw new ExecutionError("This file is not a workflow backup from this application.");
  }
  const { workflows } = value;
  if (!Array.isArray(workflows) || workflows.length < 1 || workflows.length > MAX_BACKUP_WORKFLOWS) {
    throw new ExecutionError(`Backups contain between 1 and ${MAX_BACKUP_WORKFLOWS} workflows.`);
  }
  return workflows.map((entry, index) => {
    record(entry, "Backup workflows must be objects.");
    try {
      const graph = importedGraph(entry);
      jsonSize(graph, MAX_GRAPH_STORAGE_CHARS, "Stored graph");
      return { name: workflowName(entry.name), ...graph };
    } catch (error) {
      const reason = error instanceof ExecutionError ? error.message : "Invalid workflow.";
      throw new ExecutionError(`Workflow ${index + 1}: ${reason}`);
    }
  });
}

/** Always creates new workflows: a restore never overwrites what already exists. */
export async function importWorkflows(
  principal: Principal,
  workflows: ExportedWorkflow[]
): Promise<WorkflowSummary[]> {
  checkLimit(workflows.length, MAX_BACKUP_WORKFLOWS, "Backup workflows");
  const created: WorkflowSummary[] = [];
  for (const workflow of workflows) {
    created.push(await createWorkflow(principal, {
      name: workflow.name,
      graph: { nodes: workflow.nodes, edges: workflow.edges },
    }));
  }
  return created;
}

/** ASCII-only download name; the JSON keeps the real workflow name. */
export function backupFilename(name: string | null): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug || "workflows"}-${date}.json`;
}
