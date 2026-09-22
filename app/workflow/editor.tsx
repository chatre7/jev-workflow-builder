"use client";

import {
  useCanRedo,
  useCanUndo,
  useRedo,
  useUndo,
  useUser,
} from "@liveblocks/react";
import {
  Cursors,
  useLiveblocksFlow,
  type CursorsCursorProps,
} from "@liveblocks/react-flow";
import { Cursor } from "@liveblocks/react-ui";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  ControlButton,
  MarkerType,
  Panel,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import {
  Bot,
  Eye,
  FileOutput,
  FileSpreadsheet,
  GitBranch,
  Globe,
  BookOpen,
  ClipboardCheck,
  Clock3,
  MessageSquareText,
  Plus,
  Redo2,
  Rows3,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import { NODE_WIDTH, nodeTypes } from "./nodes";
import { useApprovalExpired, useRun } from "./run-context";
import {
  ANY_HANDLE,
  FLOW_STORAGE_KEY,
  IN_HANDLE,
  WORKFLOW_EDGE_TYPE,
  createConditionNode,
  createCsvNode,
  createHttpNode,
  createApprovalNode,
  createKnowledgeNode,
  createInputNode,
  createJevNode,
  createLlmNode,
  createOutputNode,
  createTransformNode,
  createWorkflowEdge,
  getReachableNodeIds,
  getOutputPropertyId,
  wouldCreateCycle,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./shared";

function FlowCursor({ userId }: CursorsCursorProps) {
  const { user, isLoading } = useUser(userId);

  if (isLoading) {
    return null;
  }

  return <Cursor color={user?.color} label={user?.name} />;
}

/**
 * Shown while a run is previewed on the canvas. Exiting returns the canvas to
 * plain editing: no dimmed nodes, no highlighted path.
 */
function RunPreviewBanner() {
  const { selectedRunId, selectRun, messages } = useRun();
  const pendingExpiry = messages.reduce<number | undefined>(
    (earliest, message) =>
      message.status === "waiting" && message.approval && !message.approval.decision
        ? Math.min(earliest ?? Infinity, message.approval.expiresAt)
        : earliest,
    undefined
  );
  const expired = useApprovalExpired(pendingExpiry);

  if (selectedRunId === null) {
    return null;
  }

  const running = messages.some((message) => message.status === "running");
  const failed = messages.some((message) => message.status === "error");
  const waiting = messages.some((message) => message.status === "waiting");
  const label = failed
    ? "Run failed"
    : expired
      ? "Approval expired"
      : running
        ? "Run in progress"
        : waiting
          ? "Waiting for approval · open Runs"
          : "Run preview";

  return (
    <div className="run-preview-banner floating-surface flex items-center gap-2 py-1 pl-3 pr-1 text-xs">
      {waiting ? <Clock3 className="size-3.5 shrink-0 text-amber-700" /> : <Eye className="size-3.5 shrink-0 text-violet-600" />}
      <span className="font-medium text-neutral-800">{label}</span>
      <span className="run-preview-details text-neutral-400">
        {messages.length} node{messages.length === 1 ? "" : "s"} · Esc
      </span>
      <button
        type="button"
        onClick={() => selectRun(null)}
        className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 font-medium text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <X className="size-3.5" /> Exit preview
      </button>
    </div>
  );
}

function Toast({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div
      role="status"
      className="rounded-lg bg-neutral-900 px-3 py-2 text-xs text-white shadow-lg"
    >
      {message}
    </div>
  );
}

export function WorkflowEditor({ className, ...props }: ComponentProps<"div">) {
  const reactFlow = useReactFlow<WorkflowNode, WorkflowEdge>();
  const { results, selectedRunId, selectRun } = useRun();
  const undo = useUndo();
  const redo = useRedo();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const [toast, setToast] = useState<string | null>(null);

  const { nodes, edges, onNodesChange, onEdgesChange, onDelete } =
    useLiveblocksFlow<WorkflowNode, WorkflowEdge>({
      suspense: true,
      storageKey: FLOW_STORAGE_KEY,
    });

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedRunId !== null) {
        if (!isEditableTarget(event.target)) {
          selectRun(null);
        }
        return;
      }

      const isModZ =
        event.key.toLowerCase() === "z" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey;

      if (!isModZ || isEditableTarget(event.target)) {
        return;
      }

      if (event.shiftKey) {
        if (canRedo) {
          event.preventDefault();
          redo();
        }
      } else if (canUndo) {
        event.preventDefault();
        undo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, canUndo, canRedo, selectedRunId, selectRun]);

  const reachable = useMemo(
    () => getReachableNodeIds(nodes, edges),
    [nodes, edges]
  );

  // Display older single-input connections on the Customer handle.
  const resolvedEdges = useMemo<WorkflowEdge[]>(() => {
    const outputIds = new Set(
      nodes.filter((node) => node.type === "output").map((node) => node.id)
    );
    return edges.map((edge) =>
      outputIds.has(edge.target)
        ? { ...edge, targetHandle: getOutputPropertyId(edge.targetHandle) }
        : edge
    );
  }, [nodes, edges]);

  // The selected run's path is derived only, never written back to Storage.
  const decoratedEdges = useMemo<WorkflowEdge[]>(() => {
    return resolvedEdges.map((edge) => {
      const source = results.get(edge.source);
      const target = results.get(edge.target);
      const fired =
        source !== undefined &&
        edge.sourceHandle != null &&
        (source.firedHandles?.includes(edge.sourceHandle) ?? false) &&
        target !== undefined;
      const unreachable = !reachable.has(edge.target);

      return {
        ...edge,
        animated: fired && target?.status === "running",
        className: fired
          ? "workflow-edge-fired"
          : unreachable || (selectedRunId !== null && !fired)
            ? "workflow-edge-muted"
            : undefined,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: fired ? "#7c3aed" : "#a3a3a3",
        },
      };
    });
  }, [resolvedEdges, results, reachable, selectedRunId]);

  const decoratedNodes = useMemo<WorkflowNode[]>(() => {
    return nodes.map((node) =>
      reachable.has(node.id)
        ? node
        : { ...node, className: "workflow-node-unreachable" }
    );
  }, [nodes, reachable]);

  const isValidConnection = useCallback<IsValidConnection<WorkflowEdge>>(
    (connection: Connection | Edge) => {
      if (!connection.source || !connection.target) {
        return false;
      }

      if (wouldCreateCycle(edges, connection.source, connection.target)) {
        return false;
      }

      // A source may feed several properties, but each handle pair is unique.
      return !resolvedEdges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          edge.sourceHandle === connection.sourceHandle &&
          (edge.targetHandle ?? IN_HANDLE) ===
            (connection.targetHandle ?? IN_HANDLE)
      );
    },
    [edges, resolvedEdges]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }

      if (wouldCreateCycle(edges, connection.source, connection.target)) {
        setToast("That connection would create a loop.");
        return;
      }

      onEdgesChange([
        {
          type: "add",
          item: createWorkflowEdge({
            source: connection.source,
            sourceHandle: connection.sourceHandle ?? ANY_HANDLE,
            target: connection.target,
            targetHandle: connection.targetHandle ?? IN_HANDLE,
          }),
        },
      ]);
    },
    [edges, onEdgesChange]
  );

  const addNode = useCallback(
    (kind: WorkflowNodeType) => {
      // Place new nodes near the center of the current viewport, offset so
      // repeated clicks don't stack exactly.
      const container = document.querySelector(".react-flow");
      const width = container?.clientWidth ?? 800;
      const height = container?.clientHeight ?? 600;
      const center = reactFlow.screenToFlowPosition({
        x: width / 2,
        y: height / 2,
      });
      const jitter = (Math.random() - 0.5) * 80;
      const position = {
        x: center.x - NODE_WIDTH / 2 + jitter,
        y: center.y - 60 + jitter,
      };
      const deselect: NodeChange<WorkflowNode>[] = reactFlow
        .getNodes()
        .filter((node) => node.selected)
        .map((node) => ({ type: "select", id: node.id, selected: false }));

      let item: WorkflowNode;
      const args = { position, selected: true };
      switch (kind) {
        case "input":
          item = createInputNode(args);
          break;
        case "jev":
          item = createJevNode(args);
          break;
        case "llm":
          item = createLlmNode(args);
          break;
        case "condition":
          item = createConditionNode(args);
          break;
        case "transform":
          item = createTransformNode(args);
          break;
        case "csv":
          item = createCsvNode(args);
          break;
        case "http":
          item = createHttpNode(args);
          break;
        case "approval":
          item = createApprovalNode(args);
          break;
        case "knowledge":
          item = createKnowledgeNode(args);
          break;
        case "output":
          item = createOutputNode(args);
          break;
      }

      onNodesChange([...deselect, { type: "add", item }]);
    },
    [reactFlow, onNodesChange]
  );

  return (
    <div className={`workflow-canvas relative ${className ?? ""}`} {...props}>
      <ReactFlow<WorkflowNode, WorkflowEdge>
        nodes={decoratedNodes}
        edges={decoratedEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onDelete={onDelete}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={{
          type: WORKFLOW_EDGE_TYPE,
          markerEnd: { type: MarkerType.ArrowClosed },
        }}
        connectionLineType={ConnectionLineType.SmoothStep}
        panOnScroll
        panOnDrag={[1, 2]}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Cursors components={{ Cursor: FlowCursor }} />
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#d8d6d1"
        />
        <Controls
          orientation="horizontal"
          showInteractive={false}
          position="bottom-left"
        >
          <ControlButton
            onClick={undo}
            disabled={!canUndo}
            title="Undo"
            aria-label="Undo"
          >
            <Undo2 />
          </ControlButton>
          <ControlButton
            onClick={redo}
            disabled={!canRedo}
            title="Redo"
            aria-label="Redo"
          >
            <Redo2 />
          </ControlButton>
        </Controls>
        <Panel
          position="top-left"
          className="!right-0 flex flex-wrap items-start justify-between gap-2"
        >
          <div
            className="node-toolbar floating-surface flex max-w-full flex-wrap items-center gap-0.5 p-1"
            role="group"
            aria-label="Add a node"
          >
            <span className="hidden items-center gap-1.5 border-r border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-400 xl:flex">
              <Plus className="size-3.5" aria-hidden /> Add node
            </span>
            {nodes.some((node) => node.type === "input") ? null : (
              <button
                type="button"
                onClick={() => addNode("input")}
                className="toolbar-button hover:bg-neutral-100 hover:text-neutral-900"
              >
                <span className="toolbar-icon bg-neutral-100 text-neutral-600">
                  <MessageSquareText className="size-4" />
                </span>{" "}
                Input
              </button>
            )}
            <button
              type="button"
              onClick={() => addNode("jev")}
              className="toolbar-button hover:bg-violet-50 hover:text-violet-700"
            >
              <span className="toolbar-icon bg-violet-50 text-violet-600">
                <Sparkles className="size-4" />
              </span>{" "}
              Jev
            </button>
            <button
              type="button"
              onClick={() => addNode("llm")}
              className="toolbar-button hover:bg-sky-50 hover:text-sky-700"
            >
              <span className="toolbar-icon bg-sky-50 text-sky-600">
                <Bot className="size-4" />
              </span>{" "}
              LLM
            </button>
            <button
              type="button"
              onClick={() => addNode("condition")}
              className="toolbar-button hover:bg-amber-50 hover:text-amber-700"
            >
              <span className="toolbar-icon bg-amber-50 text-amber-600">
                <GitBranch className="size-4" />
              </span>{" "}
              Condition
            </button>
            <button
              type="button"
              onClick={() => addNode("transform")}
              className="toolbar-button hover:bg-teal-50 hover:text-teal-700"
            >
              <span className="toolbar-icon bg-teal-50 text-teal-600">
                <Rows3 className="size-4" />
              </span>{" "}
              Transform
            </button>
            <button
              type="button"
              onClick={() => addNode("csv")}
              className="toolbar-button hover:bg-teal-50 hover:text-teal-700"
            >
              <span className="toolbar-icon bg-teal-50 text-teal-600">
                <FileSpreadsheet className="size-4" />
              </span>{" "}
              CSV
            </button>
            <button
              type="button"
              onClick={() => addNode("http")}
              className="toolbar-button hover:bg-sky-50 hover:text-sky-700"
            >
              <span className="toolbar-icon bg-sky-50 text-sky-600">
                <Globe className="size-4" />
              </span>{" "}
              HTTP
            </button>
            <button
              type="button"
              onClick={() => addNode("approval")}
              className="toolbar-button hover:bg-amber-50 hover:text-amber-700"
            >
              <span className="toolbar-icon bg-amber-50 text-amber-600">
                <ClipboardCheck className="size-4" />
              </span>{" "}
              Approval
            </button>
            <button
              type="button"
              onClick={() => addNode("knowledge")}
              className="toolbar-button hover:bg-teal-50 hover:text-teal-700"
            >
              <span className="toolbar-icon bg-teal-50 text-teal-600">
                <BookOpen className="size-4" />
              </span>{" "}
              Knowledge
            </button>
            {nodes.some((node) => node.type === "output") ? null : (
              <button
                type="button"
                onClick={() => addNode("output")}
                className="toolbar-button hover:bg-emerald-50 hover:text-emerald-700"
              >
                <span className="toolbar-icon bg-emerald-50 text-emerald-600">
                  <FileOutput className="size-4" />
                </span>{" "}
                Output
              </button>
            )}
          </div>
          {selectedRunId !== null ? (
            <div className="ml-auto max-w-full">
              <RunPreviewBanner />
            </div>
          ) : null}
        </Panel>
        <Panel position="top-center">
          <Toast message={toast} />
        </Panel>
      </ReactFlow>
    </div>
  );
}
