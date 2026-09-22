import {
  INPUT_NODE_ID,
  OUTPUT_NODE_ID,
  IN_HANDLE,
  MAX_TRANSFORM_FIELDS,
  getOutputProperties,
  getOutputPropertyId,
  getSourceHandles,
  topologicalOrder,
  type QuestionDef,
  type WorkflowEdge,
  type WorkflowNode,
} from "../shared";
import {
  ExecutionError,
  MAX_CRITERIA,
  MAX_FIELD_CHARS,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  MAX_GRAPH_TEXT_CHARS,
  MAX_IDENTIFIER_CHARS,
  MAX_INPUT_CHARS,
  MAX_LABEL_CHARS,
  MAX_NODE_FAN_IN,
  MAX_OUTPUT_PROPERTIES,
  MAX_QUESTIONS,
  assertAllowedJevModel,
  assertAllowedModel,
  checkLimit,
  jsonSize,
} from "./execution-policy";
import { validateConditionOperands, validateDataSource } from "./data-nodes";

export const MAX_GRAPH_STORAGE_CHARS = 512_000;
const RESERVED_KEYS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("Workflow contains an invalid object. Recreate the affected node or connection.");
  }
}

function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string") throw new ExecutionError("Workflow fields must contain text.");
  checkLimit(value.length, max, "Workflow field");
}

function identifier(value: unknown): asserts value is string {
  text(value, MAX_IDENTIFIER_CHARS);
  if (!/^[a-zA-Z0-9_-]+$/.test(value) || Object.hasOwn(RESERVED_KEYS, value)) {
    throw new ExecutionError("Workflow identifiers must use letters, numbers, underscores or hyphens, and must not be reserved keys.");
  }
}

export function validateQuestions(value: unknown): asserts value is QuestionDef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) {
    throw new ExecutionError(`Each Jev node must contain between 1 and ${MAX_QUESTIONS} questions.`);
  }
  const ids = new Set<string>();
  for (const question of value) {
    record(question);
    identifier(question.id);
    if (question.id === "input" || ids.has(question.id)) {
      throw new ExecutionError("Question IDs must be unique within a node and must not be 'input'.");
    }
    ids.add(question.id);
    text(question.instructions, MAX_FIELD_CHARS);
    if (question.type === "noul") {
      if (typeof question.threshold !== "number" || !Number.isFinite(question.threshold) || question.threshold < 0 || question.threshold > 1) {
        throw new ExecutionError("Jev probability thresholds must be between zero and one.");
      }
    } else if (question.type === "choice" || question.type === "score") {
      const criteria = question.type === "choice" ? question.options : question.levels;
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > MAX_CRITERIA) {
        throw new ExecutionError(`Choice and score questions require between 2 and ${MAX_CRITERIA} criteria.`);
      }
      const keys = new Set<string>();
      for (const criterion of criteria) {
        record(criterion);
        identifier(criterion.key);
        text(criterion.description, MAX_FIELD_CHARS);
        if (keys.has(criterion.key)) throw new ExecutionError("Question criterion keys must be unique.");
        keys.add(criterion.key);
      }
    } else {
      throw new ExecutionError("Workflow contains an unsupported question type.");
    }
  }
}

export function validateWorkflowGraph(value: unknown): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  record(value);
  const { nodes, edges } = value;
  if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > MAX_GRAPH_NODES) {
    throw new ExecutionError(`Workflow must contain input and output nodes, with at most ${MAX_GRAPH_NODES} nodes total.`);
  }
  if (!Array.isArray(edges) || edges.length > MAX_GRAPH_EDGES) {
    throw new ExecutionError(`Workflow must contain at most ${MAX_GRAPH_EDGES} connections.`);
  }
  jsonSize(value, MAX_GRAPH_STORAGE_CHARS, "Stored graph");
  const byId = new Map<string, WorkflowNode>();
  let inputs = 0;
  let outputs = 0;
  let fieldSize = 0;
  for (const node of nodes) {
    record(node);
    identifier(node.id);
    if (byId.has(node.id)) throw new ExecutionError("Workflow node IDs must be unique.");
    record(node.data);
    text(node.data.label, MAX_LABEL_CHARS);
    if (node.data.activation !== undefined && node.data.activation !== "any" && node.data.activation !== "all") {
      throw new ExecutionError("Node activation must be 'any' or 'all'.");
    }
    switch (node.type) {
      case "input":
        inputs++;
        if (node.id !== INPUT_NODE_ID) throw new ExecutionError("Workflow input must use the input node ID.");
        text(node.data.sample, MAX_INPUT_CHARS);
        break;
      case "output": {
        outputs++;
        if (node.id !== OUTPUT_NODE_ID) throw new ExecutionError("Workflow output must use the output node ID.");
        const properties = node.data.properties;
        if (properties !== undefined) {
          if (!Array.isArray(properties) || properties.length < 1 || properties.length > MAX_OUTPUT_PROPERTIES) {
            throw new ExecutionError(`Output requires between 1 and ${MAX_OUTPUT_PROPERTIES} properties.`);
          }
          const ids = new Set<string>();
          const names = new Set<string>();
          for (const property of properties) {
            record(property);
            identifier(property.id);
            text(property.name, MAX_IDENTIFIER_CHARS);
            if (!property.name.trim() || Object.hasOwn(RESERVED_KEYS, property.name) || ids.has(property.id) || names.has(property.name)) {
              throw new ExecutionError("Output property names and IDs must be nonempty, unique, and not reserved keys.");
            }
            ids.add(property.id);
            names.add(property.name);
          }
        }
        break;
      }
      case "jev":
        text(node.data.model, MAX_IDENTIFIER_CHARS);
        assertAllowedJevModel(node.data.model);
        validateQuestions(node.data.questions);
        break;
      case "llm":
        text(node.data.model, MAX_IDENTIFIER_CHARS);
        assertAllowedModel(node.data.model);
        text(node.data.prompt, MAX_FIELD_CHARS);
        text(node.data.system, MAX_FIELD_CHARS);
        break;
      case "condition":
        validateDataSource(node.data.source);
        validateConditionOperands(node.data.operator, node.data.value);
        break;
      case "transform": {
        const fields = node.data.fields;
        if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_TRANSFORM_FIELDS) {
          throw new ExecutionError(`Transform requires between 1 and ${MAX_TRANSFORM_FIELDS} fields.`);
        }
        const ids = new Set<string>();
        const names = new Set<string>();
        for (const field of fields) {
          record(field);
          identifier(field.id);
          identifier(field.name);
          if (ids.has(field.id) || names.has(field.name)) {
            throw new ExecutionError("Transform field names and IDs must be unique.");
          }
          ids.add(field.id);
          names.add(field.name);
          validateDataSource(field.source);
        }
        break;
      }
      default:
        throw new ExecutionError("Workflow contains an unsupported node type.");
    }
    // Includes criteria, labels, IDs, and serialized field overhead, not layout.
    fieldSize += jsonSize(node.data, MAX_GRAPH_TEXT_CHARS, "Graph fields");
    checkLimit(fieldSize, MAX_GRAPH_TEXT_CHARS, "Graph fields");
    byId.set(node.id, node as unknown as WorkflowNode);
  }
  if (inputs !== 1 || outputs !== 1) throw new ExecutionError("Workflow requires exactly one input and one output node.");
  const ids = new Set<string>();
  const connections = new Set<string>();
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    record(edge);
    text(edge.id, 384);
    if (!edge.id || ids.has(edge.id)) throw new ExecutionError("Connection IDs must be nonempty and unique.");
    ids.add(edge.id);
    identifier(edge.source);
    identifier(edge.target);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source.id === target.id || source.type === "output" || target.type === "input") {
      throw new ExecutionError("Connections must link existing nodes from input toward output.");
    }
    text(edge.sourceHandle, MAX_IDENTIFIER_CHARS * 2 + 4);
    if (!getSourceHandles(source).some((handle) => handle.id === edge.sourceHandle)) {
      throw new ExecutionError("A connection references a source handle that no longer exists.");
    }
    if (edge.targetHandle !== undefined && edge.targetHandle !== null) text(edge.targetHandle, MAX_IDENTIFIER_CHARS);
    if (target.type === "output") {
      const propertyId = getOutputPropertyId(edge.targetHandle as string | null | undefined);
      if (!getOutputProperties(target.data).some((property) => property.id === propertyId)) {
        throw new ExecutionError("A connection references an output property that no longer exists.");
      }
    } else if (edge.targetHandle !== IN_HANDLE) {
      throw new ExecutionError("A connection must target the node's input handle.");
    }
    const key = JSON.stringify([edge.source, edge.sourceHandle, edge.target, edge.targetHandle ?? null]);
    if (connections.has(key)) throw new ExecutionError("Duplicate connections are not allowed.");
    connections.add(key);
    const count = (incoming.get(edge.target) ?? 0) + 1;
    if (count > MAX_NODE_FAN_IN) throw new ExecutionError(`A node may have at most ${MAX_NODE_FAN_IN} incoming connections.`);
    incoming.set(edge.target, count);
  }
  const graph = { nodes: nodes as WorkflowNode[], edges: edges as WorkflowEdge[] };
  for (const node of graph.nodes) {
    const sources = node.type === "condition" ? [node.data.source]
      : node.type === "transform" ? node.data.fields.map((field) => field.source) : [];
    for (const source of sources) {
      if (source.startsWith("parents.") && !graph.edges.some((edge) => edge.target === node.id && edge.source === source.slice(8))) {
        throw new ExecutionError("Parent data sources must reference an immediate incoming node.");
      }
    }
  }
  if (topologicalOrder(graph.nodes, graph.edges) === null) throw new ExecutionError("The workflow contains a cycle.");
  return graph;
}
