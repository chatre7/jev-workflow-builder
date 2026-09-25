import type { Edge, Node } from "@xyflow/react";
import { nanoid } from "nanoid";

export const WORKFLOW_APP_ID = "jev-workflows";
export const ROOM_ID_PREFIX = "jev:workflows";
export const FLOW_STORAGE_KEY = "flow" as const;
// Edges use React Flow's built-in smoothstep renderer.
export const WORKFLOW_EDGE_TYPE = "smoothstep" as const;
export const INPUT_NODE_ID = "input";
export const OUTPUT_NODE_ID = "output";

// Most target handles use `in`; the output node has a handle per property.
export const IN_HANDLE = "in";
export const OUT_HANDLE = "out";
// Every Jev node has one "always" handle in addition to its answer handles.
export const ANY_HANDLE = "any";
export const TRUE_HANDLE = "true";
export const FALSE_HANDLE = "false";
export const APPROVED_HANDLE = "approved";
export const REJECTED_HANDLE = "rejected";
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const CONDITION_OPERATORS = [
  { id: "eq", label: "Equals" },
  { id: "ne", label: "Does not equal" },
  { id: "gt", label: "Greater than" },
  { id: "gte", label: "Greater than or equal" },
  { id: "lt", label: "Less than" },
  { id: "lte", label: "Less than or equal" },
  { id: "contains", label: "Contains (case-sensitive)" },
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]["id"];
export const MAX_TRANSFORM_FIELDS = 8;
export const MAX_DATA_SOURCE_CHARS = 256;
export const MAX_CSV_ROWS = 500;
export const MAX_CSV_COLUMNS = 64;
export const MAX_CSV_FIELD_CHARS = 8_000;
export const MAX_CSV_HEADER_CHARS = 128;
export const MAX_TABLE_ROWS = 500;
export const MAX_TABLE_COLUMNS = 64;
export const MAX_TABLE_FILTERS = 8;
export const MAX_TABLE_AGGREGATES = 8;
export const MAX_TABLE_DECIMAL_DIGITS = 100;
// Run text limits count UTF-16 code units.
export const MAX_INPUT_CHARS = 20_000;
export const MAX_QUESTION_CHARS = 4_000;

// Text models verified against https://openrouter.ai/api/v1/models.
export const LLM_MODEL_GROUPS = [
  {
    label: "Free",
    models: [
      { id: "qwen/qwen3.8-27b:free", label: "Qwen3.8 27B (free)" },
      { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free)" },
      { id: "liquid/lfm-2.5-2.6b:free", label: "LFM2.5 2.6B (free)" },
    ],
  },
  {
    label: "OpenAI",
    models: [
      { id: "openai/gpt-6-astra", label: "GPT-6 Astra" },
      { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { id: "openai/gpt-5.5", label: "GPT-5.5" },
      { id: "openai/gpt-5.4-mini", label: "GPT-5.4 mini" },
      { id: "openai/gpt-5.4-nano", label: "GPT-5.4 nano" },
    ],
  },
  {
    label: "Anthropic",
    models: [
      { id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1" },
      { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    label: "Google",
    models: [
      { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
      {
        id: "google/gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro (preview)",
      },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  {
    label: "DeepSeek",
    models: [
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
    ],
  },
  {
    label: "Moonshot AI",
    models: [
      { id: "moonshotai/kimi-k3", label: "Kimi K3" },
    ],
  },
];
export const LLM_MODELS = LLM_MODEL_GROUPS.flatMap((group) => group.models);
export const DEFAULT_LLM_MODEL = "liquid/lfm-2.5-2.6b:free";

// Structured decision models published at https://openrouter.ai/typesafe.
export const JEV_MODELS = [
  { id: "typesafe/jev-1.13", label: "Jev 1.13" },
  { id: "~typesafe/jev-latest", label: "Jev Latest (auto-updates)" },
];
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_NOUL_THRESHOLD = 0.7;

export type QuestionType = "choice" | "score" | "noul";

export type Criterion = {
  // Used as the handle id suffix and, for Choice, as the option label sent to
  // TypeSafe. Kept URL/handle-safe (see `slugify`).
  key: string;
  description: string;
};

export type ChoiceQuestionDef = {
  id: string;
  type: "choice";
  instructions: string;
  options: Criterion[];
};

export type ScoreQuestionDef = {
  id: string;
  type: "score";
  instructions: string;
  // Ordered from lowest (index 0) to highest.
  levels: Criterion[];
};

export type NoulQuestionDef = {
  id: string;
  type: "noul";
  instructions: string;
  // `yes` fires when the returned probability is >= threshold.
  threshold: number;
};

export type QuestionDef =
  | ChoiceQuestionDef
  | ScoreQuestionDef
  | NoulQuestionDef;

export type InputNodeData = {
  label: string;
  // Used by the "Run" button in the side panel as the default input.
  sample: string;
};

/**
 * How a node with several incoming edges decides to run:
 * - `any` (default, OR): at least one incoming handle fired.
 * - `all` (AND): every incoming handle fired. Connect two answer handles
 *   (e.g. `intent = billing` and `urgent = yes`) into one node and set it to
 *   `all` to express "if this AND that".
 */
export type ActivationMode = "any" | "all";

export type JevNodeData = {
  label: string;
  model: string;
  questions: QuestionDef[];
  activation?: ActivationMode;
};

export type LlmNodeData = {
  label: string;
  model: string;
  system: string;
  prompt: string;
  activation?: ActivationMode;
};

export type ConditionNodeData = {
  label: string;
  source: string;
  operator: ConditionOperator;
  value: string;
  activation?: ActivationMode;
};

export type TransformField = {
  id: string;
  name: string;
  source: string;
};

export type TransformNodeData = {
  label: string;
  fields: TransformField[];
  activation?: ActivationMode;
};

export type HttpNodeData = {
  label: string;
  connection: string;
  method: "GET" | "POST";
  path: string;
  body: string;
  activation?: ActivationMode;
};

export type ApprovalNodeData = {
  label: string;
  prompt: string;
  activation?: ActivationMode;
};

export type KnowledgeNodeData = {
  label: string;
  query: string;
  topK: number;
  activation?: ActivationMode;
};

export type CsvNodeData = {
  label: string;
  delimiter: "," | ";" | "\t";
  headers: boolean;
  activation?: ActivationMode;
};

export type TableFilter = {
  id: string;
  column: string;
  operator: ConditionOperator;
  value: string;
};

export type TableAggregate = {
  id: string;
  operation: "sum" | "count";
  column: string;
  name: string;
};

export type TableNodeData = {
  label: string;
  filters: TableFilter[];
  // A literal column name; empty means one aggregate over all matching rows.
  groupBy: string;
  // Empty means return matching rows without aggregation.
  aggregates: TableAggregate[];
  activation?: ActivationMode;
};

/**
 * Unique sink, like the input node. Collects parent texts into named output
 * properties, according to the connected target handle.
 * Use Transform with parents.<node-id> to keep incoming texts in separate fields.
 */
export type OutputNodeData = {
  label: string;
  activation?: ActivationMode;
  properties?: OutputProperty[];
};

export type OutputProperty = {
  // Stable handle id: renaming a property keeps its connections intact.
  id: string;
  name: string;
};

const DEFAULT_OUTPUT_PROPERTIES: OutputProperty[] = [
  { id: "customer", name: "customer" },
  { id: "team", name: "team" },
];

export function getOutputProperties(data: OutputNodeData): OutputProperty[] {
  return data.properties ?? DEFAULT_OUTPUT_PROPERTIES;
}

export function getOutputPropertyId(
  handleId: string | null | undefined
): string {
  // The original single input becomes the default Customer property.
  return !handleId || handleId === IN_HANDLE ? "customer" : handleId;
}

export function createOutputProperty(
  properties: readonly OutputProperty[]
): OutputProperty {
  const names = new Set(properties.map((property) => property.name));
  let index = properties.length + 1;
  while (names.has(`property_${index}`)) index++;
  return { id: `property-${nanoid(8)}`, name: `property_${index}` };
}

export function getActivation(data: {
  activation?: ActivationMode;
}): ActivationMode {
  return data.activation ?? "any";
}

export type InputNode = Node<InputNodeData, "input">;
export type JevNode = Node<JevNodeData, "jev">;
export type LlmNode = Node<LlmNodeData, "llm">;
export type ConditionNode = Node<ConditionNodeData, "condition">;
export type TransformNode = Node<TransformNodeData, "transform">;
export type HttpNode = Node<HttpNodeData, "http">;
export type ApprovalNode = Node<ApprovalNodeData, "approval">;
export type KnowledgeNode = Node<KnowledgeNodeData, "knowledge">;
export type CsvNode = Node<CsvNodeData, "csv">;
export type TableNode = Node<TableNodeData, "table">;
export type OutputNode = Node<OutputNodeData, "output">;
export type WorkflowNode =
  | InputNode
  | JevNode
  | LlmNode
  | ConditionNode
  | TransformNode
  | HttpNode
  | ApprovalNode
  | KnowledgeNode
  | CsvNode
  | TableNode
  | OutputNode;
export type WorkflowNodeType = WorkflowNode["type"];

export type WorkflowEdgeData = Record<string, never>;
export type WorkflowEdge = Edge<WorkflowEdgeData, typeof WORKFLOW_EDGE_TYPE>;

export type Point = { x: number; y: number };

/* -------------------------------------------------------------------------- */
/*                                   Handles                                  */
/* -------------------------------------------------------------------------- */

export type HandleDef = {
  id: string;
  // Short label rendered next to the handle.
  label: string;
  // Longer description shown as a tooltip.
  title: string;
  questionId?: string;
};

export function questionHandleId(questionId: string, key: string) {
  return `q:${questionId}:${key}`;
}

export function getQuestionHandles(question: QuestionDef): HandleDef[] {
  switch (question.type) {
    case "choice":
      return question.options.map((option) => ({
        id: questionHandleId(question.id, option.key),
        label: option.key,
        title: `${question.id} = ${option.key}`,
        questionId: question.id,
      }));
    case "score":
      return question.levels.map((level, index) => ({
        id: questionHandleId(question.id, String(index)),
        label: level.key || `level ${index}`,
        title: `${question.id} rounds to level ${index}${level.key ? ` (${level.key})` : ""}`,
        questionId: question.id,
      }));
    case "noul":
      return [
        {
          id: questionHandleId(question.id, "yes"),
          label: "yes",
          title: `${question.id} ≥ ${question.threshold}`,
          questionId: question.id,
        },
        {
          id: questionHandleId(question.id, "no"),
          label: "no",
          title: `${question.id} < ${question.threshold}`,
          questionId: question.id,
        },
      ];
  }
}

export function getSourceHandles(node: WorkflowNode): HandleDef[] {
  switch (node.type) {
    case "input":
    case "llm":
    case "transform":
    case "http":
    case "knowledge":
    case "csv":
    case "table":
      return [{ id: OUT_HANDLE, label: "output", title: "Output text" }];
    case "jev":
      return [
        ...node.data.questions.flatMap(getQuestionHandles),
        {
          id: ANY_HANDLE,
          label: "always",
          title: "Fires on every run that reaches this node",
        },
      ];
    case "condition":
      return [
        { id: TRUE_HANDLE, label: "true", title: "The condition matched" },
        { id: FALSE_HANDLE, label: "false", title: "The condition did not match" },
      ];
    case "approval":
      return [
        { id: APPROVED_HANDLE, label: "approved", title: "The owner approved this item" },
        { id: REJECTED_HANDLE, label: "rejected", title: "The owner rejected this item" },
      ];
    case "output":
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Factories                                 */
/* -------------------------------------------------------------------------- */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

export function createQuestion(type: QuestionType, index: number): QuestionDef {
  const id = `question_${index}`;

  switch (type) {
    case "choice":
      return {
        id,
        type,
        instructions: "",
        options: [
          { key: "option_a", description: "" },
          { key: "option_b", description: "" },
        ],
      };
    case "score":
      return {
        id,
        type,
        instructions: "",
        levels: [
          { key: "low", description: "" },
          { key: "medium", description: "" },
          { key: "high", description: "" },
        ],
      };
    case "noul":
      return { id, type, instructions: "", threshold: DEFAULT_NOUL_THRESHOLD };
  }
}

export function createInputNode(args: {
  position: Point;
  sample?: string;
  selected?: boolean;
}): InputNode {
  return {
    id: INPUT_NODE_ID,
    type: "input",
    position: args.position,
    selected: args.selected,
    deletable: false,
    data: { label: "Input", sample: args.sample ?? "" },
  };
}

export function createJevNode(args: {
  id?: string;
  position: Point;
  label?: string;
  model?: string;
  questions?: QuestionDef[];
  activation?: ActivationMode;
  selected?: boolean;
}): JevNode {
  return {
    id: args.id ?? `jev-${nanoid(8)}`,
    type: "jev",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "Jev",
      model: args.model ?? DEFAULT_JEV_MODEL,
      questions: args.questions ?? [createQuestion("choice", 1)],
      activation: args.activation ?? "any",
    },
  };
}

export function createOutputNode(args: {
  position: Point;
  label?: string;
  activation?: ActivationMode;
  selected?: boolean;
  properties?: OutputProperty[];
}): OutputNode {
  return {
    id: OUTPUT_NODE_ID,
    type: "output",
    position: args.position,
    deletable: false,
    selected: args.selected,
    data: {
      label: args.label ?? "Output",
      activation: args.activation ?? "any",
      properties:
        args.properties ??
        DEFAULT_OUTPUT_PROPERTIES.map((property) => ({ ...property })),
    },
  };
}

export function createLlmNode(args: {
  id?: string;
  position: Point;
  label?: string;
  model?: string;
  system?: string;
  prompt?: string;
  activation?: ActivationMode;
  selected?: boolean;
}): LlmNode {
  return {
    id: args.id ?? `llm-${nanoid(8)}`,
    type: "llm",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "LLM",
      model: args.model ?? DEFAULT_LLM_MODEL,
      system: args.system ?? "",
      prompt: args.prompt ?? "{{input}}",
      activation: args.activation ?? "any",
    },
  };
}

export function createConditionNode(args: {
  id?: string;
  position: Point;
  label?: string;
  source?: string;
  operator?: ConditionOperator;
  value?: string;
  activation?: ActivationMode;
  selected?: boolean;
}): ConditionNode {
  return {
    id: args.id ?? `condition-${nanoid(8)}`,
    type: "condition",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "Condition",
      source: args.source ?? "input",
      operator: args.operator ?? "eq",
      value: args.value ?? "",
      activation: args.activation ?? "any",
    },
  };
}

export function createTransformField(index: number): TransformField {
  return { id: `field-${nanoid(6)}`, name: `field_${index}`, source: "input" };
}

export function createTransformNode(args: {
  id?: string;
  position: Point;
  label?: string;
  fields?: TransformField[];
  activation?: ActivationMode;
  selected?: boolean;
}): TransformNode {
  return {
    id: args.id ?? `transform-${nanoid(8)}`,
    type: "transform",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "Transform",
      fields: args.fields ?? [createTransformField(1)],
      activation: args.activation ?? "any",
    },
  };
}

export function createHttpNode(args: {
  id?: string;
  position: Point;
  label?: string;
  connection?: string;
  method?: "GET" | "POST";
  path?: string;
  body?: string;
  activation?: ActivationMode;
  selected?: boolean;
}): HttpNode {
  return {
    id: args.id ?? `http-${nanoid(8)}`,
    type: "http",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "HTTP Request",
      connection: args.connection ?? "",
      method: args.method ?? "GET",
      path: args.path ?? "",
      body: args.body ?? "",
      activation: args.activation ?? "any",
    },
  };
}

export function createApprovalNode(args: {
  id?: string;
  position: Point;
  label?: string;
  prompt?: string;
  activation?: ActivationMode;
  selected?: boolean;
}): ApprovalNode {
  return {
    id: args.id ?? `approval-${nanoid(8)}`,
    type: "approval",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "Human Approval",
      prompt: args.prompt ?? "Review this item before continuing.",
      activation: args.activation ?? "any",
    },
  };
}

export function createKnowledgeNode(args: {
  id?: string;
  position: Point;
  label?: string;
  query?: string;
  topK?: number;
  activation?: ActivationMode;
  selected?: boolean;
}): KnowledgeNode {
  return {
    id: args.id ?? `knowledge-${nanoid(8)}`,
    type: "knowledge",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "Knowledge Search",
      query: args.query ?? "{{input}}",
      topK: args.topK ?? 3,
      activation: args.activation ?? "any",
    },
  };
}

export function createCsvNode(args: {
  id?: string;
  position: Point;
  label?: string;
  delimiter?: CsvNodeData["delimiter"];
  headers?: boolean;
  activation?: ActivationMode;
  selected?: boolean;
}): CsvNode {
  return {
    id: args.id ?? `csv-${nanoid(8)}`,
    type: "csv",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "CSV → JSON",
      delimiter: args.delimiter ?? ",",
      headers: args.headers ?? true,
      activation: args.activation ?? "any",
    },
  };
}

export function createTableFilter(): TableFilter {
  return { id: `filter-${nanoid(6)}`, column: "", operator: "eq", value: "" };
}

export function createTableAggregate(
  index: number,
  operation: TableAggregate["operation"] = "sum"
): TableAggregate {
  return { id: `aggregate-${nanoid(6)}`, operation, column: "", name: `${operation}_${index}` };
}

export function createTableNode(args: {
  id?: string;
  position: Point;
  label?: string;
  filters?: TableFilter[];
  groupBy?: string;
  aggregates?: TableAggregate[];
  activation?: ActivationMode;
  selected?: boolean;
}): TableNode {
  return {
    id: args.id ?? `table-${nanoid(8)}`,
    type: "table",
    position: args.position,
    selected: args.selected,
    data: {
      label: args.label ?? "Table",
      filters: args.filters ?? [],
      groupBy: args.groupBy ?? "",
      aggregates: args.aggregates ?? [createTableAggregate(1, "count")],
      activation: args.activation ?? "any",
    },
  };
}

export function createWorkflowEdge(args: {
  id?: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle?: string;
}): WorkflowEdge {
  return {
    id:
      args.id ??
      `e-${args.source}-${args.sourceHandle}-${args.target}-${nanoid(6)}`,
    type: WORKFLOW_EDGE_TYPE,
    source: args.source,
    sourceHandle: args.sourceHandle,
    target: args.target,
    targetHandle: args.targetHandle ?? IN_HANDLE,
    data: {},
  };
}

/* -------------------------------------------------------------------------- */
/*                                Graph helpers                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns true if adding an edge from `source` to `target` would create a
 * cycle (i.e. `source` is reachable from `target`).
 */
export function wouldCreateCycle(
  edges: readonly WorkflowEdge[],
  source: string,
  target: string
): boolean {
  if (source === target) {
    return true;
  }

  const visited = new Set<string>();
  const stack = [target];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current === source) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    for (const edge of edges) {
      if (edge.source === current) {
        stack.push(edge.target);
      }
    }
  }

  return false;
}

/**
 * Ids of nodes reachable from the input node. Anything else never runs.
 */
export function getReachableNodeIds(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[]
): Set<string> {
  const reachable = new Set<string>();

  if (!nodes.some((node) => node.id === INPUT_NODE_ID)) {
    return reachable;
  }

  const stack = [INPUT_NODE_ID];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (reachable.has(current)) {
      continue;
    }

    reachable.add(current);

    for (const edge of edges) {
      if (edge.source === current) {
        stack.push(edge.target);
      }
    }
  }

  return reachable;
}

/**
 * Kahn's algorithm. Returns `null` if the graph contains a cycle.
 */
export function topologicalOrder(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[]
): WorkflowNode[] | null {
  const indegree = new Map<string, number>();
  const byId = new Map<string, WorkflowNode>();

  for (const node of nodes) {
    indegree.set(node.id, 0);
    byId.set(node.id, node);
  }

  for (const edge of edges) {
    if (indegree.has(edge.target) && byId.has(edge.source)) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
  }

  const queue = nodes.filter((node) => indegree.get(node.id) === 0);
  const order: WorkflowNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);

    for (const edge of edges) {
      if (edge.source !== node.id) {
        continue;
      }

      const next = indegree.get(edge.target);

      if (next === undefined) {
        continue;
      }

      indegree.set(edge.target, next - 1);

      if (next - 1 === 0) {
        const target = byId.get(edge.target);

        if (target) {
          queue.push(target);
        }
      }
    }
  }

  return order.length === nodes.length ? order : null;
}

/* -------------------------------------------------------------------------- */
/*                                 Templating                                 */
/* -------------------------------------------------------------------------- */

export type AnswerValue = {
  // Human-readable value: the chosen option, the level key, or "yes"/"no".
  value: string;
  probability: number;
  confidence: number;
};

/**
 * Resolves `{{input}}`, `{{answers.<id>}}`, `{{answers.<id>.probability}}` and
 * `{{answers.<id>.confidence}}`. Unknown placeholders resolve to "".
 */
export function renderTemplate(
  template: string,
  context: { input: string; answers: Record<string, AnswerValue> }
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    if (path === "input") {
      return context.input;
    }

    const [root, id, field] = path.split(".");

    if (root !== "answers" || !id) {
      return "";
    }

    // Own keys only: `answers.constructor` must not reach Object.prototype.
    const answer = Object.hasOwn(context.answers, id) ? context.answers[id] : undefined;

    if (!answer) {
      return "";
    }

    if (field === "probability") {
      return answer.probability.toFixed(2);
    }

    if (field === "confidence") {
      return answer.confidence.toFixed(2);
    }

    return field === undefined ? answer.value : "";
  });
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
