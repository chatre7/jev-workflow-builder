import { notFound } from "next/navigation";
import { WorkflowApp } from "../../workflow/workflow-app";
import { requirePrincipal } from "../../workflow/server/auth";
import { getRoomId, getWorkflow } from "../../workflow/server/liveblocks";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  const principal = await requirePrincipal();
  const workflow = await getWorkflow(workflowId, principal);

  if (!workflow) {
    notFound();
  }

  return (
    <WorkflowApp
      roomId={getRoomId(workflowId)}
      workflow={workflow}
    />
  );
}
