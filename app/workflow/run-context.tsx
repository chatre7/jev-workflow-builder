"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NodeResultData, RunMetadata } from "./runs";

export type RunRecord = { runId: string; metadata: RunMetadata };

export type RunContextValue = {
  workflowId: string;
  // Stored runs of this workflow, newest first.
  runs: readonly RunRecord[];
  runsLoading: boolean;
  refreshRuns: () => Promise<void>;
  selectedRunId: string | null;
  selectRun: (runId: string | null) => void;
  // Latest result per node id for the selected run.
  results: ReadonlyMap<string, NodeResultData>;
  // All messages of the selected run, oldest first.
  messages: readonly NodeResultData[];
  isLoading: boolean;
  /** Starts a run, selects it and follows its progress live. Resolves with the run ID. */
  startRun: (body: Record<string, unknown>) => Promise<string>;
  /** Submits an approval decision and follows the resumed phase live. */
  decideApproval: (runId: string, nodeId: string, decision: "approved" | "rejected") => Promise<void>;
  deleteRun: (runId: string) => Promise<void>;
};

const RunContext = createContext<RunContextValue | null>(null);

// Polling cadence for runs that are not streaming into this tab.
const ACTIVE_RUN_POLL_MS = 1_000;
const RUN_LIST_POLL_MS = 4_000;

type RunEventMessage =
  | { event: "start"; data: { runId: string } }
  | { event: "run"; data: RunMetadata }
  | { event: "node"; data: NodeResultData }
  | { event: "done"; data: { runId: string } }
  | { event: "failed"; data: { error?: string } };

/** Reads the Server-Sent Events body produced by the run routes. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEventMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        let event = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!event || !data) continue;
        try {
          yield { event, data: JSON.parse(data) } as RunEventMessage;
        } catch {
          // A damaged frame is skipped; the run store remains the source of truth.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class RunRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "RunRequestError";
  }
}

async function requestError(response: Response, fallback: string): Promise<RunRequestError> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return new RunRequestError(response.status, body.error);
  } catch { /* not JSON */ }
  return new RunRequestError(response.status, `${fallback} (${response.status}).`);
}

/**
 * Holds the run list and the run selected in the side panel, so both the
 * panel (trace) and the canvas (highlighted path) read from one place.
 * Progress arrives live over SSE for runs this tab started or resumed, and by
 * polling the run store for everything else.
 */
export function RunProvider({ workflowId, children }: { workflowId: string; children: ReactNode }) {
  const [runs, setRuns] = useState<readonly RunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly NodeResultData[]>([]);
  const [isLoading, setLoading] = useState(false);
  // Runs currently streaming into this tab; polling and snapshot loads skip their traces.
  const [streamingIds, setStreamingIds] = useState<ReadonlySet<string>>(() => new Set());
  const streaming = useRef(new Set<string>());
  const selectedRef = useRef<string | null>(null);
  const base = `/api/workflows/${encodeURIComponent(workflowId)}/runs`;

  const setStreaming = useCallback((runId: string, active: boolean) => {
    if (active) streaming.current.add(runId);
    else streaming.current.delete(runId);
    setStreamingIds(new Set(streaming.current));
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { runs?: RunRecord[] };
      if (Array.isArray(body.runs)) setRuns(body.runs);
    } catch {
      // Keep the last list; the next poll retries.
    } finally {
      setRunsLoading(false);
    }
  }, [base]);

  const upsertRun = useCallback((runId: string, metadata: RunMetadata) => {
    setRuns((current) => [
      { runId, metadata },
      ...current.filter((run) => run.runId !== runId),
    ].sort((a, b) => Number(b.metadata.startedAt) - Number(a.metadata.startedAt)));
  }, []);

  const upsertMessage = useCallback((runId: string, data: NodeResultData) => {
    if (selectedRef.current !== runId) return;
    setMessages((current) => [
      ...current.filter((message) => message.nodeId !== data.nodeId),
      data,
    ].sort((a, b) => a.startedAt - b.startedAt));
  }, []);

  const loadRun = useCallback(async (runId: string, signal?: AbortSignal) => {
    const response = await fetch(`${base}/${encodeURIComponent(runId)}`, { cache: "no-store", signal });
    if (!response.ok) return;
    const body = (await response.json()) as { metadata: RunMetadata; nodes: NodeResultData[] };
    // A stored snapshot never overwrites a trace that is streaming in live.
    if (selectedRef.current === runId && !streaming.current.has(runId)) setMessages(body.nodes);
    upsertRun(runId, body.metadata);
  }, [base, upsertRun]);

  const selectRun = useCallback((runId: string | null) => {
    if (runId === selectedRef.current) return;
    // Never pair the previous run's review input with the next run's action URL.
    selectedRef.current = runId;
    setMessages([]);
    setSelectedRunId(runId);
  }, []);

  // Initial list, then poll while any run is active elsewhere.
  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);
  const anyActive = runs.some((run) => run.metadata.status === "running" && !streamingIds.has(run.runId));
  useEffect(() => {
    if (!anyActive) return;
    const timer = window.setInterval(() => void refreshRuns(), RUN_LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyActive, refreshRuns]);

  // Selected run: load once, then poll while it is running and not streamed here.
  const selectedStatus = runs.find((run) => run.runId === selectedRunId)?.metadata.status;
  const selectedStreaming = selectedRunId !== null && streamingIds.has(selectedRunId);
  useEffect(() => {
    if (!selectedRunId) return;
    const controller = new AbortController();
    setLoading(true);
    void loadRun(selectedRunId, controller.signal).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [selectedRunId, loadRun]);
  useEffect(() => {
    if (!selectedRunId || selectedStatus !== "running" || selectedStreaming) return;
    const controller = new AbortController();
    const timer = window.setInterval(
      () => void loadRun(selectedRunId, controller.signal).catch(() => undefined),
      ACTIVE_RUN_POLL_MS
    );
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [selectedRunId, selectedStatus, selectedStreaming, loadRun]);

  /** Consumes a run stream; resolves with the run ID as soon as it is announced. */
  const follow = useCallback((response: Response): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      let runId: string | null = null;
      const consume = async () => {
        if (!response.body) throw new Error("The run did not stream.");
        try {
          for await (const event of readEvents(response.body)) {
            if (event.event === "start") {
              runId = event.data.runId;
              setStreaming(runId, true);
              resolve(runId);
            } else if (runId === null) {
              continue;
            } else if (event.event === "run") {
              upsertRun(runId, event.data);
            } else if (event.event === "node") {
              upsertMessage(runId, event.data);
            } else if (event.event === "done" || event.event === "failed") {
              break;
            }
          }
        } finally {
          if (runId) {
            setStreaming(runId, false);
            // Reconcile with the stored trace once the live stream ends.
            await loadRun(runId).catch(() => undefined);
          }
          await refreshRuns();
        }
        if (runId === null) throw new Error("The run ended before it was registered.");
      };
      consume().catch(reject);
    });
  }, [setStreaming, upsertRun, upsertMessage, loadRun, refreshRuns]);

  const startRun = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}?stream=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await requestError(response, "Failed to start run");
    const runId = await follow(response);
    selectRun(runId);
    return runId;
  }, [base, follow, selectRun]);

  const decideApproval = useCallback(async (runId: string, nodeId: string, decision: "approved" | "rejected") => {
    const response = await fetch(`${base}/${encodeURIComponent(runId)}/approval?stream=true`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, decision }),
    });
    if (!response.ok) throw await requestError(response, "Could not submit the decision");
    await follow(response);
  }, [base, follow]);

  const deleteRun = useCallback(async (runId: string) => {
    const response = await fetch(`${base}/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (!response.ok) throw await requestError(response, "Couldn't delete this run");
    setRuns((current) => current.filter((run) => run.runId !== runId));
  }, [base]);

  const results = useMemo(() => {
    const map = new Map<string, NodeResultData>();
    for (const message of messages) map.set(message.nodeId, message);
    return map;
  }, [messages]);

  const value = useMemo<RunContextValue>(
    () => ({
      workflowId, runs, runsLoading, refreshRuns, selectedRunId, selectRun, results, messages, isLoading,
      startRun, decideApproval, deleteRun,
    }),
    [workflowId, runs, runsLoading, refreshRuns, selectedRunId, selectRun, results, messages, isLoading, startRun, decideApproval, deleteRun]
  );

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

export function useRun(): RunContextValue {
  const context = useContext(RunContext);

  if (!context) {
    throw new Error("useRun must be used within a RunProvider");
  }

  return context;
}

export function useApprovalExpired(expiresAt: number | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    if (expiresAt === undefined) return;
    const timer = window.setTimeout(
      refresh,
      Math.max(0, Math.min(expiresAt - Date.now() + 1, 2_147_483_647))
    );
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [expiresAt]);

  return expiresAt !== undefined && now >= expiresAt;
}
