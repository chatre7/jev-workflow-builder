"use server";

import { redirect } from "next/navigation";
import { requirePrincipal } from "./server/auth";
import {
  createWorkflow,
  listWorkflows,
  renameWorkflow,
  type WorkflowSummary,
} from "./server/liveblocks";

export async function createWorkflowAction(): Promise<void> {
  const workflow = await createWorkflow(await requirePrincipal(), {
    name: "Untitled workflow",
  });
  redirect(`/w/${workflow.workflowId}`);
}

export async function renameWorkflowAction(
  workflowId: string,
  name: string
): Promise<void> {
  await renameWorkflow(workflowId, await requirePrincipal(), name);
}

export async function listWorkflowsAction(): Promise<WorkflowSummary[]> {
  return listWorkflows(await requirePrincipal());
}
