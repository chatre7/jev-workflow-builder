import "server-only";

import {
  ExecutionError,
  MAX_LLM_OUTPUT_CHARS,
  MAX_LLM_OUTPUT_TOKENS,
  MAX_NODE_PROMPT_CHARS,
  abortable,
  assertAllowedModel,
  checkAbort,
  checkLimit,
} from "./execution-policy";
import type { NodeUsage } from "../runs";

export type LlmRunOptions = {
  system: string;
  prompt: string;
  model: string;
  // Reserve the delta against the run budget before accumulating or publishing.
  reserveOutput: (delta: string) => void;
  onChunk: (text: string) => void | Promise<void>;
  signal: AbortSignal;
};

export type LlmResult = { text: string; mock: boolean; model: string; usage?: NodeUsage };

const MAX_USAGE_TOKENS = 1_000_000_000;
const MAX_USAGE_COST = 1_000_000;

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_USAGE_TOKENS
    ? value : undefined;
}

/**
 * Tokens come from the AI SDK's provider-neutral usage. Cost is taken only
 * from OpenRouter's own accounting, never computed from a price table.
 */
export function readLlmUsage(totalUsage: unknown, providerMetadata: unknown): NodeUsage | undefined {
  const usage: NodeUsage = {};
  if (totalUsage && typeof totalUsage === "object") {
    const { inputTokens, outputTokens } = totalUsage as Record<string, unknown>;
    if (tokenCount(inputTokens) !== undefined) usage.inputTokens = tokenCount(inputTokens);
    if (tokenCount(outputTokens) !== undefined) usage.outputTokens = tokenCount(outputTokens);
  }
  const openrouter = providerMetadata && typeof providerMetadata === "object"
    ? (providerMetadata as Record<string, unknown>).openrouter : undefined;
  const accounting = openrouter && typeof openrouter === "object"
    ? (openrouter as Record<string, unknown>).usage : undefined;
  const cost = accounting && typeof accounting === "object" ? (accounting as Record<string, unknown>).cost : undefined;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= MAX_USAGE_COST) {
    usage.cost = Math.round(cost * 1e8) / 1e8;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export async function runLlm(options: LlmRunOptions): Promise<LlmResult> {
  checkAbort(options.signal);
  assertAllowedModel(options.model);
  checkLimit(options.prompt.length + options.system.length, MAX_NODE_PROMPT_CHARS, "Node prompt");
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancel, { once: true });
  const signal = controller.signal;
  let iterator: AsyncIterator<string> | undefined;
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return await streamMockReply({ ...options, signal });
    }
    const [{ streamText }, { createOpenRouter }] = await abortable(
      Promise.all([import("ai"), import("@openrouter/ai-sdk-provider")]),
      signal
    );
    checkAbort(signal);
    const openrouter = createOpenRouter({ apiKey });
    let streamFailed = false;
    const result = streamText({
      // Usage accounting adds OpenRouter's token counts and cost to the final chunk.
      model: openrouter(options.model, { usage: { include: true } }),
      system: options.system || undefined,
      prompt: options.prompt,
      abortSignal: signal,
      maxOutputTokens: MAX_LLM_OUTPUT_TOKENS,
      maxRetries: 0,
      // Provider errors are handled below, never logged with request credentials.
      onError: () => { streamFailed = true; },
    });
    iterator = result.textStream[Symbol.asyncIterator]();
    let text = "";
    while (true) {
      const chunk = await abortable(iterator.next(), signal);
      checkAbort(signal);
      if (chunk.done) break;
      checkLimit(text.length + chunk.value.length, MAX_LLM_OUTPUT_CHARS, "LLM output");
      options.reserveOutput(chunk.value);
      text += chunk.value;
      await abortable(Promise.resolve(options.onChunk(text)), signal);
    }
    checkAbort(signal);
    if (streamFailed) throw new Error("LLM provider stream failed.");
    // Usage is informational: a missing or rejected usage promise never fails a reply.
    const [totalUsage, providerMetadata] = await abortable(
      Promise.all([result.totalUsage, result.providerMetadata]).catch(() => [undefined, undefined]),
      signal
    );
    checkAbort(signal);
    const usage = readLlmUsage(totalUsage, providerMetadata);
    return { text, mock: false, model: options.model, ...(usage ? { usage } : {}) };
  } catch (error) {
    checkAbort(signal);
    throw error instanceof ExecutionError
      ? error
      : new ExecutionError("LLM request failed. Check your OpenRouter API key, credits, and model availability.");
  } finally {
    controller.abort();
    options.signal.removeEventListener("abort", cancel);
    // An uncooperative iterator must not hold finalization or emit more chunks.
    if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
  }
}

/** Keyless, explicitly labelled local demonstration; cancellation is an error. */
async function streamMockReply(options: LlmRunOptions): Promise<LlmResult> {
  checkAbort(options.signal);
  const firstLine = options.prompt.match(/[^\r\n]*\S[^\r\n]*/)?.[0].trim() ?? "the request";
  const reply = [
    "Thanks for reaching out, and sorry for the trouble.",
    `Here is a mock reply for: "${firstLine.slice(0, 120)}".`,
    "Set OPENROUTER_API_KEY to stream a real model response through this node.",
  ].join(" ");
  let text = "";
  for (const word of reply.split(" ")) {
    checkAbort(options.signal);
    const delta = (text ? " " : "") + word;
    checkLimit(text.length + delta.length, MAX_LLM_OUTPUT_CHARS, "LLM output");
    options.reserveOutput(delta);
    text += delta;
    await abortable(Promise.resolve(options.onChunk(text)), options.signal);
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, 35);
    try {
      await abortable(promise, options.signal);
    } finally {
      clearTimeout(timer);
    }
  }
  checkAbort(options.signal);
  return { text, mock: true, model: "mock" };
}
