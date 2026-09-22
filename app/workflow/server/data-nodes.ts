import {
  CONDITION_OPERATORS,
  MAX_DATA_SOURCE_CHARS,
  type AnswerValue,
  type ConditionNodeData,
  type TransformNodeData,
} from "../shared";
import { ExecutionError, MAX_FIELD_CHARS, MAX_NODE_TEXT_CHARS, checkLimit, jsonSize } from "./execution-policy";

export type DataNodeContext = {
  input: string;
  answers: Record<string, AnswerValue>;
  parents: Record<string, string>;
};

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const RESERVED_SEGMENTS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };

export function validateDataSource(source: unknown): string[] {
  if (typeof source !== "string" || source.length > MAX_DATA_SOURCE_CHARS) {
    throw new ExecutionError(`Data sources must be text of at most ${MAX_DATA_SOURCE_CHARS} characters.`);
  }
  const segments = source.split(".");
  if (segments.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part) || Object.hasOwn(RESERVED_SEGMENTS, part))) {
    throw new ExecutionError("Data source paths must use safe letters, numbers, underscores or hyphens.");
  }
  const [root, , field] = segments;
  if ((root === "input" && segments.length === 1)
    || root === "json"
    || (root === "parents" && segments.length === 2)
    || (root === "answers" && segments.length === 3 && (field === "value" || field === "confidence" || field === "probability"))) return segments;
  throw new ExecutionError("Data sources must use input, json, json.<path>, answers.<question-id>.<field> or parents.<node-id>.");
}

function sourceReader(context: DataNodeContext): (source: string) => unknown {
  let parsed = false;
  let json: unknown;
  return (source) => {
    const [root, ...path] = validateDataSource(source);
    if (root === "input") return context.input;
    if (root === "parents") {
      if (!Object.hasOwn(context.parents, path[0])) {
        throw new ExecutionError(`Data source '${source}' requires a parent that fired for this node.`);
      }
      return context.parents[path[0]];
    }
    if (root === "answers") {
      const answer = Object.hasOwn(context.answers, path[0]) ? context.answers[path[0]] : undefined;
      if (!answer || !Object.hasOwn(answer, path[1]) || answer[path[1] as keyof AnswerValue] === undefined) {
        throw new ExecutionError(`Data source '${source}' is unavailable.`);
      }
      return answer[path[1] as keyof AnswerValue];
    }
    if (!parsed) {
      checkLimit(context.input.length, MAX_NODE_TEXT_CHARS, "Node text");
      try {
        json = JSON.parse(context.input);
      } catch {
        throw new ExecutionError("A json data source requires valid JSON input.");
      }
      parsed = true;
    }
    let value = json;
    for (const segment of path) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)
        || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(segment))) {
        throw new ExecutionError(`Data source '${source}' does not exist in the JSON input.`);
      }
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  };
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && DECIMAL.test(value)) {
    const result = Number(value);
    if (Number.isFinite(result)) return result;
  }
  throw new ExecutionError("Numeric conditions require finite decimal numbers, without blanks or whitespace.");
}

export function validateConditionOperands(operator: unknown, value: unknown): void {
  if (!CONDITION_OPERATORS.some(({ id }) => id === operator)) {
    throw new ExecutionError("Condition contains an unsupported operator.");
  }
  if (typeof value !== "string") throw new ExecutionError("Condition comparison values must contain text.");
  checkLimit(value.length, MAX_FIELD_CHARS, "Condition comparison value");
  if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") numeric(value);
}

export function evaluateCondition(data: ConditionNodeData, context: DataNodeContext): boolean {
  const value = sourceReader(context)(data.source);
  switch (data.operator) {
    case "eq":
    case "ne": {
      let equal: boolean;
      if (typeof value === "string") equal = value === data.value;
      else if (typeof value === "number") equal = numeric(value) === numeric(data.value);
      else if (typeof value === "boolean") {
        if (data.value !== "true" && data.value !== "false") throw new ExecutionError("Boolean conditions require true or false.");
        equal = value === (data.value === "true");
      } else if (value === null) {
        if (data.value !== "null") throw new ExecutionError("Null conditions require the literal null.");
        equal = true;
      } else throw new ExecutionError("Equality conditions require a string, number, boolean or null, not an object or array.");
      return data.operator === "eq" ? equal : !equal;
    }
    case "contains":
      if (typeof value !== "string") throw new ExecutionError("Contains conditions require a string source.");
      return value.includes(data.value);
    case "gt": return numeric(value) > numeric(data.value);
    case "gte": return numeric(value) >= numeric(data.value);
    case "lt": return numeric(value) < numeric(data.value);
    case "lte": return numeric(value) <= numeric(data.value);
    default: throw new ExecutionError("Condition contains an unsupported operator.");
  }
}

// jsonSize has already bounded the mapped JSON and its depth. Count only the
// extra escaping when that JSON becomes a string inside the persisted trace.
function traceEscapes(value: unknown): number {
  if (typeof value === "string") {
    let count = 2;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92) count += 2;
      else if (code < 32) count++;
      else if (code >= 0xd800 && code <= 0xdfff) {
        if (code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) i++;
        else count++;
      }
    }
    return count;
  }
  let count = 0;
  if (Array.isArray(value)) {
    for (const child of value) count += traceEscapes(child);
  } else if (value !== null && typeof value === "object") {
    for (const key in value) {
      if (Object.hasOwn(value, key)) count += traceEscapes(key) + traceEscapes((value as Record<string, unknown>)[key]);
    }
  }
  return count;
}

export function transformData(
  data: TransformNodeData,
  context: DataNodeContext,
  reserveOutput?: (textSize: number, serializedSize: number) => void
): string {
  const readSource = sourceReader(context);
  const mapped: Record<string, unknown> = Object.create(null);
  for (const field of data.fields) mapped[field.name] = readSource(field.source);
  const size = jsonSize(mapped, MAX_NODE_TEXT_CHARS, "Transform output");
  reserveOutput?.(size, size + 2 + traceEscapes(mapped));
  return JSON.stringify(mapped);
}
