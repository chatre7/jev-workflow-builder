import { MAX_NODE_EXECUTIONS, RUN_TIMEOUT_MS } from "../runs";
import { JEV_MODELS, LLM_MODELS, renderTemplate, type AnswerValue } from "../shared";

// Text limits count UTF-16 code units, including JSON escaping for trace limits.
export const MAX_GRAPH_NODES = MAX_NODE_EXECUTIONS + 1;
export const MAX_GRAPH_EDGES = 64;
export const MAX_NODE_FAN_IN = 8;
export const MAX_QUESTIONS = 8;
export const MAX_CRITERIA = 16;
export const MAX_OUTPUT_PROPERTIES = 8;
export const MAX_IDENTIFIER_CHARS = 96;
export const MAX_LABEL_CHARS = 160;
export const MAX_FIELD_CHARS = 4_000;
export const MAX_GRAPH_TEXT_CHARS = 64_000;
export const MAX_NODE_TEXT_CHARS = 32_000;
export const MAX_NODE_PROMPT_CHARS = 40_000;
export const MAX_RUN_INTERMEDIATE_CHARS = 256_000;
export const MAX_RUN_PROMPT_CHARS = 120_000;
export const MAX_NODE_TRACE_CHARS = 160_000;
export const MAX_RUN_TRACE_CHARS = 512_000;
export const TRACE_FINALIZATION_RESERVE_CHARS = 64_000;
export const MAX_RUN_FEED_CHARS = 2_000_000;
export const MAX_LLM_OUTPUT_CHARS = 16_384;
export const MAX_LLM_OUTPUT_TOKENS = 2_048;
export const MAX_RUN_LLM_OUTPUT_TOKENS = MAX_NODE_EXECUTIONS * MAX_LLM_OUTPUT_TOKENS;
export const MAX_PROVIDER_CONCURRENCY = 4;
export const STORAGE_TIMEOUT_MS = 5_000;
export const FEED_TIMEOUT_MS = 1_000;
export const FEED_FINALIZE_TIMEOUT_MS = 2_000;
export const STREAM_THROTTLE_MS = 250;

// Only messages deliberately constructed here may cross the server boundary.
export class ExecutionError extends Error {}

export function publicExecutionError(error: unknown): string {
  return error instanceof ExecutionError
    ? error.message
    : "Workflow execution failed. Check server configuration and provider availability.";
}

export function checkLimit(size: number, max: number, subject: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > max) {
    throw new ExecutionError(`${subject} exceeds the ${max.toLocaleString("en-US")} character limit.`);
  }
}

export function assertAllowedModel(model: string): void {
  if (!LLM_MODELS.some((entry) => entry.id === model)) {
    throw new ExecutionError("Select a supported LLM model from the editor's model menu.");
  }
}

export function assertAllowedJevModel(model: string): void {
  if (!JEV_MODELS.some((entry) => entry.id === model)) {
    throw new ExecutionError("Select a supported Jev model from the editor's model menu.");
  }
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof ExecutionError
      ? signal.reason
      : new ExecutionError("Workflow execution was cancelled.");
  }
}

// Racing is necessary even when a transport ignores cancellation. The underlying
// promise remains observed, while callers stop scheduling writes/provider work.
export function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const cancelled = () => {
    try { checkAbort(signal); } catch (error) { reject(error); }
  };
  signal.addEventListener("abort", cancelled, { once: true });
  Promise.resolve(operation).then(resolve, reject);
  void promise.then(
    () => signal.removeEventListener("abort", cancelled),
    () => signal.removeEventListener("abort", cancelled)
  );
  if (signal.aborted) cancelled();
  return promise;
}

export async function boundedOperation<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  parent?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const cancelled = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancelled, { once: true });
  if (parent?.aborted) cancelled();
  const timer = setTimeout(() => controller.abort(new ExecutionError("A storage or feed operation timed out.")), timeoutMs);
  try {
    checkAbort(controller.signal);
    return await abortable(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancelled);
    controller.abort();
  }
}

export function deadline(): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ExecutionError(`Run exceeded ${RUN_TIMEOUT_MS / 1000}s.`)), RUN_TIMEOUT_MS);
  return {
    signal: controller.signal,
    close: () => { clearTimeout(timer); controller.abort(); },
  };
}

// Compute serialized size without first allocating the serialized payload.
export function jsonSize(value: unknown, max: number, subject: string): number {
  let size = 0;
  const add = (amount: number) => { size += amount; checkLimit(size, max, subject); };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12) throw new ExecutionError("Workflow data is nested too deeply.");
    if (typeof item === "string") {
      add(item.length + 2);
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        if (code < 32) add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5);
        else if (code === 34 || code === 92) add(1);
        else if (code >= 0xd800 && code <= 0xdfff) {
          if (code <= 0xdbff && i + 1 < item.length && item.charCodeAt(i + 1) >= 0xdc00 && item.charCodeAt(i + 1) <= 0xdfff) i++;
          else add(5);
        }
      }
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new ExecutionError("Workflow data contains an invalid number.");
      add(String(item).length);
    } else if (typeof item === "boolean") add(item ? 4 : 5);
    else if (item === null) add(4);
    else if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (const child of item) visit(child, depth + 1);
    } else if (typeof item === "object") {
      add(2);
      let count = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key) || (item as Record<string, unknown>)[key] === undefined) continue;
        if (count++) add(1);
        visit(key, depth + 1);
        add(1);
        visit((item as Record<string, unknown>)[key], depth + 1);
      }
    } else if (item !== undefined) throw new ExecutionError("Workflow data cannot be serialized.");
  };
  visit(value, 0);
  return size;
}

export type RunBudgetState = {
  intermediate: number;
  prompts: number;
  feed: number;
};

export class RunBudget {
  private intermediate = 0;
  private prompts = 0;
  private feed = 0;

  constructor(state?: RunBudgetState) {
    if (state) {
      checkLimit(state.intermediate, MAX_RUN_INTERMEDIATE_CHARS, "Run intermediate text");
      checkLimit(state.prompts, MAX_RUN_PROMPT_CHARS, "Run prompts");
      checkLimit(state.feed, MAX_RUN_FEED_CHARS, "Run feed writes");
      this.intermediate = state.intermediate;
      this.prompts = state.prompts;
      this.feed = state.feed;
    }
  }

  snapshot(): RunBudgetState {
    return { intermediate: this.intermediate, prompts: this.prompts, feed: this.feed };
  }

  text(size: number): void {
    checkLimit(size, MAX_NODE_TEXT_CHARS, "Node text");
    checkLimit(this.intermediate + size, MAX_RUN_INTERMEDIATE_CHARS, "Run intermediate text");
    this.intermediate += size;
  }

  prompt(size: number): void {
    checkLimit(size, MAX_NODE_PROMPT_CHARS, "Node prompt");
    checkLimit(this.prompts + size, MAX_RUN_PROMPT_CHARS, "Run prompts");
    this.prompts += size;
  }

  feedWrite(size: number): void {
    // Keep space for one final copy of every failed message plus metadata.
    checkLimit(this.feed + size, MAX_RUN_FEED_CHARS - MAX_RUN_TRACE_CHARS - 4_096, "Run feed writes");
    this.feed += size;
  }
}

export function boundedJoin(texts: readonly string[], budget: RunBudget, reserveTrace?: (serializedSize: number) => void): string {
  let size = 0;
  let count = 0;
  let serializedSize = 2;
  for (const text of texts) {
    if (!text) continue;
    if (reserveTrace) serializedSize += jsonSize(text, MAX_NODE_TRACE_CHARS, "Node text") - 2 + (count ? 4 : 0);
    size += text.length + (count++ ? 2 : 0);
    checkLimit(size, MAX_NODE_TEXT_CHARS, "Node text");
  }
  budget.text(size);
  reserveTrace?.(serializedSize);
  return texts.filter((text) => text.length > 0).join("\n\n");
}

export function boundedTemplates(
  templates: readonly string[],
  context: { input: string; answers: Record<string, AnswerValue> },
  budget: RunBudget,
  literalChars = 0
): string[] {
  // Reserve literal suffixes before rendering or concatenating any prompt.
  let size = literalChars;
  checkLimit(size, MAX_NODE_PROMPT_CHARS, "Node prompt");
  for (const template of templates) {
    let cursor = 0;
    for (const match of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      size += match.index! - cursor;
      // The single-placeholder replacement is itself bounded by the context.
      size += renderTemplate(match[0], context).length;
      checkLimit(size, MAX_NODE_PROMPT_CHARS, "Node prompt");
      cursor = match.index! + match[0].length;
    }
    size += template.length - cursor;
    checkLimit(size, MAX_NODE_PROMPT_CHARS, "Node prompt");
  }
  budget.prompt(size);
  return templates.map((template) => renderTemplate(template, context).trim());
}
