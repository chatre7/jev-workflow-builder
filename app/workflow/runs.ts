import type { OutputProperty, WorkflowNodeType } from "./shared";

export type WorkflowOutput = Record<string, string[]>;

export function createEmptyOutput(
  properties: readonly OutputProperty[]
): WorkflowOutput {
  return Object.fromEntries(
    properties.map<[string, string[]]>(({ name }) => [name, []])
  );
}

export function getRunOutput(
  outputs: WorkflowOutput | string[] | undefined
): WorkflowOutput {
  // Older saved runs had one list of outputs without property names.
  return Array.isArray(outputs)
    ? { customer: outputs, team: [] }
    : (outputs ?? {});
}

export type RunStatus = "running" | "waiting" | "complete" | "error";
export type RunTrigger = "test" | "api";
export type NodeStatus = "running" | "waiting" | "complete" | "error" | "skipped";

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type ScoreAnswer = {
  type: "score";
  // Expected score, may fall between two integer levels.
  score: number;
  // Rounded level index that decided which handle fired.
  level: number;
  confidence: number;
  probabilities: Record<string, number>;
};

export type NoulAnswer = {
  type: "noul";
  noul: number;
  threshold: number;
};

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type ApprovalDetails = {
  prompt: string;
  expiresAt: number;
  decision?: "approved" | "rejected";
  decidedAt?: number;
  decidedBy?: string;
};

/**
 * Provider-reported usage for one AI call. Tokens come from every provider;
 * `cost` (USD) is present only when the provider itself states it. Nothing is
 * estimated from a price table.
 */
export type NodeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
};

export type UsageTotals = NodeUsage & {
  // Calls that reported usage, and how many of those also reported a cost.
  calls: number;
  costedCalls: number;
};

export function sumUsage(nodes: readonly { usage?: NodeUsage }[]): UsageTotals {
  const totals: UsageTotals = { calls: 0, costedCalls: 0 };
  for (const { usage } of nodes) {
    if (!usage) continue;
    totals.calls++;
    if (usage.inputTokens !== undefined) totals.inputTokens = (totals.inputTokens ?? 0) + usage.inputTokens;
    if (usage.outputTokens !== undefined) totals.outputTokens = (totals.outputTokens ?? 0) + usage.outputTokens;
    if (usage.cost !== undefined) {
      totals.costedCalls++;
      totals.cost = (totals.cost ?? 0) + usage.cost;
    }
  }
  return totals;
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/**
 * The data stored in one feed message: the result of executing one node.
 */
export type NodeResultData = {
  nodeId: string;
  nodeType: WorkflowNodeType;
  label: string;
  status: NodeStatus;
  // Ids of the upstream nodes whose handles fired into this node.
  parentNodeIds: string[];
  // Whether this node required every incoming handle to fire ("all") or just
  // one ("any").
  activation?: "any" | "all";
  // The resolved `input` state this node received.
  input: string;
  // Input node only: literal question supplied for this run, separate from data.
  question?: string;
  // Generated/transformed text, or unchanged input for Jev and Condition nodes.
  output?: string;
  // Output node only: parent texts per property, in connection order.
  // The array variant supports runs saved before outputs were separated.
  outputs?: WorkflowOutput | string[];
  // Jev answers keyed by question id.
  answers?: Record<string, Answer>;
  // Source handles that fired on this node.
  firedHandles?: string[];
  // Set when the node ran against a mock instead of a real provider.
  mock?: boolean;
  model?: string;
  usage?: NodeUsage;
  httpStatus?: number;
  approval?: ApprovalDetails;
  csv?: { rowCount: number; columnCount: number; headers: boolean };
  table?: { inputRows: number; matchedRows: number; outputRows: number };
  durationMs?: number;
  error?: string;
  startedAt: number;
};

/**
 * Stored run metadata. Values are strings so one Redis hash holds both the
 * metadata and the per-node traces; timestamps are ms as decimal strings.
 */
export type RunMetadata = {
  status: RunStatus;
  trigger: RunTrigger;
  // The text the run started with, truncated for display in the run list.
  input: string;
  // Optional short preview; the input message retains the complete question.
  question?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  // Published only after a durable approval checkpoint is acknowledged.
  approvalToken?: string;
  // Provider-reported usage so far. `cost` (USD) is set only when every AI
  // call in the run reported its own cost.
  inputTokens?: string;
  outputTokens?: string;
  cost?: string;
};

/** Live progress of one run, as streamed to the request that started it. */
export type RunEvent =
  | { type: "run"; metadata: RunMetadata }
  | { type: "node"; data: NodeResultData };

export type RunSummary = {
  runId: string;
  status: RunStatus;
  trigger: RunTrigger;
  input: string;
  question?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
};

export type RunTrace = RunSummary & {
  nodes: NodeResultData[];
  // Summed over nodes that reported usage; absent when no node did.
  usage?: UsageTotals;
  // Texts that reached each output input, with an empty array for unused inputs.
  output: WorkflowOutput;
};

export const MAX_INPUT_PREVIEW = 200;
export const MAX_NODE_EXECUTIONS = 25;
export const RUN_TIMEOUT_MS = 60_000;
