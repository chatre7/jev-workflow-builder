"use client";

import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
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
import { toStoredGraph, type WorkflowEdge, type WorkflowNode } from "./shared";

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export type GraphContextValue = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  saveState: SaveState;
  // Set when a save was refused or the graph was replaced by a newer version.
  notice: string | null;
  dismissNotice: () => void;
};

const GraphContext = createContext<GraphContextValue | null>(null);

const SAVE_DEBOUNCE_MS = 800;
const MAX_HISTORY = 100;

type Snapshot = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

/** Changes that are worth an undo step: everything but selection, hover and measurement. */
function isCommittingNodeChange(change: NodeChange<WorkflowNode>, dragging: boolean): boolean {
  switch (change.type) {
    case "add":
    case "remove":
    case "replace":
      return true;
    case "position":
      // One undo step per drag, recorded when it starts.
      return change.dragging === true ? !dragging : change.dragging === undefined;
    default:
      return false;
  }
}

function isCommittingEdgeChange(change: EdgeChange<WorkflowEdge>): boolean {
  return change.type === "add" || change.type === "remove" || change.type === "replace";
}

/**
 * The canvas state for one workflow: React Flow changes apply locally, every
 * change batch worth undoing is recorded, and the stored shape is saved after
 * a short pause. A save is refused when another tab saved first; the graph is
 * then reloaded from the store rather than overwritten.
 */
export function GraphProvider({
  workflowId,
  initialGraph,
  initialVersion,
  children,
}: {
  workflowId: string;
  initialGraph: Snapshot;
  initialVersion: number;
  children: ReactNode;
}) {
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialGraph.nodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(initialGraph.edges);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const version = useRef(initialVersion);
  const dragging = useRef(false);
  // The last stored text we know of; nothing is saved when it is unchanged.
  const savedText = useRef(JSON.stringify(toStoredGraph(initialGraph)));
  const latest = useRef<Snapshot>({ nodes, edges });
  latest.current = { nodes, edges };

  const record = useCallback(() => {
    const snapshot = latest.current;
    setHistory((current) => ({
      past: [...current.past.slice(-(MAX_HISTORY - 1)), snapshot],
      future: [],
    }));
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<WorkflowNode>[]) => {
    if (changes.some((change) => isCommittingNodeChange(change, dragging.current))) record();
    for (const change of changes) {
      if (change.type === "position" && change.dragging !== undefined) dragging.current = change.dragging;
    }
    setNodes((current) => applyNodeChanges(changes, current));
  }, [record]);

  const onEdgesChange = useCallback((changes: EdgeChange<WorkflowEdge>[]) => {
    if (changes.some(isCommittingEdgeChange)) record();
    setEdges((current) => applyEdgeChanges(changes, current));
  }, [record]);

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past[current.past.length - 1];
      if (!previous) return current;
      const now = latest.current;
      setNodes(previous.nodes);
      setEdges(previous.edges);
      return { past: current.past.slice(0, -1), future: [...current.future, now] };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const next = current.future[current.future.length - 1];
      if (!next) return current;
      const now = latest.current;
      setNodes(next.nodes);
      setEdges(next.edges);
      return { past: [...current.past, now], future: current.future.slice(0, -1) };
    });
  }, []);

  // Debounced autosave of the stored shape with a version check.
  const storedText = useMemo(() => JSON.stringify(toStoredGraph({ nodes, edges })), [nodes, edges]);
  useEffect(() => {
    if (storedText === savedText.current) {
      // Edits undone back to the stored shape need no save.
      setSaveState((state) => (state === "conflict" || state === "error" ? state : "saved"));
      return;
    }
    setSaveState((state) => (state === "conflict" ? state : "dirty"));
    const timer = window.setTimeout(async () => {
      const text = storedText;
      setSaveState("saving");
      try {
        const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/graph`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: `{"graph":${text},"version":${version.current}}`,
        });
        if (response.status === 409) {
          // Another tab saved first: take its version instead of overwriting it.
          const reload = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/graph`, { cache: "no-store" });
          if (reload.ok) {
            const stored = (await reload.json()) as { graph: Snapshot; version: number };
            version.current = stored.version;
            savedText.current = JSON.stringify(toStoredGraph(stored.graph));
            setNodes(stored.graph.nodes);
            setEdges(stored.graph.edges);
            setHistory({ past: [], future: [] });
            setNotice("This workflow was changed in another tab. The canvas now shows that version.");
            setSaveState("saved");
          } else {
            setSaveState("conflict");
            setNotice("This workflow was changed elsewhere and could not be reloaded. Refresh the page.");
          }
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setSaveState("error");
          setNotice(body.error ?? `Saving failed (${response.status}). Changes stay on this canvas; edit again to retry.`);
          return;
        }
        const saved = (await response.json()) as { version: number };
        version.current = saved.version;
        savedText.current = text;
        setSaveState(latest.current && JSON.stringify(toStoredGraph(latest.current)) === text ? "saved" : "dirty");
      } catch {
        setSaveState("error");
        setNotice("Saving failed. Check your connection; changes stay on this canvas and save on the next edit.");
      }
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [storedText, workflowId]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (saveState === "saved") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<GraphContextValue>(() => ({
    nodes, edges, onNodesChange, onEdgesChange, undo, redo,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    saveState, notice, dismissNotice,
  }), [nodes, edges, onNodesChange, onEdgesChange, undo, redo, history, saveState, notice, dismissNotice]);

  return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>;
}

export function useGraph(): GraphContextValue {
  const context = useContext(GraphContext);
  if (!context) throw new Error("useGraph must be used within a GraphProvider");
  return context;
}
