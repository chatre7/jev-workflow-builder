import { after, NextRequest, NextResponse } from "next/server";
import type { RunTrigger } from "../../../../workflow/runs";
import { MAX_INPUT_CHARS, MAX_QUESTION_CHARS, getReachableNodeIds } from "../../../../workflow/shared";
import { startWorkflowRun } from "../../../../workflow/server/executor";
import { getRoomId, getWorkflow, listRuns, readWorkflowGraph } from "../../../../workflow/server/store";
import { ExecutionError, STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../workflow/server/execution-policy";
import { validateWorkflowGraph, type ValidatedWorkflowGraph } from "../../../../workflow/server/execution-validation";
import { acquireRunLease } from "../../../../workflow/server/run-admission";
import {
  ApiError,
  authenticateOwnerRequest,
  authenticateRunRequest,
  readJsonObject,
} from "../../../../workflow/server/request-security";
import { createRunEventStream } from "../../../../workflow/server/sse";

export const runtime = "nodejs";
export const maxDuration = 120;

function errorResponse(error: unknown, fallback: string, request?: Request): NextResponse {
  // A client that navigated away is not a server fault worth logging.
  if (request?.signal.aborted) return new NextResponse(null, { status: 499 });
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}),
      },
    });
  }
  console.error(fallback);
  return NextResponse.json({ error: `${fallback} Try again later.` }, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Lists this workflow's stored runs, newest first. Owner browser session only. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const principal = await authenticateOwnerRequest(request, "Run history");
    const { workflowId } = await params;
    if (!(await getWorkflow(workflowId, principal))) throw new ApiError(404, "Workflow not found.");
    const runs = await boundedOperation(() => listRuns(workflowId), STORAGE_TIMEOUT_MS, request.signal);
    return NextResponse.json({ runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to list runs.", request);
  }
}

/**
 * Authenticated test runs use the browser session and same-origin requests.
 * Automation uses Authorization: Bearer WORKFLOW_API_TOKEN (run-only access).
 * Add ?wait=true for the final trace, ?stream=true for Server-Sent Events of
 * each node as it runs; otherwise progress is read from the run store.
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
    if (body.input.length > MAX_INPUT_CHARS) {
      throw new ApiError(413, "`input` must be at most 20,000 characters.");
    }
    if (body.question !== undefined && typeof body.question !== "string") {
      throw new ApiError(400, "`question` must be a string.");
    }
    if (typeof body.question === "string" && body.question.length > MAX_QUESTION_CHARS) {
      throw new ApiError(413, "`question` must be at most 4,000 characters.");
    }
    const question = typeof body.question === "string" && body.question.trim() ? body.question : undefined;
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
    let graph: ValidatedWorkflowGraph | undefined;
    if (question) {
      const snapshot = await boundedOperation(
        (signal) => readWorkflowGraph(roomId, signal), STORAGE_TIMEOUT_MS
      );
      try {
        graph = validateWorkflowGraph(snapshot);
        const { nodes, edges } = graph;
        const reachable = getReachableNodeIds(nodes, edges);
        if (!nodes.some((node) => node.type === "llm" && reachable.has(node.id))) {
          throw new ApiError(400, "A run question requires an LLM node reachable from Input.");
        }
      } catch (error) {
        if (error instanceof ExecutionError) throw new ApiError(400, error.message);
        throw error;
      }
    }
    const trigger: RunTrigger = principal.id === "api:automation" ? "api"
      : body.trigger === "test" ? "test" : "api";
    const flag = (name: string) => ["1", "true"].includes(request.nextUrl.searchParams.get(name) ?? "");
    const stream = flag("stream") ? createRunEventStream() : undefined;
    const lease = await acquireRunLease(principal.id, roomId);
    let run;
    try {
      run = startWorkflowRun({ roomId, input: body.input, question, trigger, graph, onEvent: stream?.emit });
    } catch (error) {
      await lease.release();
      throw error;
    }
    // Hold the distributed reservation through actual completion, not just HTTP 202.
    const trace = run.trace$.finally(() => lease.release());
    if (stream) {
      stream.start(run.runId);
      // The run keeps going if the client disconnects; the store has the trace.
      after(async () => {
        try {
          stream.finish(await trace);
        } catch {
          stream.fail("Workflow execution failed.");
        }
      });
      return stream.response();
    }
    if (flag("wait")) {
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
    return errorResponse(error, "Unable to run this workflow.", request);
  }
}
