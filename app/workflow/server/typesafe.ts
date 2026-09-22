import "server-only";

import type { Answer } from "../runs";
import type { JevNodeData, QuestionDef } from "../shared";
import {
  ExecutionError,
  MAX_IDENTIFIER_CHARS,
  MAX_NODE_PROMPT_CHARS,
  abortable,
  assertAllowedJevModel,
  checkAbort,
  jsonSize,
} from "./execution-policy";
import { validateQuestions } from "./execution-validation";
import { RUN_TIMEOUT_MS } from "../runs";

export const MAX_JEV_RESPONSE_BYTES = 128_000;

export type JevState = {
  input: string;
  // Upstream answers, keyed by question id, so later questions can reference
  // them in their instructions (e.g. "given `intent`…").
  [key: string]: string | number;
};

export type JevResult = {
  answers: Record<string, Answer>;
  model: string;
  mock: boolean;
};

type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

type JevResponse = { model?: unknown; answers?: unknown };

/** Converts validated editor questions without dropping invalid/empty entries. */
export function toTypeSafeQuestions(questions: QuestionDef[]): Record<string, JevQuestion> {
  validateQuestions(questions);
  const result: Record<string, JevQuestion> = {};

  for (const question of questions) {
    const instructions = question.instructions.trim();

    switch (question.type) {
      case "choice": {
        const options = question.options;

        const choice: JevQuestion = {
          type: "choice",
          instructions,
          criteria: Object.fromEntries(
            options.map((option) => [
              option.key,
              option.description.trim() || null,
            ])
          ),
        };
        result[question.id] = choice;
        break;
      }
      case "score": {
        const criteria = question.levels.map(
          (level) => level.description.trim() || level.key
        );
        const score: JevQuestion = { type: "score", instructions, criteria };
        result[question.id] = score;
        break;
      }
      case "noul": {
        const noul: JevQuestion = { type: "noul", instructions };
        result[question.id] = noul;
        break;
      }
    }
  }

  return result;
}

export async function askJev(
  data: JevNodeData,
  state: JevState,
  signal: AbortSignal
): Promise<JevResult> {
  checkAbort(signal);
  assertAllowedJevModel(data.model);
  const questions = toTypeSafeQuestions(data.questions);
  const payload = { model: data.model, state, questions };
  jsonSize(payload, MAX_NODE_PROMPT_CHARS, "Jev request");
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const result = mockJev(data.questions, state);
    checkAbort(signal);
    return result;
  }
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
    const httpResponse = await abortable(fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: requestSignal,
      redirect: "error",
    }), requestSignal);
    if (!httpResponse.ok) {
      void httpResponse.body?.cancel().catch(() => {});
      throw new Error("OpenRouter rejected the Jev request.");
    }
    if (!httpResponse.body) throw new ExecutionError("Jev returned an invalid response.");
    const reader = httpResponse.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let response: JevResponse;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), requestSignal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_JEV_RESPONSE_BYTES) {
          throw new ExecutionError("Jev returned an oversized response.");
        }
        chunks.push(chunk.value);
      }
      response = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } finally {
      void reader.cancel().catch(() => {});
    }
    checkAbort(signal);
    if (!response || typeof response !== "object" || Array.isArray(response) ||
      !response.answers || typeof response.answers !== "object" || Array.isArray(response.answers) ||
      typeof response.model !== "string" || response.model.length > MAX_IDENTIFIER_CHARS) {
      throw new ExecutionError("Jev returned an invalid response.");
    }
    const responseAnswers = response.answers as Record<string, Partial<Answer> | undefined>;
    const answers: Record<string, Answer> = {};
    for (const question of data.questions) {
      const answer = responseAnswers[question.id];
      if (!answer || typeof answer !== "object" || Array.isArray(answer) || answer.type !== question.type) {
        throw new ExecutionError("Jev did not return a valid answer for every question.");
      }
      if (question.type === "noul" && answer.type === "noul") {
        probability(answer.noul);
        answers[question.id] = { type: "noul", noul: answer.noul, threshold: question.threshold };
      } else if (question.type === "choice" && answer.type === "choice") {
        if (typeof answer.choice !== "string" || !question.options.some((option) => option.key === answer.choice)) {
          throw new ExecutionError("Jev returned a choice outside the configured criteria.");
        }
        probability(answer.confidence);
        answers[question.id] = {
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: readProbabilities(answer.probabilities, question.options.map((option) => option.key)),
        };
      } else if (question.type === "score" && answer.type === "score") {
        if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.levels.length - 1) {
          throw new ExecutionError("Jev returned a score outside the configured criteria.");
        }
        probability(answer.confidence);
        answers[question.id] = {
          type: "score",
          score: answer.score,
          level: Math.round(answer.score),
          confidence: answer.confidence,
          probabilities: readProbabilities(answer.probabilities, question.levels.map((_, index) => String(index))),
        };
      }
    }
    return { answers, model: response.model, mock: false };
  } catch (error) {
    checkAbort(signal);
    throw error instanceof ExecutionError
      ? error
      : new ExecutionError("Jev request failed. Check your OpenRouter API key, credits, and model availability.");
  }
}

function probability(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ExecutionError("Jev returned an invalid probability.");
  }
}

function readProbabilities(value: unknown, keys: string[]): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("Jev returned invalid probabilities.");
  }
  const probabilities: Record<string, number> = {};
  for (const key of keys) {
    const number = (value as Record<string, unknown>)[key];
    probability(number);
    probabilities[key] = number;
  }
  return probabilities;
}

/* -------------------------------------------------------------------------- */
/*                                    Mock                                    */
/* -------------------------------------------------------------------------- */

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "is",
  "in",
  "for",
  "on",
  "this",
  "that",
  "with",
  "it",
  "as",
  "be",
  "are",
  "was",
  "by",
  "at",
  "from",
  "not",
  "customer",
]);

// Crude stemming so "charged"/"charges" and "refund"/"refunds" line up.
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "");
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
      .map(stem)
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;

  for (const word of a) {
    if (b.has(word)) {
      count++;
    }
  }

  return count;
}

function softmax(scores: number[], temperature = 0.8): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((score) => Math.exp((score - max) / temperature));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

function confidenceFrom(probabilities: number[]): number {
  const sorted = [...probabilities].sort((a, b) => b - a);
  return Math.max(0, Math.min(1, (sorted[0] ?? 0) - (sorted[1] ?? 0)));
}

/**
 * Keyless fallback: picks answers by keyword overlap between the input and
 * each criterion's key/description. Deterministic, clearly labeled as mock.
 */
function mockJev(questions: QuestionDef[], state: JevState): JevResult {
  const inputWords = tokenize(
    Object.values(state)
      .filter((value): value is string => typeof value === "string")
      .join(" ")
  );
  const answers: Record<string, Answer> = {};

  for (const question of questions) {
    switch (question.type) {
      case "choice": {
        const options = question.options;

        const scores = options.map((option, index) => {
          const words = tokenize(
            `${option.key.replace(/_/g, " ")} ${option.description}`
          );
          // Slightly favor earlier options so ties are stable, and penalize
          // catch-all options like "other".
          const penalty = /other|none|else/.test(option.key) ? 1 : 0;
          return overlap(inputWords, words) * 2 - penalty - index * 0.05;
        });
        const probabilities = softmax(scores);
        const winner = probabilities.indexOf(Math.max(...probabilities));

        answers[question.id] = {
          type: "choice",
          choice: options[winner].key,
          confidence: confidenceFrom(probabilities),
          probabilities: Object.fromEntries(
            options.map((option, index) => [option.key, probabilities[index]])
          ),
        };
        break;
      }
      case "score": {
        const scores = question.levels.map((level) => {
          const words = tokenize(`${level.key} ${level.description}`);
          return overlap(inputWords, words) * 2;
        });
        // Nudge towards the middle when nothing matches, like a cautious rater.
        const middle = (question.levels.length - 1) / 2;
        const adjusted = scores.map(
          (score, index) => score - Math.abs(index - middle) * 0.5
        );
        const probabilities = softmax(adjusted);
        const expected = probabilities.reduce(
          (total, probability, index) => total + probability * index,
          0
        );

        answers[question.id] = {
          type: "score",
          score: expected,
          level: Math.round(expected),
          confidence: confidenceFrom(probabilities),
          probabilities: Object.fromEntries(
            probabilities.map((probability, index) => [
              String(index),
              probability,
            ])
          ),
        };
        break;
      }
      case "noul": {
        const words = tokenize(question.instructions);
        const matches = overlap(inputWords, words);
        // Exclamation marks and words like "again"/"today" read as urgency.
        const intensity = (
          state.input.match(/!|again|today|asap|urgent/gi) ?? []
        ).length;
        const noul = Math.min(0.98, 0.2 + matches * 0.15 + intensity * 0.18);

        answers[question.id] = {
          type: "noul",
          noul,
          threshold: question.threshold,
        };
        break;
      }
    }
  }

  return { answers, model: "mock", mock: true };
}
