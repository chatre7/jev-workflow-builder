import { after, NextRequest, NextResponse } from "next/server";
import type { RunTrigger } from "../../../../workflow/runs";
import { startWorkflowRun } from "../../../../workflow/server/executor";
import { getRoomId, getWorkflow } from "../../../../workflow/server/liveblocks";
import { acquireRunLease } from "../../../../workflow/server/run-admission";
import {
  ApiError,
  authenticateRunRequest,
  readJsonObject,
} from "../../../../workflow/server/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Authenticated test runs use the browser session and same-origin requests.
 * Automation uses Authorization: Bearer WORKFLOW_API_TOKEN (run-only access).
 * Add ?wait=true for the final trace; otherwise progress is delivered by feeds.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const principal = await authenticateRunRequest(request);
    const body = await readJsonObject(request);
    if (typeof body.input !== "string" || body.input.trim() === "") {
      throw new ApiError(400, "`input` must be a non-empty string.");
    }
    if (body.input.length > 20_000) {
      throw new ApiError(413, "`input` must be at most 20,000 characters.");
    }
    if (body.trigger !== undefined && body.trigger !== "test" && body.trigger !== "api") {
      throw new ApiError(400, "`trigger` must be test or api.");
    }
    if (request.nextUrl.searchParams.has("exampleId")) {
      throw new ApiError(400, "Client-selected workspace namespaces are not supported.");
    }
    const { workflowId } = await params;
    const workflow = await getWorkflow(workflowId, principal);
    if (!workflow) throw new ApiError(404, "Workflow not found.");

    const roomId = getRoomId(workflowId);
    const trigger: RunTrigger = principal.id === "api:automation" ? "api"
      : body.trigger === "test" ? "test" : "api";
    const lease = await acquireRunLease(principal.id, roomId);
    let run;
    try {
      run = startWorkflowRun({ roomId, input: body.input, trigger });
    } catch (error) {
      await lease.release();
      throw error;
    }
    // Hold the distributed reservation through actual completion, not just HTTP 202.
    const trace = run.trace$.finally(() => lease.release());
    const wait = ["1", "true"].includes(request.nextUrl.searchParams.get("wait") ?? "");
    if (wait) {
      const result = await trace;
      return NextResponse.json(result, {
        status: result.status === "error" ? 500 : 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    after(async () => {
      try {
        await trace;
      } catch {
        console.error("Workflow execution failed.");
      }
    });
    return NextResponse.json({ runId: run.runId, status: "running" }, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
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
    console.error("Workflow request failed.");
    return NextResponse.json({ error: "Unable to run this workflow. Try again later." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
