import { after, NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "../../../../../../workflow/server/auth";
import { claimApproval } from "../../../../../../workflow/server/approvals";
import { resumeWorkflowRun } from "../../../../../../workflow/server/executor";
import { getLiveblocks, getRoomId, getWorkflow } from "../../../../../../workflow/server/liveblocks";
import { acquireRunLease } from "../../../../../../workflow/server/run-admission";
import { ApiError, assertSameOrigin, readJsonObject } from "../../../../../../workflow/server/request-security";
import { boundedOperation, STORAGE_TIMEOUT_MS } from "../../../../../../workflow/server/execution-policy";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string; runId: string }> }
) {
  try {
    // Run-only bearer tokens cannot gain approval rights by borrowing a cookie.
    if (request.headers.has("authorization")) {
      throw new ApiError(403, "Approvals require the owner browser session, not an API token.");
    }
    const principal = await getPrincipal();
    if (!principal || principal.id !== "owner") throw new ApiError(401, "Sign in with the owner password.");
    assertSameOrigin(request);
    const body = await readJsonObject(request, 4 * 1024);
    if (typeof body.nodeId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(body.nodeId) ||
        (body.decision !== "approved" && body.decision !== "rejected") ||
        Object.keys(body).some((key) => key !== "nodeId" && key !== "decision")) {
      throw new ApiError(400, "Provide only nodeId and an approved or rejected decision.");
    }
    const { workflowId, runId } = await params;
    if (!/^run-[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new ApiError(404, "Run not found.");
    const workflow = await getWorkflow(workflowId, principal);
    if (!workflow) throw new ApiError(404, "Workflow not found.");
    const roomId = getRoomId(workflowId);
    let lease;
    try {
      lease = await acquireRunLease(principal.id, roomId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && error.message.startsWith("Too many active runs")) {
        throw new ApiError(409, "This run is busy. Wait for its active phase to finish.");
      }
      throw error;
    }
    let run;
    try {
      const feed = await boundedOperation(
        (signal) => getLiveblocks().getFeed({ roomId, feedId: runId }, { signal }),
        STORAGE_TIMEOUT_MS
      );
      if (feed.metadata.status !== "waiting") throw new ApiError(409, "This run is no longer waiting for approval.");
      const expectedToken = feed.metadata.approvalToken;
      if (typeof expectedToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(expectedToken)) {
        throw new ApiError(410, "This approval checkpoint is unavailable.");
      }
      const claim = await claimApproval({
        roomId, runId, nodeId: body.nodeId, decision: body.decision, actorId: principal.id, expectedToken,
      });
      run = resumeWorkflowRun(claim);
    } catch (error) {
      await lease.release();
      throw error;
    }
    // A waiting phase resolves promptly: no lease or hosting timer spans human time.
    const trace = run.trace$.finally(() => lease.release());
    if (["1", "true"].includes(request.nextUrl.searchParams.get("wait") ?? "")) {
      const result = await trace;
      return NextResponse.json(result, {
        status: result.status === "error" ? 500 : 200,
        headers: { "Cache-Control": "no-store" },
      });
    }
    after(async () => {
      try { await trace; } catch { console.error("Workflow approval resume failed."); }
    });
    return NextResponse.json({ runId: run.runId, status: "running" }, {
      status: 202, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
          ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}),
        },
      });
    }
    console.error("Workflow approval request failed.");
    return NextResponse.json({ error: "Unable to resume this workflow. Try again later." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
