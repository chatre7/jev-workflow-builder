"use client";

import { useDeleteFeed, useFeeds, useOthers } from "@liveblocks/react";
import { useEdges, useNodes, useNodesData, useReactFlow } from "@xyflow/react";
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  Play,
  Terminal,
  Bot,
  Sparkles,
  MessageSquareText,
  FileOutput,
  FileSpreadsheet,
  CircleDashed,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  GitBranch,
  Globe,
  BookOpen,
  ClipboardCheck,
  Clock3,
  History,
  Route,
  Rows3,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApprovalExpired, useRun } from "./run-context";
import { KnowledgeResultPreview } from "./nodes";
import {
  getRunOutput,
  type Answer,
  type NodeResultData,
  type RunStatus,
} from "./runs";
import type { WorkflowSummary } from "./server/liveblocks";
import {
  FALSE_HANDLE,
  INPUT_NODE_ID,
  IN_HANDLE,
  MAX_INPUT_CHARS,
  MAX_QUESTION_CHARS,
  OUT_HANDLE,
  TRUE_HANDLE,
  truncate,
  type CsvNode,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./shared";

const MAX_RUNS = 25;

type Tab = "runs" | "api";

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function RunStatusIcon({ status }: { status: RunStatus | "skipped" }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-violet-600" />;
    case "waiting":
      return <Clock3 className="size-3.5 shrink-0 text-amber-700" aria-label="Waiting for approval" />;
    case "complete":
      return <Check className="size-3.5 text-emerald-600" />;
    case "error":
      return <AlertCircle className="size-3.5 text-red-600" />;
    case "skipped":
      return <CircleDashed className="size-3.5 text-neutral-400" />;
  }
}

function NodeTypeIcon({ type }: { type: WorkflowNodeType }) {
  switch (type) {
    case "input":
      return <MessageSquareText className="size-3.5 text-neutral-700" />;
    case "jev":
      return <Sparkles className="size-3.5 text-violet-600" />;
    case "llm":
      return <Bot className="size-3.5 text-sky-600" />;
    case "condition":
      return <GitBranch className="size-3.5 text-amber-600" />;
    case "transform":
      return <Rows3 className="size-3.5 text-teal-600" />;
    case "csv":
      return <FileSpreadsheet className="size-3.5 text-teal-600" />;
    case "http":
      return <Globe className="size-3.5 text-sky-600" />;
    case "approval":
      return <ClipboardCheck className="size-3.5 text-amber-600" />;
    case "knowledge":
      return <BookOpen className="size-3.5 text-teal-600" />;
    case "output":
      return <FileOutput className="size-3.5 text-emerald-600" />;
  }
}

function getApiUrl(workflowId: string): string {
  const origin =
    typeof window === "undefined"
      ? "http://localhost:3000"
      : window.location.origin;
  return `${origin}/api/workflows/${encodeURIComponent(workflowId)}/runs?wait=true`;
}

/* -------------------------------------------------------------------------- */
/*                                  Answers                                   */
/* -------------------------------------------------------------------------- */

function ProbabilityBars({
  probabilities,
  highlight,
}: {
  probabilities: Record<string, number>;
  highlight: string;
}) {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);

  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {entries.map(([key, probability]) => (
        <li key={key} className="flex items-center gap-2 text-[11px]">
          <span
            className={`w-24 truncate font-mono ${
              key === highlight ? "text-violet-700" : "text-neutral-500"
            }`}
          >
            {key}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded bg-neutral-100">
            <span
              className={`block h-full rounded ${
                key === highlight ? "bg-violet-500" : "bg-neutral-300"
              }`}
              style={{ width: `${Math.round(probability * 100)}%` }}
            />
          </span>
          <span className="w-8 text-right tabular-nums text-neutral-500">
            {Math.round(probability * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function AnswerView({ id, answer }: { id: string; answer: Answer }) {
  switch (answer.type) {
    case "choice":
      return (
        <div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-mono text-neutral-700">{id}</span>
            <span className="text-neutral-500">
              → <b className="text-neutral-900">{answer.choice}</b> · confidence{" "}
              {answer.confidence.toFixed(2)}
            </span>
          </div>
          <ProbabilityBars
            probabilities={answer.probabilities}
            highlight={answer.choice}
          />
        </div>
      );
    case "score":
      return (
        <div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-mono text-neutral-700">{id}</span>
            <span className="text-neutral-500">
              → score{" "}
              <b className="text-neutral-900">{answer.score.toFixed(2)}</b> ·
              level {answer.level} · confidence {answer.confidence.toFixed(2)}
            </span>
          </div>
          <ProbabilityBars
            probabilities={answer.probabilities}
            highlight={String(answer.level)}
          />
        </div>
      );
    case "noul": {
      const yes = answer.noul >= answer.threshold;
      return (
        <div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-mono text-neutral-700">{id}</span>
            <span className="text-neutral-500">
              → <b className="text-neutral-900">{yes ? "yes" : "no"}</b> · p={" "}
              {answer.noul.toFixed(2)} (threshold {answer.threshold.toFixed(2)})
            </span>
          </div>
          <div className="relative mt-1 h-1.5 overflow-hidden rounded bg-neutral-100">
            <span
              className={`block h-full rounded ${yes ? "bg-violet-500" : "bg-neutral-300"}`}
              style={{ width: `${Math.round(answer.noul * 100)}%` }}
            />
            <span
              className="absolute top-0 h-full w-px bg-neutral-700"
              style={{ left: `${Math.round(answer.threshold * 100)}%` }}
            />
          </div>
        </div>
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Trace                                    */
/* -------------------------------------------------------------------------- */

function ApprovalReview({
  message,
  workflowId,
  runId,
}: {
  message: NodeResultData;
  workflowId: string;
  runId: string;
}) {
  const approval = message.approval;
  const expired = useApprovalExpired(approval?.decision ? undefined : approval?.expiresAt);
  const [submitting, setSubmitting] = useState<"approved" | "rejected" | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function decide(decision: "approved" | "rejected") {
    if (inFlight.current || accepted || unavailable || !approval ||
        approval.decision || approval.expiresAt <= Date.now() || message.status !== "waiting") return;
    inFlight.current = true;
    setSubmitting(decision);
    setError(null);
    try {
      const response = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/approval`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId: message.nodeId, decision }),
        }
      );
      const json = (await response.json()) as { error?: string; runId?: string; status?: string };
      if (!response.ok) {
        if (response.status === 410) setUnavailable(true);
        throw new Error(
          json.error ??
          (response.status === 409
            ? "This run is busy or the decision was already submitted. Wait for the trace to update."
            : response.status === 410
              ? "This approval expired or is no longer available. Start a new run."
              : `Could not submit the decision (${response.status}).`)
        );
      }
      if (json.runId !== runId || json.status !== "running") {
        throw new Error("Unexpected response. Check the run trace before submitting again.");
      }
      setAccepted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the decision.");
    } finally {
      inFlight.current = false;
      setSubmitting(null);
    }
  }

  if (!approval) return null;
  const disabled = submitting !== null || accepted || unavailable || expired || message.status !== "waiting";

  return (
    <div className="space-y-2 border-t border-neutral-100 px-2.5 py-2">
      <div>
        <p className="mb-1 text-[11px] font-medium text-neutral-600">Review prompt</p>
        <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-800">
          {truncate(approval.prompt, 40_000)}
        </p>
      </div>
      <details>
        <summary className="cursor-pointer text-[11px] font-medium text-neutral-600">Review input</summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-neutral-700">
          {truncate(message.input, 32_000) || "(empty input)"}
        </pre>
      </details>
      {approval.decision ? (
        <p className="break-words text-xs text-neutral-700" role="status">
          <span className="font-medium">{approval.decision === "approved" ? "Approved" : "Rejected"}</span>
          {approval.decidedBy ? ` by ${approval.decidedBy}` : ""}
          {approval.decidedAt !== undefined ? ` · ${new Date(approval.decidedAt).toLocaleString()}` : ""}
          <span className="mt-1 block text-[11px] text-neutral-500">Original input passed to the {approval.decision} branch.</span>
        </p>
      ) : (
        <>
          <p className={`text-[11px] ${expired || unavailable ? "text-red-700" : "text-amber-700"}`} role="status">
            {expired
              ? "Approval expired. No decision was made; start a new run."
              : unavailable
                ? "Approval is no longer available. Start a new run."
                : message.status !== "waiting"
                  ? "Review is not available while this run is no longer waiting."
                  : `Waiting for owner review · expires ${new Date(approval.expiresAt).toLocaleString()}`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={disabled} onClick={() => void decide("approved")} className="primary-button !min-h-8 !text-xs">
              {submitting === "approved" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
              {submitting === "approved" ? "Submitting…" : "Approve"}
            </button>
            <button type="button" disabled={disabled} onClick={() => void decide("rejected")} className="min-h-8 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50">
              {submitting === "rejected" ? "Submitting…" : "Reject"}
            </button>
          </div>
          {accepted ? (
            <p role="status" className="text-[11px] text-neutral-600">Decision received by the server. Waiting for the run trace to update…</p>
          ) : null}
        </>
      )}
      {error ? <p role="alert" className="break-words text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

function TraceNode({
  message,
  depth,
  onFocus,
  workflowId,
  runId,
}: {
  message: NodeResultData;
  depth: number;
  onFocus: () => void;
  workflowId: string;
  runId: string;
}) {
  const outputs = getRunOutput(message.outputs);
  const approvalExpired = useApprovalExpired(
    message.approval?.decision ? undefined : message.approval?.expiresAt
  );
  const conditionBranch = message.nodeType === "condition"
    ? message.firedHandles?.find(
        (handle) => handle === TRUE_HANDLE || handle === FALSE_HANDLE
      )
    : undefined;

  return (
    <li style={{ paddingLeft: depth * 10 }}>
      <div className="trace-card overflow-hidden rounded-lg bg-white">
        <button
          type="button"
          onClick={onFocus}
          className="flex min-h-7 w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-neutral-50"
        >
          <NodeTypeIcon type={message.nodeType} />
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-900">
            {message.label}
          </span>
          {message.activation === "all" ? (
            <span
              className="rounded bg-neutral-900 px-1 text-[10px] font-semibold text-white"
              title="Ran because all incoming handles fired"
            >
              AND
            </span>
          ) : null}
          {message.mock ? (
            <span className="rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700">
              mock
            </span>
          ) : null}
          <span className="text-[11px] tabular-nums text-neutral-400">
            {approvalExpired ? "Expired" : message.status === "waiting" ? "Waiting" : formatDuration(message.durationMs)}
          </span>
          <RunStatusIcon status={approvalExpired ? "error" : message.status} />
        </button>

        {message.error ? (
          <p className="border-t border-neutral-100 px-2.5 py-1.5 text-xs text-red-700">
            {message.error}
          </p>
        ) : null}

        {message.nodeType === "input" ? (
          <div className="space-y-2 border-t border-neutral-100 px-2.5 py-1.5 text-xs leading-relaxed text-neutral-600">
            <p className="whitespace-pre-wrap break-words">{truncate(message.input, 400)}</p>
            {message.question ? (
              <div>
                <p className="font-medium text-neutral-700">Question for this run</p>
                <p className="whitespace-pre-wrap break-words">{message.question}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {message.answers && Object.keys(message.answers).length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-neutral-100 px-2.5 py-2">
            {Object.entries(message.answers).map(([id, answer]) => (
              <AnswerView key={id} id={id} answer={answer} />
            ))}
          </div>
        ) : null}

        {message.nodeType === "llm" &&
        message.output !== undefined &&
        message.status !== "skipped" ? (
          <p className="whitespace-pre-wrap border-t border-neutral-100 px-2.5 py-1.5 text-xs leading-relaxed text-neutral-700">
            {message.output}
            {message.status === "running" ? (
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-violet-500 align-middle" />
            ) : null}
          </p>
        ) : null}

        {message.nodeType === "approval" ? (
          <ApprovalReview key={`${runId}-${message.nodeId}`} message={message} workflowId={workflowId} runId={runId} />
        ) : null}

        {message.nodeType === "http" && (message.httpStatus !== undefined || message.output !== undefined) ? (
          <div className="space-y-1 border-t border-neutral-100 px-2.5 py-1.5">
            {message.httpStatus !== undefined ? <p className="text-xs font-medium text-neutral-700">HTTP {message.httpStatus}</p> : null}
            <pre aria-label="HTTP response" className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-neutral-700">
              {truncate(message.output ?? "", 32_000) || "(empty response)"}
            </pre>
          </div>
        ) : null}

        {message.nodeType === "knowledge" && message.output !== undefined ? (
          <div className="border-t border-neutral-100 px-2.5 py-2">
            <p className="mb-1 text-[11px] font-medium text-neutral-500">Knowledge results · lexical search · no AI</p>
            <KnowledgeResultPreview output={message.output} />
          </div>
        ) : null}
        {conditionBranch ? (
          <div className="border-t border-neutral-100 px-2.5 py-1.5">
            <p className="text-xs font-medium text-amber-700">
              Result: {conditionBranch} · no AI
            </p>
            <p className="mt-1 text-[10px] text-neutral-500">
              Original input passed to the {conditionBranch} branch
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-700">
              {truncate(message.output ?? message.input, 400)}
            </p>
          </div>
        ) : null}

        {(message.nodeType === "transform" || message.nodeType === "csv") &&
        message.output !== undefined &&
        message.status !== "skipped" ? (
          <div className="border-t border-neutral-100 px-2.5 py-1.5">
            <p className="mb-1 text-[10px] font-medium text-neutral-500">
              JSON output · no AI
            </p>
            {message.nodeType === "csv" && message.csv ? (
              <p className="mb-1 text-xs font-medium text-neutral-700">
                {message.csv.rowCount} {message.csv.rowCount === 1 ? "row" : "rows"} ·{" "}
                {message.csv.columnCount} {message.csv.columnCount === 1 ? "column" : "columns"} ·{" "}
                {message.csv.headers ? "First row headers" : "No headers"}
              </p>
            ) : null}
            <pre
              aria-label="JSON output"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-neutral-700"
            >
              {message.output}
            </pre>
          </div>
        ) : null}

        {message.nodeType === "output" && message.outputs ? (
          <div className="flex flex-col gap-2 border-t border-neutral-100 px-2.5 py-1.5">
            {Object.entries(outputs).map(([name, texts]) => (
              <div key={name}>
                <p className="mb-0.5 text-[10px] font-medium text-neutral-500">
                  {name}
                </p>
                {texts.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {texts.map((text, index) => (
                      <li
                        key={index}
                        className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-700"
                      >
                        {text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-neutral-400">No message</p>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {message.status === "skipped" ? (
          <p className="border-t border-neutral-100 px-2.5 py-1.5 text-xs text-neutral-400">
            Skipped: nothing to run. Input passed through.
          </p>
        ) : null}
      </div>
    </li>
  );
}

function RunTrace({ workflowId }: { workflowId: string }) {
  const { messages, isLoading, selectedRunId } = useRun();
  const reactFlow = useReactFlow<WorkflowNode>();

  // Depth = longest parent chain, so the trace reads as a tree.
  const depths = useMemo(() => {
    const map = new Map<string, number>();

    for (const message of messages) {
      const parentDepths = message.parentNodeIds.map((id) => map.get(id) ?? 0);
      map.set(
        message.nodeId,
        parentDepths.length > 0 ? Math.max(...parentDepths) + 1 : 0
      );
    }

    return map;
  }, [messages]);

  if (!selectedRunId) {
    return (
      <div className="panel-empty-state">
        <Route className="size-3.5 shrink-0 text-neutral-400" aria-hidden />
        <p>Select a run to see its trace.</p>
      </div>
    );
  }

  if (isLoading && messages.length === 0) {
    return (
      <p className="flex items-center gap-2 px-1 text-xs text-neutral-400">
        <Loader2 className="size-3.5 animate-spin" /> Loading run…
      </p>
    );
  }

  if (messages.length === 0) {
    return (
      <p className="px-1 text-xs text-neutral-400">
        Waiting for the first node…
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {messages.map((message) => (
        <TraceNode
          key={message.nodeId}
          message={message}
          workflowId={workflowId}
          runId={selectedRunId}
          depth={depths.get(message.nodeId) ?? 0}
          onFocus={() =>
            void reactFlow.fitView({
              nodes: [{ id: message.nodeId }],
              duration: 400,
              maxZoom: 1,
              padding: 0.4,
            })
          }
        />
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Run list                                  */
/* -------------------------------------------------------------------------- */

function Viewers({ runId }: { runId: string }) {
  const viewers = useOthers((others) =>
    others
      .filter((other) => other.presence.selectedRunId === runId)
      .map((other) => other.info)
  );

  if (viewers.length === 0) {
    return null;
  }

  return (
    <span
      className="flex -space-x-1"
      title={viewers.map((v) => v.name).join(", ")}
    >
      {viewers.slice(0, 3).map((viewer, index) => (
        <span
          key={index}
          className="size-2.5 rounded-full ring-1 ring-white"
          style={{ background: viewer.color }}
        />
      ))}
    </span>
  );
}

function RunList() {
  const { feeds, isLoading } = useFeeds();
  const deleteFeed = useDeleteFeed();
  const { selectedRunId, selectRun, messages } = useRun();
  const pendingExpiry = messages.reduce<number | undefined>(
    (earliest, message) =>
      message.status === "waiting" && message.approval && !message.approval.decision
        ? Math.min(earliest ?? Infinity, message.approval.expiresAt)
        : earliest,
    undefined
  );
  const selectedExpired = useApprovalExpired(pendingExpiry);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const runs = useMemo(
    () =>
      [...(feeds ?? [])]
        .sort(
          (a, b) => Number(b.metadata.startedAt) - Number(a.metadata.startedAt)
        )
        .slice(0, MAX_RUNS),
    [feeds]
  );

  // Preview the newest run once, when the panel first loads. After that the
  // selection is the user's: exiting the preview must not re-select a run.
  const didAutoSelect = useRef(false);

  useEffect(() => {
    if (!didAutoSelect.current && runs.length > 0) {
      didAutoSelect.current = true;
      if (selectedRunId === null) {
        selectRun(runs[0].feedId);
      }
    }
  }, [runs, selectedRunId, selectRun]);

  async function deleteRun(runId: string) {
    if (deletingRunId !== null) return;
    const run = runs.find((item) => item.feedId === runId);
    if (!run || run.metadata.status === "running" ||
        (run.metadata.status === "waiting" && !(selectedRunId === runId && selectedExpired))) return;

    setDeletingRunId(runId);
    setDeleteError(null);
    if (selectedRunId === runId) {
      selectRun(null);
    }

    try {
      await deleteFeed(runId);
    } catch {
      setDeleteError("Couldn't delete this run. Try again.");
    } finally {
      setDeletingRunId(null);
    }
  }

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 px-1 text-xs text-neutral-400">
        <Loader2 className="size-3.5 animate-spin" /> Loading runs…
      </p>
    );
  }

  return (
    <>
      {runs.length === 0 && (
        <div className="panel-empty-state">
          <History className="size-3.5 shrink-0 text-neutral-400" aria-hidden />
          <p>No runs yet. Try the sample input above.</p>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {runs.map((run) => {
          const selected = run.feedId === selectedRunId;
          const deleting = run.feedId === deletingRunId;

          return (
            <li
              key={run.feedId}
              className={`run-list-item flex items-center rounded-md border ${
                selected
                  ? "border-violet-200 bg-violet-50/70"
                  : "border-transparent hover:border-neutral-200 hover:bg-white"
              }`}
            >
              <button
                type="button"
                // Clicking the selected run again exits the preview.
                onClick={() => selectRun(selected ? null : run.feedId)}
                title={selected ? "Exit run preview" : "Preview this run"}
                aria-pressed={selected}
                disabled={deleting}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1 text-left"
              >
                <RunStatusIcon status={selected && selectedExpired ? "error" : run.metadata.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-neutral-800 font-medium">
                    {run.metadata.input || "(empty input)"}
                  </span>
                  {run.metadata.question ? (
                    <span className="mt-0.5 block truncate text-[11px] text-neutral-600">
                      Question: {run.metadata.question}
                    </span>
                  ) : null}
                  <span className="mt-px block text-[10px] tabular-nums text-neutral-500">
                    {formatTime(Number(run.metadata.startedAt))} ·{" "}
                    {run.metadata.trigger === "api" ? "API" : "test run"}
                    {run.metadata.status === "waiting"
                      ? selected && selectedExpired ? " · Approval expired" : " · Waiting for approval"
                      : run.metadata.completedAt
                      ? ` · ${formatDuration(
                          Number(run.metadata.completedAt) -
                            Number(run.metadata.startedAt)
                        )}`
                      : ""}
                  </span>
                </span>
                <Viewers runId={run.feedId} />
              </button>
              <button
                type="button"
                className="icon-button run-delete-button mr-1 shrink-0"
                onClick={() => void deleteRun(run.feedId)}
                disabled={deletingRunId !== null || run.metadata.status === "running" ||
                  (run.metadata.status === "waiting" && !(selected && selectedExpired))}
                data-deleting={deleting || undefined}
                aria-label={`Delete run from ${formatTime(Number(run.metadata.startedAt))}`}
                title={run.metadata.status === "waiting" && !(selected && selectedExpired)
                  ? "Review this run before deleting it; expired approvals can be deleted after selecting the run"
                  : run.metadata.status === "running" ? "Wait for this run to finish before deleting it" : "Delete run"}
              >
                {deleting ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="size-3" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {deleteError && (
        <p role="alert" className="mt-2 px-1 text-[11px] text-red-600">
          {deleteError}
        </p>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Runs tab                                  */
/* -------------------------------------------------------------------------- */

type CsvPreview = {
  rowCount: number;
  columnCount: number;
  headers: boolean;
  delimiter: string;
  columns: string[];
  rows: string[][];
};

function CsvPreviewTable({ preview }: { preview: CsvPreview }) {
  return (
    <div className="mt-2 min-w-0">
      <p className="text-[11px] font-medium text-neutral-700">
        {preview.rowCount} data {preview.rowCount === 1 ? "row" : "rows"} ·{" "}
        {preview.columnCount} {preview.columnCount === 1 ? "column" : "columns"}
      </p>
      <p className="mt-0.5 text-[11px] leading-4 text-neutral-600">
        {preview.delimiter === "\t" ? "Tab" : preview.delimiter === ";" ? "Semicolon" : "Comma"} delimiter ·{" "}
        {preview.headers ? "First row headers" : "No headers"}
      </p>
      <div className="csv-preview-scroll mt-1.5" role="region" aria-label="CSV preview table" tabIndex={0}>
        <table className="csv-preview-table">
          <caption className="sr-only">Validated CSV data preview</caption>
          <thead>
            <tr>{preview.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-neutral-600">
        Showing {preview.rows.length ? `first ${preview.rows.length}` : "0"} of {preview.rowCount} data rows and{" "}
        {preview.columns.length} of {preview.columnCount} columns. Preview only; the run sends all input.
      </p>
    </div>
  );
}

function RunsTab({ workflow }: { workflow: WorkflowSummary }) {
  const nodes = useNodes<WorkflowNode>();
  const edges = useEdges();
  const inputNode = useNodesData<WorkflowNode>(INPUT_NODE_ID);
  const { selectRun } = useRun();
  const [input, setInput] = useState<string | null>(null);
  const [isStarting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [selectedCsvId, setSelectedCsvId] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isReading, setReading] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewResult, setPreviewResult] = useState<{
    key: string;
    data?: CsvPreview;
    error?: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileReader = useRef<FileReader | null>(null);
  const fileGeneration = useRef(0);
  const csvNodes = useMemo(
    () => nodes.filter((node): node is CsvNode => {
      if (node.type !== "csv" || inputNode?.type !== "input") return false;
      const incoming = edges.filter((edge) => edge.target === node.id);
      return incoming.length > 0 && incoming.every((edge) =>
        edge.source === INPUT_NODE_ID && edge.sourceHandle === OUT_HANDLE && (edge.targetHandle ?? IN_HANDLE) === IN_HANDLE
      );
    }),
    [nodes, edges, inputNode?.type]
  );
  const csvNode = csvNodes.find((node) => node.id === selectedCsvId) ?? csvNodes[0];
  const hasLlm = nodes.some((node) => node.type === "llm");
  const csvConfig = JSON.stringify(csvNodes.map((node) => [node.id, node.data.delimiter, node.data.headers]));
  const uploadContext = JSON.stringify([workflow.workflowId, csvConfig, csvNode?.id]);
  const currentUploadContext = useRef(uploadContext);
  currentUploadContext.current = uploadContext;

  const sample = inputNode?.type === "input" ? inputNode.data.sample : "";
  const value = input ?? sample;
  const inputTooLong = value.length > MAX_INPUT_CHARS;
  const previewKey = JSON.stringify([uploadContext, value, previewAttempt]);
  const currentPreview = previewResult?.key === previewKey ? previewResult : null;
  const needsPreview = Boolean(csvNode && value.trim() && !inputTooLong && !fileError && !isReading);
  const isValidating = needsPreview && !currentPreview;
  const runDisabled = isStarting || isReading || Boolean(fileError) || inputTooLong ||
    value.trim() === "" || inputNode?.type !== "input" ||
    (hasLlm && question.length > MAX_QUESTION_CHARS) ||
    Boolean(csvNode && !currentPreview?.data);

  function cancelFileRead() {
    fileGeneration.current += 1;
    const reader = fileReader.current;
    fileReader.current = null;
    if (reader?.readyState === FileReader.LOADING) reader.abort();
  }

  function changeInput(next: string | null, preserveFileSelection = false) {
    cancelFileRead();
    setReading(false);
    setFileError(null);
    setFileName(null);
    setError(null);
    if (!preserveFileSelection && fileInput.current) fileInput.current.value = "";
    setInput(next);
  }

  useEffect(() => {
    if (fileReader.current) {
      cancelFileRead();
      setReading(false);
      setFileError("CSV settings changed while reading. Choose the file again or enter text below.");
    }
  }, [uploadContext]);

  useEffect(() => () => cancelFileRead(), []);

  useEffect(() => {
    if (!needsPreview || !csvNode) return;
    const controller = new AbortController();
    const nodeId = csvNode.id;
    const delimiter = csvNode.data.delimiter;
    const headers = csvNode.data.headers;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/workflows/${encodeURIComponent(workflow.workflowId)}/csv-preview`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: value, nodeId }),
            signal: controller.signal,
          }
        );
        const result = await response.json() as CsvPreview & { error?: string };
        if (!response.ok) throw new Error(result.error ?? `Preview failed (${response.status}).`);
        if (result.delimiter !== delimiter || result.headers !== headers) {
          throw new Error("CSV settings are still saving. Retry the preview.");
        }
        if (!controller.signal.aborted) setPreviewResult({ key: previewKey, data: result });
      } catch (err) {
        if (!controller.signal.aborted) {
          setPreviewResult({
            key: previewKey,
            error: err instanceof Error ? err.message : "Couldn't validate the CSV. Retry the preview.",
          });
        }
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [needsPreview, previewKey, csvNode?.id, csvNode?.data.delimiter, csvNode?.data.headers, value, workflow.workflowId]);

  function chooseFile(file: File | undefined) {
    if (!file) return;
    changeInput("", true);
    setFileName(file.name);
    if (file.size > MAX_INPUT_CHARS * 3 + 3) {
      setFileError(`This file is too large. Use a UTF-8 CSV with at most ${MAX_INPUT_CHARS.toLocaleString()} characters, or paste a smaller dataset below.`);
      return;
    }
    const generation = fileGeneration.current;
    const context = uploadContext;
    const reader = new FileReader();
    fileReader.current = reader;
    setReading(true);
    reader.onload = () => {
      if (generation !== fileGeneration.current || context !== currentUploadContext.current) return;
      fileReader.current = null;
      setReading(false);
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(reader.result as ArrayBuffer);
        if (decoded.length > MAX_INPUT_CHARS) {
          setFileError(`This file exceeds ${MAX_INPUT_CHARS.toLocaleString()} characters. Choose a smaller file or paste a smaller dataset below.`);
          return;
        }
        if (!decoded.trim()) {
          setFileError("This file is empty. Choose another file or enter CSV below.");
          return;
        }
        setInput(decoded);
      } catch {
        setFileError("This file isn't valid UTF-8. Save it as UTF-8 CSV and choose it again, or paste the text below.");
      }
    };
    reader.onerror = () => {
      if (generation !== fileGeneration.current || context !== currentUploadContext.current) return;
      fileReader.current = null;
      setReading(false);
      setFileError("Couldn't read this file. Choose it again or paste CSV below.");
    };
    reader.readAsArrayBuffer(file);
  }

  async function run() {
    if (runDisabled) return;
    setStarting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/workflows/${encodeURIComponent(workflow.workflowId)}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: value,
            trigger: "test",
            ...(hasLlm && question.trim() ? { question } : {}),
          }),
        }
      );
      const json = (await response.json()) as {
        runId?: string;
        error?: string;
      };

      if (!response.ok || !json.runId) {
        throw new Error(json.error ?? `Request failed (${response.status})`);
      }

      selectRun(json.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="runs-tab flex min-h-0 flex-1 flex-col">
      <div className="run-composer border-b border-neutral-200/70 p-2.5">
        <div className="mb-2.5 flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-violet-50 text-violet-600">
            <FlaskConical className="size-3.5" aria-hidden />
          </span>
          <div>
            <h2 className="text-[13px] font-semibold text-neutral-900">
              Test your workflow
            </h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              Run sample input and inspect the results.
            </p>
          </div>
        </div>
        {csvNode ? (
          <div className="mb-2.5 min-w-0">
            <label htmlFor="run-csv-file" className="mb-1.5 block text-[11px] font-medium text-neutral-600">
              CSV file
            </label>
            <input
              ref={fileInput}
              id="run-csv-file"
              type="file"
              accept=".csv,text/csv"
              aria-describedby="run-csv-help"
              onChange={(event) => chooseFile(event.target.files?.[0])}
              className="csv-file-input block w-full min-w-0 text-[11px] text-neutral-600"
            />
            <p id="run-csv-help" className="mt-1 text-[11px] leading-4 text-neutral-600">
              UTF-8 CSV, up to {MAX_INPUT_CHARS.toLocaleString()} characters. Or paste CSV below.
            </p>
            {fileName ? (
              <div className="mt-1 flex min-w-0 items-start gap-2">
                <p className="min-w-0 flex-1 break-all text-[11px] leading-5 text-neutral-700">
                  {fileName}{isReading ? " · Reading…" : fileError ? " · Not loaded" : " · Loaded into input"}
                </p>
                <button type="button" onClick={() => changeInput("")} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100">
                  Remove file
                </button>
              </div>
            ) : null}
            {csvNodes.length > 1 ? (
              <div className="mt-2">
                <label htmlFor="run-csv-node" className="mb-1 block text-[11px] font-medium text-neutral-600">Preview CSV node</label>
                <select id="run-csv-node" value={csvNode.id} onChange={(event) => setSelectedCsvId(event.target.value)} className="workflow-field w-full min-w-0 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px]">
                  {csvNodes.map((node) => <option key={node.id} value={node.id}>{node.data.label} ({node.id})</option>)}
                </select>
              </div>
            ) : (
              <p className="mt-1 break-words text-[11px] text-neutral-600">Preview uses {csvNode.data.label} settings.</p>
            )}
          </div>
        ) : null}
        <label
          htmlFor="run-input"
          className="mb-1.5 block text-[11px] font-medium text-neutral-600"
        >
          {csvNode ? "CSV input" : "Input message"}
        </label>
        <textarea
          id="run-input"
          value={value}
          rows={3}
          placeholder="Text to send to the input node…"
          onChange={(event) => changeInput(event.target.value)}
          className="workflow-field block w-full resize-y rounded-md border border-neutral-200 bg-neutral-50/70 px-2 py-1.5 text-[11px] leading-5 text-neutral-700 placeholder:text-neutral-500 focus:border-violet-400 focus:bg-white focus:outline-none"
        />
        {inputTooLong ? (
          <p role="alert" className="mt-1 text-[11px] text-red-700">
            Input exceeds {MAX_INPUT_CHARS.toLocaleString()} characters. Shorten it before running; no data has been truncated.
          </p>
        ) : null}
        {fileError ? <p role="alert" className="mt-1 text-[11px] leading-4 text-red-700">{fileError}</p> : null}
        {isReading || isValidating ? (
          <p role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-600">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {isReading ? "Reading CSV file…" : "Validating all CSV data…"}
          </p>
        ) : null}
        {csvNode && currentPreview?.data && needsPreview ? <CsvPreviewTable preview={currentPreview.data} /> : null}
        {csvNode && currentPreview?.error && needsPreview ? (
          <div className="mt-2">
            <p role="alert" className="text-[11px] leading-4 text-red-700">{currentPreview.error}</p>
            <p className="mt-1 text-[11px] leading-4 text-neutral-600">Edit the CSV input or the CSV node settings, choose another file, or retry.</p>
            <button type="button" onClick={() => setPreviewAttempt((attempt) => attempt + 1)} className="mt-1 min-h-7 rounded-md px-2 text-[11px] text-neutral-600 hover:bg-neutral-100">Retry preview</button>
          </div>
        ) : null}
        {hasLlm ? (
          <div className="mt-3">
            <label htmlFor="run-question" className="mb-1.5 block text-[11px] font-medium text-neutral-600">Question for this run <span className="font-normal">(optional)</span></label>
            <textarea
              id="run-question"
              value={question}
              rows={2}
              maxLength={MAX_QUESTION_CHARS}
              onChange={(event) => setQuestion(event.target.value)}
              aria-describedby="run-question-help run-question-count"
              placeholder="What would you like to know about this input?"
              className="workflow-field block w-full resize-y rounded-md border border-neutral-200 bg-neutral-50/70 px-2 py-1.5 text-[11px] leading-5 text-neutral-700 placeholder:text-neutral-500 focus:border-violet-400 focus:bg-white focus:outline-none"
            />
            <p id="run-question-help" className="mt-1 text-[11px] leading-4 text-neutral-600">Sent to LLM nodes along with their configured prompt. Leave empty to use only the configured prompt.</p>
            <p id="run-question-count" className="mt-0.5 text-right text-[10px] tabular-nums text-neutral-500">{question.length.toLocaleString()} / {MAX_QUESTION_CHARS.toLocaleString()}</p>
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void run()}
            disabled={runDisabled}
            title={
              inputNode?.type !== "input"
                ? "Add an Input node to run the workflow"
                : undefined
            }
            className="primary-button !min-h-7 !text-[11px]"
          >
            {isStarting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {isStarting ? "Starting…" : "Run"}
          </button>
          {(input !== null && input !== sample) || fileName || fileError ? (
            <button
              type="button"
              onClick={() => changeInput(null)}
              className="min-h-7 rounded-md px-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
            >
              Reset to sample
            </button>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="w-full rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <div className="run-history min-h-0 flex-1 overflow-y-auto p-2.5">
        <Section title="Recent runs">
          <RunList />
        </Section>
        <Section title="Execution trace">
          <RunTrace workflowId={workflow.workflowId} />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3 last:mb-0">
      <h3 className="mb-1.5 text-[11px] font-medium text-neutral-600">
        {title}
      </h3>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   API tab                                  */
/* -------------------------------------------------------------------------- */

type SnippetLanguage = "curl" | "javascript" | "python";

const SNIPPET_LANGUAGES: { id: SnippetLanguage; label: string }[] = [
  { id: "curl", label: "curl" },
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

const SNIPPET_INPUT =
  "I was charged twice for order A-104. Please refund the duplicate.";

function getSnippet(language: SnippetLanguage, url: string): string {
  switch (language) {
    case "curl":
      return [
        `curl -X POST "${url}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Authorization: Bearer $WORKFLOW_API_TOKEN" \\`,
        `  -d '${JSON.stringify({ input: SNIPPET_INPUT })}'`,
      ].join("\n");
    case "javascript":
      return [
        `const response = await fetch(${JSON.stringify(url)}, {`,
        `  method: "POST",`,
        `  headers: {`,
        `    "Content-Type": "application/json",`,
        `    "Authorization": "Bearer " + process.env.WORKFLOW_API_TOKEN,`,
        `  },`,
        `  body: JSON.stringify({`,
        `    input: ${JSON.stringify(SNIPPET_INPUT)},`,
        `  }),`,
        `});`,
        ``,
        `const run = await response.json();`,
        `console.log(run.output);`,
      ].join("\n");
    case "python":
      return [
        `import os`,
        `import requests`,
        ``,
        `response = requests.post(`,
        `    ${JSON.stringify(url)},`,
        `    headers={"Authorization": "Bearer " + os.environ["WORKFLOW_API_TOKEN"]},`,
        `    json={"input": ${JSON.stringify(SNIPPET_INPUT)}},`,
        `)`,
        ``,
        `run = response.json()`,
        `print(run["output"])`,
      ].join("\n");
  }
}

function ApiTab({ workflow }: { workflow: WorkflowSummary }) {
  const [language, setLanguage] = useState<SnippetLanguage>("curl");
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState(() =>
    getApiUrl(workflow.workflowId)
  );

  useEffect(() => {
    setUrl(getApiUrl(workflow.workflowId));
  }, [workflow.workflowId]);

  const snippet = getSnippet(language, url);

  async function copy() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs text-neutral-600">
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-700">
          <Terminal className="size-3.5" aria-hidden />
        </span>
        <div>
          <h2 className="text-[13px] font-semibold text-neutral-900">
            API access
          </h2>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            Send a request to run this workflow.
          </p>
        </div>
      </div>
      <div className="shrink-0 overflow-hidden rounded-lg bg-[#20212a] shadow-sm">
        <div className="flex flex-wrap items-center gap-0.5 border-b border-white/10 px-1.5 py-1">
          {SNIPPET_LANGUAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setLanguage(item.id)}
              aria-pressed={language === item.id}
              className={`min-h-7 rounded-md px-2 py-1 text-[11px] font-medium ${
                language === item.id
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void copy()}
            className="ml-auto inline-flex min-h-7 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 hover:text-white"
          >
            {copied ? (
              <Check className="size-3" />
            ) : (
              <Copy className="size-3" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-5 text-neutral-100">
          {snippet}
        </pre>
      </div>
      <details className="shrink-0">
        <summary className="cursor-pointer rounded py-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500">
          API details
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          <p className="leading-relaxed">
            Send a POST request with JSON containing an{" "}
            <code className="rounded bg-neutral-100 px-1">input</code> string.
            With <code className="rounded bg-neutral-100 px-1">?wait=true</code>{" "}
            the response includes{" "}
            <code className="rounded bg-neutral-100 px-1">output</code>, an
            object with a key for each property configured on the output node.
            Each value is an array of messages received by that input. The run
            also shows up in the Runs tab for everyone in the room.
          </p>
          <p className="leading-relaxed">
            These examples run on your server and require{" "}
            <code className="rounded bg-neutral-100 px-1">WORKFLOW_API_TOKEN</code>.
            Configure the same secret on this application and the calling service.
            Never put it in browser code. The token permits runs within this private
            workspace, not editing or Liveblocks access.
          </p>
          <ul className="flex flex-col gap-1.5 leading-relaxed">
            <li>
              <code className="rounded bg-neutral-100 px-1">?wait=true</code>{" "}
              blocks until the run finishes and returns JSON with{" "}
              <code className="rounded bg-neutral-100 px-1">
                {"output: Record<string, string[]>"}
              </code>{" "}
              (one entry per node that fired into each input) plus the full
              trace.
            </li>
            <li>
              Without it, the endpoint responds{" "}
              <code className="rounded bg-neutral-100 px-1">202</code> with{" "}
              <code className="rounded bg-neutral-100 px-1">{"{ runId }"}</code>{" "}
              right away while the run streams into the feed.
            </li>
            <li>
              Requests are subject to shared concurrency, rate, and daily budgets.
              A <code className="rounded bg-neutral-100 px-1">429</code> response
              includes <code className="rounded bg-neutral-100 px-1">Retry-After</code>.
            </li>
            <li>
              Each Jev node makes one request; each LLM node streams its
              response. Without API keys, both use mock responses.
            </li>
          </ul>
        </div>
      </details>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Side panel                                 */
/* -------------------------------------------------------------------------- */

export function SidePanel({ workflow }: { workflow: WorkflowSummary }) {
  const [tab, setTab] = useState<Tab>("runs");
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Show side panel"
        className="panel-collapsed flex w-7 shrink-0 items-center justify-center border-l border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50"
      >
        <ChevronLeft className="size-4" />
      </button>
    );
  }

  return (
    <aside
      className="workflow-side-panel"
      aria-label="Workflow testing and API"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-neutral-200/70 px-1.5">
        {(
          [
            ["runs", "Runs", <Play key="runs" className="size-3" />],
            ["api", "API", <Terminal key="api" className="size-3.5" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium ${
              tab === id
                ? "bg-violet-50 text-violet-700"
                : "text-neutral-500 hover:text-neutral-900"
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Hide side panel"
          className="icon-button ml-auto"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      {tab === "runs" ? (
        <RunsTab key={workflow.workflowId} workflow={workflow} />
      ) : (
        <ApiTab workflow={workflow} />
      )}
    </aside>
  );
}
