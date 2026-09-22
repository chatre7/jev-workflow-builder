import "server-only";

import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import type { Liveblocks as LiveblocksClient } from "@liveblocks/node";
import {
  MAX_INPUT_PREVIEW,
  MAX_NODE_EXECUTIONS,
  RUN_TIMEOUT_MS,
  createEmptyOutput,
  getRunOutput,
  type Answer,
  type NodeResultData,
  type RunTrace,
  type RunTrigger,
} from "../runs";
import {
  ANY_HANDLE,
  APPROVAL_TTL_MS,
  APPROVED_HANDLE,
  REJECTED_HANDLE,
  FALSE_HANDLE,
  OUT_HANDLE,
  TRUE_HANDLE,
  MAX_CSV_ROWS,
  MAX_CSV_COLUMNS,
  MAX_INPUT_CHARS,
  MAX_QUESTION_CHARS,
  getActivation,
  getOutputProperties,
  getOutputPropertyId,
  getReachableNodeIds,
  questionHandleId,
  topologicalOrder,
  truncate,
  type AnswerValue,
  type OutputProperty,
  type QuestionDef,
  type WorkflowNode,
} from "../shared";
import {
  ExecutionError,
  FEED_FINALIZE_TIMEOUT_MS,
  FEED_TIMEOUT_MS,
  MAX_NODE_PROMPT_CHARS,
  MAX_NODE_TRACE_CHARS,
  MAX_PROVIDER_CONCURRENCY,
  MAX_RUN_TRACE_CHARS,
  STORAGE_TIMEOUT_MS,
  STREAM_THROTTLE_MS,
  TRACE_FINALIZATION_RESERVE_CHARS,
  RunBudget,
  abortable,
  boundedJoin,
  boundedOperation,
  boundedTemplates,
  checkAbort,
  checkLimit,
  deadline,
  jsonSize,
  publicExecutionError,
} from "./execution-policy";
import { validateWorkflowGraph, type ValidatedWorkflowGraph } from "./execution-validation";
import { evaluateCondition, transformData, type DataNodeContext } from "./data-nodes";
import { getLiveblocks, readWorkflowGraph } from "./liveblocks";
import { runLlm } from "./llm";
import { askJev, toTypeSafeQuestions, type JevState } from "./typesafe";
import { runHttpRequest } from "./http";
import { searchKnowledge } from "./knowledge";
import { convertCsv } from "./csv";
import {
  finishApprovalRun,
  saveApprovalCheckpoint,
  type ApprovalCheckpoint,
  type ClaimedApproval,
  type PendingApproval,
  type SavedNodeState,
} from "./approvals";

type NodeState = {
  output: string;
  answers: Record<string, AnswerValue>;
  firedHandles: Set<string>;
};

// Unlike an inactive branch (null), blocked ancestry must be reconsidered later.
const BLOCKED = Symbol("unresolved approval");
type NodeOutcome = NodeState | null | typeof BLOCKED;
const RUN_QUESTION_PREFIX = "\n\nQuestion for this run (answer this question using the data above):\n";

function restoreState(state: SavedNodeState): NodeState {
  return { ...state, firedHandles: new Set(state.firedHandles) };
}

function saveState(state: NodeState): SavedNodeState {
  return { ...state, firedHandles: [...state.firedHandles] };
}

export type RunWorkflowOptions = {
  roomId: string;
  input: string;
  question?: string;
  trigger: RunTrigger;
  // Authorized, validated snapshot used by question-bearing API requests.
  graph?: ValidatedWorkflowGraph;
};

export function startWorkflowRun(options: RunWorkflowOptions): {
  runId: string;
  trace$: Promise<RunTrace>;
} {
  const runId = `run-${nanoid(10)}`;
  return { runId, trace$: runWorkflow(runId, options) };
}

/** Only a server-owned, atomically claimed checkpoint may enter this path. */
export function resumeWorkflowRun(claim: ClaimedApproval): { runId: string; trace$: Promise<RunTrace> } {
  const { checkpoint } = claim;
  return {
    runId: checkpoint.runId,
    trace$: runWorkflow(checkpoint.runId, {
      roomId: checkpoint.roomId, input: checkpoint.input, question: checkpoint.question, trigger: checkpoint.trigger,
    }, claim),
  };
}

async function runWorkflow(runId: string, options: RunWorkflowOptions, claim?: ClaimedApproval): Promise<RunTrace> {
  const { roomId, input, trigger } = options;
  const saved = claim?.checkpoint;
  const startedAt = saved?.startedAt ?? Date.now();
  const phaseToken = claim?.token ?? randomUUID();
  const runDeadline = deadline();
  const signal = runDeadline.signal;
  let budget = new RunBudget();
  const messages = new Map<string, NodeResultData>();
  const messageSizes = new Map<string, number>();
  const messageIds = new Map<string, string>();
  const results = new Map<string, Promise<NodeOutcome>>();
  const settled = new Map<string, NodeState | null>();
  const pending = new Map<string, PendingApproval>();
  const providerTasks = new Set<Promise<unknown>>();
  let liveblocks: LiveblocksClient | undefined;
  let outputProperties: OutputProperty[] = [];
  let executions = saved?.executions ?? 0;
  let waiting = false;
  let approvalStorageTouched = !!claim;
  let closed = false;
  let error: string | undefined;
  let question: string | undefined;
  // Reserve metadata, the returned input, and terminal error overhead up front.
  let traceSize = TRACE_FINALIZATION_RESERVE_CHARS;
  let outputSize = 0;
  const metadata: Liveblocks["FeedMetadata"] = {
    status: "running",
    trigger,
    input: typeof input === "string" ? truncate(input, MAX_INPUT_PREVIEW) : "",
    startedAt: String(startedAt),
  };

  function active(): void {
    if (closed) throw new ExecutionError("Workflow execution has finished.");
    checkAbort(signal);
  }

  async function feed<T>(operation: (requestSignal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    active();
    try {
      return await boundedOperation(operation, FEED_TIMEOUT_MS, signal);
    } catch {
      checkAbort(signal);
      // The trace remains available even if the feed service is unavailable.
      return undefined;
    }
  }

  async function writeMessage(data: NodeResultData): Promise<void> {
    active();
    const size = jsonSize(data, MAX_NODE_TRACE_CHARS, "Node trace");
    const nextOutputSize = data.nodeType === "output" && data.outputs
      ? jsonSize(data.outputs, MAX_NODE_TRACE_CHARS, "Run output")
      : outputSize;
    const nextTraceSize = traceSize - (messageSizes.get(data.nodeId) ?? 0) + size - outputSize + nextOutputSize;
    checkLimit(nextTraceSize, MAX_RUN_TRACE_CHARS, "Run trace");
    budget.feedWrite(size);
    traceSize = nextTraceSize;
    outputSize = nextOutputSize;
    messageSizes.set(data.nodeId, size);
    messages.set(data.nodeId, data);
    const messageId = messageIds.get(data.nodeId);
    if (messageId) {
      await feed((requestSignal) => liveblocks!.updateFeedMessage(
        { roomId, feedId: runId, messageId, data }, { signal: requestSignal }
      ));
    } else {
      // A deterministic ID avoids duplicate messages after an ambiguous timeout.
      const id = `${runId}-${data.nodeId}`;
      messageIds.set(data.nodeId, id);
      await feed((requestSignal) => liveblocks!.createFeedMessage(
        { roomId, feedId: runId, id, data }, { signal: requestSignal }
      ));
    }
    active();
  }

  async function provider<T>(operation: () => Promise<T>): Promise<T> {
    active();
    while (providerTasks.size >= MAX_PROVIDER_CONCURRENCY) {
      await abortable(Promise.race(providerTasks), signal);
      active();
    }
    const task = abortable(operation(), signal);
    providerTasks.add(task);
    try {
      return await task;
    } finally {
      providerTasks.delete(task);
    }
  }

  try {
    if (typeof input !== "string") throw new ExecutionError("Run input must be text.");
    checkLimit(input.length, MAX_INPUT_CHARS, "Run input");
    if (options.question !== undefined) {
      if (typeof options.question !== "string") throw new ExecutionError("Run question must be text.");
      checkLimit(options.question.length, MAX_QUESTION_CHARS, "Run question");
      question = options.question.trim() ? options.question : undefined;
    }
    if (question) metadata.question = truncate(question, MAX_INPUT_PREVIEW);
    if (saved) {
      budget = new RunBudget(saved.budget);
      checkLimit(executions, MAX_NODE_EXECUTIONS, "Node executions");
      if (saved.version !== 1 || saved.roomId !== roomId || saved.runId !== runId ||
          !Number.isSafeInteger(startedAt) || !Array.isArray(saved.states) ||
          !Array.isArray(saved.messages) || !Array.isArray(saved.pending)) {
        throw new ExecutionError("Approval checkpoint is invalid.");
      }
      for (const { nodeId, state } of saved.states) settled.set(nodeId, state && restoreState(state));
      for (const item of saved.pending) pending.set(item.nodeId, item);
      for (const message of saved.messages) {
        const size = jsonSize(message, MAX_NODE_TRACE_CHARS, "Node trace");
        traceSize += size;
        messageSizes.set(message.nodeId, size);
        messages.set(message.nodeId, message);
        messageIds.set(message.nodeId, `${runId}-${message.nodeId}`);
        if (message.nodeType === "output" && message.outputs) outputSize = jsonSize(message.outputs, MAX_NODE_TRACE_CHARS, "Run output");
      }
      traceSize += outputSize;
    }
    traceSize += jsonSize(input, MAX_RUN_TRACE_CHARS, "Run input");
    if (question) traceSize += jsonSize(question, MAX_RUN_TRACE_CHARS, "Run question");
    checkLimit(traceSize, MAX_RUN_TRACE_CHARS, "Run trace");
    liveblocks = getLiveblocks();
    if (saved) {
      await feed((requestSignal) => liveblocks!.updateFeed(
        { roomId, feedId: runId, metadata }, { signal: requestSignal }
      ));
    } else {
      await feed((requestSignal) => liveblocks!.createFeed(
        { roomId, feedId: runId, metadata }, { signal: requestSignal }
      ));
    }
    const snapshot = saved?.graph ?? options.graph ?? await boundedOperation(
      (requestSignal) => readWorkflowGraph(roomId, requestSignal), STORAGE_TIMEOUT_MS, signal
    );
    active();
    const { nodes, edges } = validateWorkflowGraph(snapshot);
    if (claim) {
      const item = pending.get(claim.nodeId);
      const previous = messages.get(claim.nodeId);
      if (!item || !previous?.approval || previous.status !== "waiting" ||
          !nodes.some((node) => node.id === claim.nodeId && node.type === "approval")) {
        throw new ExecutionError("Approval checkpoint is invalid.");
      }
      if ([...pending.values()].some((entry) => entry.expiresAt <= claim.decidedAt)) {
        throw new ExecutionError("An approval expired. Start a new run.");
      }
      const handle = claim.decision === "approved" ? APPROVED_HANDLE : REJECTED_HANDLE;
      const state = { ...restoreState(item.state), firedHandles: new Set([handle]) };
      await writeMessage({
        ...previous, status: "complete", output: state.output, firedHandles: [handle],
        approval: { ...previous.approval, decision: claim.decision, decidedAt: claim.decidedAt, decidedBy: claim.decidedBy },
      });
      settled.set(claim.nodeId, state);
      pending.delete(claim.nodeId);
    }
    const outputNode = nodes.find((node) => node.type === "output");
    if (!outputNode || outputNode.type !== "output") throw new ExecutionError("Workflow output is missing.");
    outputProperties = getOutputProperties(outputNode.data);
    const reachable = getReachableNodeIds(nodes, edges);
    const activeNodes = nodes.filter((node) => reachable.has(node.id));
    if (question && !activeNodes.some((node) => node.type === "llm")) {
      throw new ExecutionError("A run question requires an LLM node reachable from Input.");
    }
    const activeEdges = edges.filter((edge) => reachable.has(edge.source) && reachable.has(edge.target));
    const order = topologicalOrder(activeNodes, activeEdges)!;

    async function executeNode(node: WorkflowNode): Promise<NodeOutcome> {
      const nodeStartedAt = Date.now();
      let base: NodeResultData | undefined;
      try {
        if (settled.has(node.id)) return settled.get(node.id)!;
        if (pending.has(node.id)) return BLOCKED;
        active();
        if (node.type === "input") {
          budget.text(input.length);
          await writeMessage({
            nodeId: node.id, nodeType: "input", label: node.data.label,
            status: "complete", parentNodeIds: [], input, output: input,
            ...(question ? { question } : {}),
            firedHandles: [OUT_HANDLE], durationMs: 0, startedAt: nodeStartedAt,
          });
          return { output: input, answers: {}, firedHandles: new Set([OUT_HANDLE]) };
        }
        const incoming = activeEdges.filter((edge) => edge.target === node.id);
        const parents = await abortable(Promise.all(incoming.map(async (edge) => ({
          edge, state: await results.get(edge.source),
        }))), signal);
        active();
        // Wait for every possible parent, even for OR activation. A blocked path
        // may later contribute input, so caching a partial join would lose data.
        if (parents.some(({ state }) => state === BLOCKED)) return BLOCKED;
        const fired = parents.filter((parent): parent is typeof parent & { state: NodeState } =>
          typeof parent.state !== "symbol" && !!parent.state?.firedHandles.has(parent.edge.sourceHandle!));
        const requireAll = getActivation(node.data) === "all";
        if (fired.length === 0 || (requireAll && fired.length < incoming.length)) return null;
        if (++executions > MAX_NODE_EXECUTIONS) {
          throw new ExecutionError(`Run exceeded ${MAX_NODE_EXECUTIONS} node executions.`);
        }
        const parentNodeIds = [...new Set(fired.map(({ edge }) => edge.source))];
        const parentTexts = parentNodeIds.map((id) => fired.find(({ edge }) => edge.source === id)!.state!.output);
        base = {
          nodeId: node.id, nodeType: node.type, label: node.data.label,
          status: "running", parentNodeIds, activation: requireAll ? "all" : "any",
          input: "", startedAt: nodeStartedAt,
        };
        const passthrough = node.type === "jev" || node.type === "condition" || node.type === "approval";
        const joinBaseSize = jsonSize({ ...base, ...(passthrough ? { output: "" } : {}) }, MAX_NODE_TRACE_CHARS, "Node trace");
        // Reserve both the input and pass-through output before a join or call.
        const nodeInput = boundedJoin(parentTexts, budget, (serializedSize) => {
          const size = joinBaseSize + (serializedSize - 2) * (passthrough ? 2 : 1);
          checkLimit(size, MAX_NODE_TRACE_CHARS, "Node trace");
          checkLimit(traceSize + size, MAX_RUN_TRACE_CHARS, "Run trace");
        });
        base.input = nodeInput;
        const answers: Record<string, AnswerValue> = {};
        for (const { state } of fired) Object.assign(answers, state!.answers);
        await writeMessage(base);
        active();
        if (node.type === "approval") {
          const [prompt] = boundedTemplates([node.data.prompt], { input: nodeInput, answers }, budget);
          const expiresAt = Date.now() + APPROVAL_TTL_MS;
          await writeMessage({
            ...base, status: "waiting", output: nodeInput,
            approval: { prompt, expiresAt }, durationMs: Date.now() - nodeStartedAt,
          });
          pending.set(node.id, { nodeId: node.id, expiresAt, state: {
            output: nodeInput, answers, firedHandles: [],
          } });
          return BLOCKED;
        }
        if (node.type === "csv") {
          // Reserve space for bounded conversion metadata before serializing output.
          const outputBaseSize = jsonSize({
            ...base, status: "complete", output: "", firedHandles: [OUT_HANDLE],
            csv: { rowCount: MAX_CSV_ROWS, columnCount: MAX_CSV_COLUMNS, headers: false },
            durationMs: RUN_TIMEOUT_MS,
          }, MAX_NODE_TRACE_CHARS, "Node trace");
          const result = convertCsv(node.data, nodeInput, (textSize, serializedSize) => {
            active();
            budget.text(textSize);
            const size = outputBaseSize + serializedSize - 2;
            checkLimit(size, MAX_NODE_TRACE_CHARS, "Node trace");
            checkLimit(traceSize - (messageSizes.get(node.id) ?? 0) + size, MAX_RUN_TRACE_CHARS, "Run trace");
          });
          await writeMessage({
            ...base, status: "complete", output: result.text, firedHandles: [OUT_HANDLE],
            csv: { rowCount: result.rowCount, columnCount: result.columnCount, headers: node.data.headers },
            durationMs: Date.now() - nodeStartedAt,
          });
          return { output: result.text, answers, firedHandles: new Set([OUT_HANDLE]) };
        }
        if (node.type === "http" || node.type === "knowledge") {
          let output: string;
          let httpStatus: number | undefined;
          if (node.type === "http") {
            const [path, body] = boundedTemplates([node.data.path, node.data.body], { input: nodeInput, answers }, budget);
            const result = await provider(() => runHttpRequest({
              connection: node.data.connection, method: node.data.method, path, body, signal,
            }));
            output = result.text;
            httpStatus = result.status;
          } else {
            const [query] = boundedTemplates([node.data.query], { input: nodeInput, answers }, budget);
            output = await provider(() => searchKnowledge({ query, topK: node.data.topK, signal }));
          }
          active();
          budget.text(output.length);
          await writeMessage({
            ...base, status: "complete", output, firedHandles: [OUT_HANDLE],
            ...(httpStatus === undefined ? {} : { httpStatus }),
            durationMs: Date.now() - nodeStartedAt,
          });
          return { output, answers, firedHandles: new Set([OUT_HANDLE]) };
        }
        if (node.type === "jev") {
          const state: JevState = { input: nodeInput };
          for (const [id, answer] of Object.entries(answers)) state[id] = answer.value;
          const requestSize = jsonSize({ model: node.data.model, state, questions: toTypeSafeQuestions(node.data.questions) }, MAX_NODE_PROMPT_CHARS, "Jev request");
          budget.prompt(requestSize);
          const result = await provider(() => askJev(node.data, state, signal));
          active();
          const firedHandles = new Set([ANY_HANDLE]);
          for (const question of node.data.questions) {
            const resolved = resolveAnswer(question, result.answers[question.id]);
            firedHandles.add(questionHandleId(question.id, resolved.handleKey));
            answers[question.id] = resolved.value;
          }
          await writeMessage({
            ...base, status: "complete", output: nodeInput, answers: result.answers,
            firedHandles: [...firedHandles], mock: result.mock, model: result.model,
            durationMs: Date.now() - nodeStartedAt,
          });
          return { output: nodeInput, answers, firedHandles };
        }
        if (node.type === "llm") {
          const [resolvedPrompt, system] = boundedTemplates(
            [node.data.prompt, node.data.system], { input: nodeInput, answers }, budget,
            question ? RUN_QUESTION_PREFIX.length + question.length : 0
          );
          // Only saved node templates expand; run questions always remain literal.
          const prompt = question ? resolvedPrompt + RUN_QUESTION_PREFIX + question : resolvedPrompt;
          if (!prompt) {
            await writeMessage({ ...base, status: "skipped", output: nodeInput, firedHandles: [OUT_HANDLE], durationMs: Date.now() - nodeStartedAt });
            return { output: nodeInput, answers, firedHandles: new Set([OUT_HANDLE]) };
          }
          let lastWrite = Date.now();
          const streamBaseSize = jsonSize({ ...base, output: "", model: node.data.model }, MAX_NODE_TRACE_CHARS, "Node trace");
          let streamOutputSize = 0;
          const result = await provider(() => runLlm({
            prompt, system, model: node.data.model, signal,
            reserveOutput: (delta) => {
              active();
              budget.text(delta.length);
              streamOutputSize += jsonSize(delta, MAX_NODE_TRACE_CHARS, "LLM output") - 2;
              const messageSize = streamBaseSize + streamOutputSize;
              checkLimit(messageSize, MAX_NODE_TRACE_CHARS, "Node trace");
              checkLimit(traceSize - (messageSizes.get(node.id) ?? 0) + messageSize, MAX_RUN_TRACE_CHARS, "Run trace");
            },
            onChunk: async (text) => {
              active();
              if (Date.now() - lastWrite < STREAM_THROTTLE_MS) return;
              lastWrite = Date.now();
              // Backpressure: at most one write per node, no unbounded promise queue.
              await writeMessage({ ...base!, status: "running", output: text, model: node.data.model });
            },
          }));
          active();
          await writeMessage({
            ...base, status: "complete", output: result.text, firedHandles: [OUT_HANDLE],
            mock: result.mock, model: result.model, durationMs: Date.now() - nodeStartedAt,
          });
          return { output: result.text, answers, firedHandles: new Set([OUT_HANDLE]) };
        }
        if (node.type === "condition" || node.type === "transform") {
          const parentOutputs: Record<string, string> = Object.create(null);
          for (let i = 0; i < parentNodeIds.length; i++) parentOutputs[parentNodeIds[i]] = parentTexts[i];
          const context: DataNodeContext = { input: nodeInput, answers, parents: parentOutputs };
          let output: string;
          let handle: string;
          if (node.type === "condition") {
            handle = evaluateCondition(node.data, context) ? TRUE_HANDLE : FALSE_HANDLE;
            output = nodeInput;
          } else {
            handle = OUT_HANDLE;
            const outputBaseSize = jsonSize({
              ...base, status: "complete", output: "", firedHandles: [handle],
              durationMs: Date.now() - nodeStartedAt,
            }, MAX_NODE_TRACE_CHARS, "Node trace");
            output = transformData(node.data, context, (textSize, serializedSize) => {
              active();
              budget.text(textSize);
              const size = outputBaseSize + serializedSize - 2;
              checkLimit(size, MAX_NODE_TRACE_CHARS, "Node trace");
              checkLimit(traceSize - (messageSizes.get(node.id) ?? 0) + size, MAX_RUN_TRACE_CHARS, "Run trace");
            });
          }
          active();
          await writeMessage({
            ...base, status: "complete", output, firedHandles: [handle],
            durationMs: Date.now() - nodeStartedAt,
          });
          return { output, answers, firedHandles: new Set([handle]) };
        }
        const properties = getOutputProperties(node.data);
        const outputs = createEmptyOutput(properties);
        const seen = new Map<string, Set<string>>();
        for (const { edge, state } of fired) {
          const property = properties.find(({ id }) => id === getOutputPropertyId(edge.targetHandle))!;
          if (!state?.output) continue;
          const sources = seen.get(property.id) ?? new Set<string>();
          if (sources.has(edge.source)) continue;
          sources.add(edge.source);
          seen.set(property.id, sources);
          outputs[property.name].push(state.output);
        }
        const outputBaseSize = jsonSize({ ...base, status: "complete", output: "", outputs, firedHandles: [] }, MAX_NODE_TRACE_CHARS, "Node trace");
        const outputsSize = jsonSize(outputs, MAX_NODE_TRACE_CHARS, "Run output");
        const joined = boundedJoin(Object.values(outputs).flat(), budget, (serializedSize) => {
          const size = outputBaseSize + serializedSize - 2;
          checkLimit(size, MAX_NODE_TRACE_CHARS, "Node trace");
          checkLimit(traceSize - (messageSizes.get(node.id) ?? 0) + size + outputsSize, MAX_RUN_TRACE_CHARS, "Run trace");
        });
        await writeMessage({
          ...base, status: "complete", output: joined, outputs, firedHandles: [],
          durationMs: Date.now() - nodeStartedAt,
        });
        return { output: joined, answers, firedHandles: new Set() };
      } catch (failure) {
        if (!closed) {
          // Keep a bounded, actionable error even when the proposed full message
          // failed its trace budget before being inserted into the map.
          const previous = messages.get(node.id);
          const failed: NodeResultData = {
            ...(previous ?? {
              nodeId: node.id, nodeType: node.type, label: node.data.label,
              parentNodeIds: [], input: "", startedAt: nodeStartedAt,
            }),
            status: "error", error: publicExecutionError(failure),
            durationMs: Date.now() - nodeStartedAt,
          };
          messages.set(node.id, failed);
        }
        throw failure;
      }
    }

    for (const node of order) {
      const task = executeNode(node).then((state) => {
        if (state !== BLOCKED) settled.set(node.id, state);
        return state;
      });
      // Observe immediately: a parent may fail before the aggregate is installed.
      void task.catch(() => {});
      results.set(node.id, task);
    }
    await abortable(Promise.all(results.values()), signal);
    active();
    if (pending.size > 0) {
      const checkpoint: ApprovalCheckpoint = {
        version: 1, roomId, runId, input, trigger, startedAt, graph: { nodes, edges },
        ...(question ? { question } : {}),
        states: [...settled].map(([nodeId, state]) => ({ nodeId, state: state && saveState(state) })),
        pending: [...pending.values()], messages: [...messages.values()],
        budget: budget.snapshot(), executions,
      };
      approvalStorageTouched = true;
      await boundedOperation(() => saveApprovalCheckpoint(checkpoint, phaseToken, !saved), STORAGE_TIMEOUT_MS, signal);
      active();
      waiting = true;
    }
  } catch (failure) {
    error = publicExecutionError(failure);
  } finally {
    // Seal local state before aborting, so a late provider/snapshot cannot publish.
    closed = true;
    runDeadline.close();
    await Promise.allSettled(results.values());
  }

  if (approvalStorageTouched && (!waiting || error)) {
    try {
      await boundedOperation(() => finishApprovalRun(roomId, runId, phaseToken, error ? "error" : "complete"), STORAGE_TIMEOUT_MS);
    } catch (failure) {
      error ??= publicExecutionError(failure);
    }
  }
  const completedAt = Date.now();
  if (error) {
    for (const [id, message] of messages) {
      if (message.status === "running" || message.status === "waiting") messages.set(id, {
        ...message, status: "error", error, durationMs: completedAt - message.startedAt,
      });
    }
  }
  const finalMetadata: Liveblocks["FeedMetadata"] = {
    ...metadata, status: error ? "error" : waiting ? "waiting" : "complete",
    ...(!waiting || error ? { completedAt: String(completedAt) } : {}),
    // The phase token is published only after a confirmed checkpoint save.
    // A timed-out SAVE cannot become claimable even if terminal cleanup fails.
    ...(waiting && !error ? { approvalToken: phaseToken } : {}),
    ...(error ? { error } : {}),
  };
  if (liveblocks) {
    // One shared cleanup window, not a per-message timeout multiplied by nodes.
    try {
      await boundedOperation(async (cleanupSignal) => {
        const failures = [...messages.values()].filter((message) => message.status === "error");
        let index = 0;
        try {
          await boundedOperation(async (messageSignal) => {
            await Promise.all(Array.from({ length: Math.min(MAX_PROVIDER_CONCURRENCY, failures.length) }, async () => {
              while (index < failures.length && !messageSignal.aborted) {
                const data = failures[index++];
                const id = messageIds.get(data.nodeId);
                try {
                  if (id) await abortable(liveblocks!.updateFeedMessage(
                    { roomId, feedId: runId, messageId: id, data }, { signal: messageSignal }
                  ), messageSignal);
                  else await abortable(liveblocks!.createFeedMessage(
                    { roomId, feedId: runId, id: `${runId}-${data.nodeId}`, data }, { signal: messageSignal }
                  ), messageSignal);
                } catch { /* The terminal feed update retains its own cleanup time. */ }
              }
            }));
          }, FEED_TIMEOUT_MS, cleanupSignal);
        } catch { /* Always attempt terminal metadata, even if message writes hang. */ }
        checkAbort(cleanupSignal);
        await abortable(liveblocks!.updateFeed({ roomId, feedId: runId, metadata: finalMetadata }, { signal: cleanupSignal }), cleanupSignal);
      }, FEED_FINALIZE_TIMEOUT_MS);
    } catch { /* Never expose transport errors or let cleanup hold the run open. */ }
  }
  const outputMessage = [...messages.values()].find((message) => message.nodeType === "output" && message.status === "complete");
  return {
    runId, status: error ? "error" : waiting ? "waiting" : "complete", trigger,
    input: typeof input === "string" && input.length <= MAX_INPUT_CHARS ? input : "",
    ...(question ? { question } : {}),
    startedAt, ...(!waiting || error ? { completedAt } : {}), ...(error ? { error } : {}),
    output: outputMessage ? getRunOutput(outputMessage.outputs) : createEmptyOutput(outputProperties),
    nodes: [...messages.values()].sort((a, b) => a.startedAt - b.startedAt),
  };
}

function resolveAnswer(question: QuestionDef, answer: Answer): { handleKey: string; value: AnswerValue } {
  switch (answer.type) {
    case "choice":
      return { handleKey: answer.choice, value: {
        value: answer.choice, probability: answer.probabilities[answer.choice] ?? 0, confidence: answer.confidence,
      } };
    case "score": {
      const levelKey = question.type === "score" ? question.levels[answer.level].key : String(answer.level);
      return { handleKey: String(answer.level), value: {
        value: levelKey, probability: answer.probabilities[String(answer.level)] ?? 0, confidence: answer.confidence,
      } };
    }
    case "noul": {
      const yes = answer.noul >= answer.threshold;
      return { handleKey: yes ? "yes" : "no", value: {
        value: yes ? "yes" : "no", probability: answer.noul, confidence: Math.abs(answer.noul - 0.5) * 2,
      } };
    }
  }
}
