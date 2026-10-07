import { NextRequest, NextResponse } from "next/server";
import { ExecutionError, STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../workflow/server/execution-policy";
import { ApiError, assertSameOrigin, authenticateOwnerRequest, readJsonObject } from "../../../../workflow/server/request-security";
import {
  MAX_GRAPH_STORAGE_CHARS,
  getWorkflow,
  getWorkflowGraph,
  saveWorkflowGraph,
} from "../../../../workflow/server/store";

export const runtime = "nodejs";
// Stored graph plus JSON envelope, as UTF-8.
const MAX_SAVE_BYTES = MAX_GRAPH_STORAGE_CHARS * 3 + 4_096;

const owner = (request: NextRequest) => authenticateOwnerRequest(request, "Editing");

function errorResponse(error: unknown, fallback: string, request?: Request): NextResponse {
  // A client that navigated away is not a server fault worth logging.
  if (request?.signal.aborted) return new NextResponse(null, { status: 499 });
  if (error instanceof ApiError || error instanceof ExecutionError) {
    return NextResponse.json({ error: error.message }, {
      status: error instanceof ApiError ? error.status : 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  console.error(fallback);
  return NextResponse.json({ error: `${fallback} Try again later.` }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

/** The saved graph and its version, for reloading after a conflict. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const principal = await owner(request);
    const { workflowId } = await params;
    const stored = await boundedOperation(() => getWorkflowGraph(workflowId, principal), STORAGE_TIMEOUT_MS, request.signal);
    if (!stored) throw new ApiError(404, "Workflow not found.");
    return NextResponse.json(stored, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to load this workflow.", request);
  }
}

/**
 * Saves the canvas. `version` must match the stored version, so an editor
 * that fell behind another tab gets 409 and reloads instead of overwriting.
 * Shape and size are checked here; execution rules apply when a run starts.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const principal = await owner(request);
    assertSameOrigin(request);
    const body = await readJsonObject(request, MAX_SAVE_BYTES);
    const { graph, version } = body;
    if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Number.isSafeInteger(version)
        || Object.keys(body).some((key) => key !== "graph" && key !== "version")) {
      throw new ApiError(400, "Provide graph and version.");
    }
    const { nodes, edges } = graph as Record<string, unknown>;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new ApiError(400, "A graph has nodes and edges.");
    for (const node of nodes) {
      if (!node || typeof node !== "object" || typeof (node as { id?: unknown }).id !== "string"
          || typeof (node as { type?: unknown }).type !== "string"
          || !(node as { position?: { x?: unknown; y?: unknown } }).position
          || !Number.isFinite((node as { position: { x: unknown } }).position.x)
          || !Number.isFinite((node as { position: { y: unknown } }).position.y)
          || !(node as { data?: unknown }).data || typeof (node as { data: unknown }).data !== "object") {
        throw new ApiError(400, "Every node needs an id, type, position and data.");
      }
    }
    for (const edge of edges) {
      if (!edge || typeof edge !== "object" || typeof (edge as { id?: unknown }).id !== "string"
          || typeof (edge as { source?: unknown }).source !== "string" || typeof (edge as { target?: unknown }).target !== "string") {
        throw new ApiError(400, "Every connection needs an id, source and target.");
      }
    }
    const { workflowId } = await params;
    if (!(await getWorkflow(workflowId, principal))) throw new ApiError(404, "Workflow not found.");
    const saved = await boundedOperation(
      () => saveWorkflowGraph(workflowId, principal, graph as { nodes: never[]; edges: never[] }, version as number),
      STORAGE_TIMEOUT_MS, request.signal
    );
    return NextResponse.json(saved, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to save this workflow.", request);
  }
}
