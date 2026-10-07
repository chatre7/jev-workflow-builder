import { notFound } from "next/navigation";
import { WorkflowApp } from "../../workflow/workflow-app";
import { requirePrincipal } from "../../workflow/server/auth";
import { getWorkflow, getWorkflowGraph } from "../../workflow/server/store";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  const principal = await requirePrincipal();
  const workflow = await getWorkflow(workflowId, principal);
  const stored = workflow ? await getWorkflowGraph(workflowId, principal) : null;

  if (!workflow || !stored) {
    notFound();
  }

  return (
    <WorkflowApp
      workflow={workflow}
      initialGraph={stored.graph}
      initialVersion={stored.version}
    />
  );
}
