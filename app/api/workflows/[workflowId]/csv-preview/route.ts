import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "../../../../workflow/server/auth";
import { convertCsv } from "../../../../workflow/server/csv";
import { getRoomId, getWorkflow, readWorkflowGraph } from "../../../../workflow/server/liveblocks";
import { ApiError, assertSameOrigin, readJsonObject } from "../../../../workflow/server/request-security";
import { ExecutionError, STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../workflow/server/execution-policy";
import { INPUT_NODE_ID, IN_HANDLE, OUT_HANDLE, MAX_INPUT_CHARS } from "../../../../workflow/shared";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    if (request.headers.has("authorization")) {
      throw new ApiError(403, "CSV previews require the owner browser session, not an API token.");
    }
    const principal = await getPrincipal();
    if (!principal || principal.id !== "owner") throw new ApiError(401, "Sign in with the owner password.");
    assertSameOrigin(request);
    const body = await readJsonObject(request);
    if (typeof body.input !== "string" || typeof body.nodeId !== "string" ||
        !/^[A-Za-z0-9_-]{1,96}$/.test(body.nodeId) ||
        Object.keys(body).some((key) => key !== "input" && key !== "nodeId")) {
      throw new ApiError(400, "Provide CSV text in input and the CSV nodeId.");
    }
    if (body.input.length > MAX_INPUT_CHARS) {
      throw new ApiError(413, `CSV input must be at most ${MAX_INPUT_CHARS.toLocaleString("en-US")} UTF-16 units.`);
    }
    const { workflowId } = await params;
    if (!await getWorkflow(workflowId, principal)) throw new ApiError(404, "Workflow not found.");
    const graph = await boundedOperation(
      (signal) => readWorkflowGraph(getRoomId(workflowId), signal), STORAGE_TIMEOUT_MS, request.signal
    );
    const node = graph.nodes.find((candidate) => candidate.id === body.nodeId);
    const incoming = graph.edges.filter((edge) => edge.target === body.nodeId);
    if (node?.type !== "csv" || !graph.nodes.some((candidate) => candidate.id === INPUT_NODE_ID && candidate.type === "input") ||
        incoming.length === 0 || incoming.some((edge) => edge.source !== INPUT_NODE_ID || edge.sourceHandle !== OUT_HANDLE ||
          (edge.targetHandle ?? IN_HANDLE) !== IN_HANDLE)) {
      throw new ApiError(400, "Preview requires a CSV node connected directly from Input, with no other incoming source.");
    }
    if (!node.data || (node.data.delimiter !== "," && node.data.delimiter !== ";" && node.data.delimiter !== "\t") ||
        typeof node.data.headers !== "boolean") {
      throw new ApiError(400, "Choose a valid delimiter and header mode in the CSV node.");
    }
    // Use the execution parser on the complete input; only the returned view is sampled.
    const result = convertCsv(node.data, body.input);
    const columns = node.data.headers ? result.columnNames.slice(0, 8)
      : Array.from({ length: Math.min(result.columnCount, 8) }, (_, index) => `Column ${index + 1}`);
    const rows = result.records.slice(0, 5).map((row) => Array.isArray(row)
      ? row.slice(0, 8) : columns.map((column) => row[column]));
    return NextResponse.json({
      rowCount: result.rowCount, columnCount: result.columnCount,
      headers: node.data.headers, delimiter: node.data.delimiter, columns, rows,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ApiError || error instanceof ExecutionError) {
      return NextResponse.json({ error: error.message }, {
        status: error instanceof ApiError ? error.status : 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    console.error("CSV preview failed.");
    return NextResponse.json({ error: "Unable to preview this CSV. Try again." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
