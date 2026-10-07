import { NextRequest, NextResponse } from "next/server";
import { STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../../workflow/server/execution-policy";
import { ApiError, assertSameOrigin, authenticateOwnerRequest } from "../../../../../workflow/server/request-security";
import { deleteRun, getRun, getWorkflow } from "../../../../../workflow/server/store";

export const runtime = "nodejs";

async function authorize(
  request: NextRequest,
  params: Promise<{ workflowId: string; runId: string }>
): Promise<{ workflowId: string; runId: string }> {
  const principal = await authenticateOwnerRequest(request, "Run history");
  const { workflowId, runId } = await params;
  if (!/^run-[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new ApiError(404, "Run not found.");
  if (!(await getWorkflow(workflowId, principal))) throw new ApiError(404, "Workflow not found.");
  return { workflowId, runId };
}

function errorResponse(error: unknown, fallback: string, request?: Request): NextResponse {
  // A client that navigated away is not a server fault worth logging.
  if (request?.signal.aborted) return new NextResponse(null, { status: 499 });
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  console.error(fallback);
  return NextResponse.json({ error: `${fallback} Try again later.` }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

/** One run's metadata and every node trace written so far. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string; runId: string }> }
) {
  try {
    const { workflowId, runId } = await authorize(request, params);
    const run = await boundedOperation(() => getRun(workflowId, runId), STORAGE_TIMEOUT_MS, request.signal);
    if (!run) throw new ApiError(404, "Run not found.");
    return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to load this run.", request);
  }
}

/** Deletes a finished run. A running run keeps its lease and its record. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string; runId: string }> }
) {
  try {
    assertSameOrigin(request);
    const { workflowId, runId } = await authorize(request, params);
    const deleted = await boundedOperation(() => deleteRun(workflowId, runId), STORAGE_TIMEOUT_MS, request.signal);
    if (!deleted) throw new ApiError(409, "Wait for this run to finish before deleting it.");
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to delete this run.", request);
  }
}
