import { NextRequest, NextResponse } from "next/server";
import { STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../workflow/server/execution-policy";
import { ApiError, assertSameOrigin, authenticateOwnerRequest } from "../../../../workflow/server/request-security";
import { disableWebhook, isWebhookEnabled, rotateWebhookSecret } from "../../../../workflow/server/store";

export const runtime = "nodejs";

type Context = { params: Promise<{ workflowId: string }> };
const owner = (request: NextRequest) => authenticateOwnerRequest(request, "Webhook settings");

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  console.error("Webhook settings request failed.");
  return NextResponse.json({ error: "Unable to update webhook settings. Try again later." }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
}

/** Whether a webhook URL is active. The secret itself is never readable again. */
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const principal = await owner(request);
    const { workflowId } = await params;
    const enabled = await boundedOperation(() => isWebhookEnabled(workflowId, principal), STORAGE_TIMEOUT_MS, request.signal);
    return NextResponse.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Creates a new secret, replacing any previous one, and returns it once. */
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const principal = await owner(request);
    assertSameOrigin(request);
    const { workflowId } = await params;
    const secret = await boundedOperation(() => rotateWebhookSecret(workflowId, principal), STORAGE_TIMEOUT_MS);
    return NextResponse.json({ enabled: true, secret }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const principal = await owner(request);
    assertSameOrigin(request);
    const { workflowId } = await params;
    await boundedOperation(() => disableWebhook(workflowId, principal), STORAGE_TIMEOUT_MS);
    return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
