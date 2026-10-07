"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { WorkflowEditor } from "./editor";
import { GraphProvider } from "./graph-context";
import { WorkflowHeader } from "./header";
import { RunProvider } from "./run-context";
import type { WorkflowSummary } from "./server/store";
import type { WorkflowEdge, WorkflowNode } from "./shared";
import { SidePanel } from "./side-panel";

export function WorkflowApp({
  workflow,
  initialGraph,
  initialVersion,
}: {
  workflow: WorkflowSummary;
  initialGraph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  initialVersion: number;
}) {
  return (
    <GraphProvider
      key={workflow.workflowId}
      workflowId={workflow.workflowId}
      initialGraph={initialGraph}
      initialVersion={initialVersion}
    >
      <ReactFlowProvider>
        <RunProvider workflowId={workflow.workflowId}>
          <div className="flex h-dvh flex-col overflow-hidden text-neutral-900">
            <WorkflowHeader workflow={workflow} />
            <div className="workspace-body flex min-h-0 flex-1">
              <WorkflowEditor className="min-w-0 flex-1" />
              <SidePanel workflow={workflow} />
            </div>
          </div>
        </RunProvider>
      </ReactFlowProvider>
    </GraphProvider>
  );
}
