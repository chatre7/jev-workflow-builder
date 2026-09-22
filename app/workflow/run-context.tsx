"use client";

import { useFeedMessages, useUpdateMyPresence } from "@liveblocks/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { NodeResultData } from "./runs";

export type RunContextValue = {
  selectedRunId: string | null;
  selectRun: (runId: string | null) => void;
  // Latest result per node id for the selected run.
  results: ReadonlyMap<string, NodeResultData>;
  // All messages of the selected run, oldest first.
  messages: readonly NodeResultData[];
  isLoading: boolean;
};

const RunContext = createContext<RunContextValue | null>(null);

/**
 * Holds the run selected in the side panel and its feed messages, so both the
 * panel (trace) and the canvas (highlighted path) read from one place.
 */
export function RunProvider({ children }: { children: ReactNode }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly NodeResultData[]>([]);
  const [isLoading, setLoading] = useState(false);
  const updateMyPresence = useUpdateMyPresence();
  const selectRun = useCallback((runId: string | null) => {
    if (runId === selectedRunId) return;
    // Never pair the previous run's review input with the next run's action URL.
    setMessages([]);
    setSelectedRunId(runId);
  }, [selectedRunId]);

  useEffect(() => {
    updateMyPresence({ selectedRunId });
  }, [selectedRunId, updateMyPresence]);

  const results = useMemo(() => {
    const map = new Map<string, NodeResultData>();

    for (const message of messages) {
      map.set(message.nodeId, message);
    }

    return map;
  }, [messages]);

  const value = useMemo<RunContextValue>(
    () => ({
      selectedRunId,
      selectRun,
      results,
      messages,
      isLoading,
    }),
    [selectedRunId, selectRun, results, messages, isLoading]
  );

  return (
    <RunContext.Provider value={value}>
      {selectedRunId ? (
        <RunMessagesLoader
          key={selectedRunId}
          runId={selectedRunId}
          onChange={setMessages}
          onLoading={setLoading}
        />
      ) : (
        <ClearMessages onChange={setMessages} />
      )}
      {children}
    </RunContext.Provider>
  );
}

function ClearMessages({
  onChange,
}: {
  onChange: (messages: readonly NodeResultData[]) => void;
}) {
  useEffect(() => {
    onChange([]);
  }, [onChange]);

  return null;
}

/**
 * Subscribes to the selected run's feed. Rendered as its own component so the
 * hook can be (un)mounted when the selection changes.
 */
function RunMessagesLoader({
  runId,
  onChange,
  onLoading,
}: {
  runId: string;
  onChange: (messages: readonly NodeResultData[]) => void;
  onLoading: (isLoading: boolean) => void;
}) {
  const result = useFeedMessages(runId);

  useEffect(() => {
    onLoading(result.isLoading);
  }, [result.isLoading, onLoading]);

  useEffect(() => {
    if (result.messages) {
      onChange(
        [...result.messages]
          .map((message) => message.data)
          .sort((a, b) => a.startedAt - b.startedAt)
      );
    }
  }, [result.messages, onChange]);

  return null;
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
