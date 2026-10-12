import { after, NextRequest, NextResponse } from "next/server";
import { MAX_INPUT_CHARS } from "../../../../workflow/shared";
import { startWorkflowRun } from "../../../../workflow/server/executor";
import { STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../workflow/server/execution-policy";
import { acquireRunLease } from "../../../../workflow/server/run-admission";
import { ApiError, readBodyText } from "../../../../workflow/server/request-security";
import { getRoomId, verifyWebhookSecret } from "../../../../workflow/server/store";
import { webhookInput } from "../../../../workflow/server/webhook-input";

export const runtime = "nodejs";
export const maxDuration = 120;

// Webhook callers have their own admission budget, separate from the owner's.
const WEBHOOK_PRINCIPAL = "webhook";
const MAX_WEBHOOK_BYTES = 96 * 1024;

function json(body: unknown, status: number, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

/**
 * Starts a run from an external service. The secret in the path is the only
 * credential: no cookie, origin or bearer token is consulted, so a browser
 * session cannot be borrowed to reach it. Unknown workflows and wrong secrets
 * answer the same 404, so the URL reveals nothing without its secret.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string; secret: string }> }
) {
  try {
    const { workflowId, secret } = await params;
    const verified = await boundedOperation(() => verifyWebhookSecret(workflowId, secret), STORAGE_TIMEOUT_MS);
    if (!verified) throw new ApiError(404, "Not found.");
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    const input = webhookInput(await readBodyText(request, MAX_WEBHOOK_BYTES), contentType);
    if (typeof input !== "string" || !input.trim()) throw new ApiError(400, "The webhook body produced an empty input.");
    if (input.length > MAX_INPUT_CHARS) throw new ApiError(413, `Input must be at most ${MAX_INPUT_CHARS.toLocaleString()} characters.`);

    const roomId = getRoomId(workflowId);
    const lease = await acquireRunLease(WEBHOOK_PRINCIPAL, roomId);
    let run;
    try {
      run = startWorkflowRun({ roomId, input, trigger: "webhook" });
    } catch (error) {
      await lease.release();
      throw error;
    }
    const trace = run.trace$.finally(() => lease.release());
    if (["1", "true"].includes(request.nextUrl.searchParams.get("wait") ?? "")) {
      const result = await trace;
      return json(result, result.status === "error" ? 500 : 200);
    }
    after(async () => {
      try { await trace; } catch { console.error("Webhook workflow run failed."); }
    });
    return json({ runId: run.runId, status: "running" }, 202);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message }, error.status, error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {});
    }
    console.error("Webhook request failed.");
    return json({ error: "Unable to run this workflow. Try again later." }, 503);
  }
}
