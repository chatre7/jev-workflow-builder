import "server-only";

import {
  LLM_FIELD_TYPES,
  MAX_LLM_FIELDS,
  MAX_LLM_FIELD_DESCRIPTION_CHARS,
  type LlmOutputField,
} from "../shared";
import { ExecutionError, MAX_IDENTIFIER_CHARS, checkLimit } from "./execution-policy";

const RESERVED_KEYS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };

/** Validates the saved field list of an LLM node in JSON mode. */
export function validateLlmOutputFields(value: unknown): asserts value is LlmOutputField[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LLM_FIELDS) {
    throw new ExecutionError(`LLM JSON output requires between 1 and ${MAX_LLM_FIELDS} fields.`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const field of value) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new ExecutionError("LLM output fields must be objects.");
    }
    const { id, name, type, description, required } = field as Record<string, unknown>;
    for (const text of [id, name]) {
      if (typeof text !== "string" || text.length > MAX_IDENTIFIER_CHARS || !/^[a-zA-Z0-9_-]+$/.test(text)
        || Object.hasOwn(RESERVED_KEYS, text)) {
        throw new ExecutionError("LLM output field names must use letters, numbers, underscores or hyphens, and must not be reserved keys.");
      }
    }
    if (ids.has(id as string) || names.has(name as string)) {
      throw new ExecutionError("LLM output field names and IDs must be unique.");
    }
    ids.add(id as string);
    names.add(name as string);
    if (!LLM_FIELD_TYPES.some((candidate) => candidate === type)) {
      throw new ExecutionError("LLM output fields support string, number, boolean or string[] types.");
    }
    if (typeof description !== "string") throw new ExecutionError("LLM output field descriptions must contain text.");
    checkLimit(description.length, MAX_LLM_FIELD_DESCRIPTION_CHARS, "LLM output field description");
    if (typeof required !== "boolean") throw new ExecutionError("LLM output fields require an explicit required flag.");
  }
}

/** A closed JSON Schema the provider can enforce; the same rules are checked again on the reply. */
export function buildOutputSchema(fields: readonly LlmOutputField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const property: Record<string, unknown> = field.type === "string[]"
      ? { type: "array", items: { type: "string" } }
      : { type: field.type };
    if (field.description.trim()) property.description = field.description.trim();
    properties[field.name] = property;
  }
  return {
    type: "object",
    properties,
    required: fields.filter((field) => field.required).map((field) => field.name),
    additionalProperties: false,
  };
}

function stripFence(text: string): string {
  // Some models wrap JSON in a Markdown fence even when a schema is requested.
  const match = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i.exec(text);
  return (match ? match[1] : text).trim();
}

function matchesType(value: unknown, type: LlmOutputField["type"]): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "string[]": return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}

/**
 * Checks the reply against the configured fields and returns canonical JSON
 * text: declared fields in declared order, unknown keys dropped. Downstream
 * Condition, Transform and Table nodes read it as `json.<field>`.
 */
export function parseStructuredOutput(text: string, fields: readonly LlmOutputField[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    throw new ExecutionError("The model did not return valid JSON. Try a model that supports structured output.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExecutionError("The model returned JSON that is not an object.");
  }
  const reply = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    if (!Object.hasOwn(reply, field.name) || reply[field.name] === null) {
      if (field.required) throw new ExecutionError(`The model's JSON is missing the required field '${field.name}'.`);
      continue;
    }
    if (!matchesType(reply[field.name], field.type)) {
      throw new ExecutionError(`The model's JSON field '${field.name}' is not a ${field.type}.`);
    }
    result[field.name] = reply[field.name];
  }
  return JSON.stringify(result);
}

/** Keyless demonstration reply with the configured shape, never real data. */
export function mockStructuredOutput(fields: readonly LlmOutputField[]): string {
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    result[field.name] = field.type === "string" ? `mock ${field.name}`
      : field.type === "number" ? 0
      : field.type === "boolean" ? false
      : [`mock ${field.name}`];
  }
  return JSON.stringify(result);
}
