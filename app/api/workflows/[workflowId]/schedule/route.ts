import { NextRequest, NextResponse } from "next/server";
import { STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../workflow/server/execution-policy";
import { ApiError, assertSameOrigin, authenticateOwnerRequest, readJsonObject } from "../../../../workflow/server/request-security";
import { deleteSchedule, getSchedule, setSchedule } from "../../../../workflow/server/store";

export const runtime = "nodejs";

type Context = { params: Promise<{ workflowId: string }> };
const owner = (request: NextRequest) => authenticateOwnerRequest(request, "Schedule settings");

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  console.error("Schedule settings request failed.");
  return NextResponse.json({ error: "Unable to update the schedule. Try again later." }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
}

const scheduler = () => ({ schedulerConfigured: (process.env.CRON_SECRET ?? "").length >= 32 });

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const principal = await owner(request);
    const { workflowId } = await params;
    const stored = await boundedOperation(() => getSchedule(workflowId, principal), STORAGE_TIMEOUT_MS, request.signal);
    return NextResponse.json({ ...stored, ...scheduler() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const principal = await owner(request);
    assertSameOrigin(request);
    const body = await readJsonObject(request);
    if (Object.keys(body).some((key) => key !== "schedule")) throw new ApiError(400, "Provide only schedule.");
    const { workflowId } = await params;
    const stored = await boundedOperation(() => setSchedule(workflowId, principal, body.schedule), STORAGE_TIMEOUT_MS);
    return NextResponse.json({ ...stored, ...scheduler() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const principal = await owner(request);
    assertSameOrigin(request);
    const { workflowId } = await params;
    await boundedOperation(() => deleteSchedule(workflowId, principal), STORAGE_TIMEOUT_MS);
    return NextResponse.json({ schedule: null, nextRunAt: null, ...scheduler() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
