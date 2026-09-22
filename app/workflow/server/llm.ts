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

export type LlmRunOptions = {
  system: string;
  prompt: string;
  model: string;
  // Reserve the delta against the run budget before accumulating or publishing.
  reserveOutput: (delta: string) => void;
  onChunk: (text: string) => void | Promise<void>;
  signal: AbortSignal;
};

export type LlmResult = { text: string; mock: boolean; model: string };

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
      model: openrouter(options.model),
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
    return { text, mock: false, model: options.model };
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
