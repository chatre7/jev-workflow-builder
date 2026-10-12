import { NextRequest, NextResponse } from "next/server";
import { getHealthReport } from "../../workflow/server/health";
import { ApiError, authenticateOwnerRequest } from "../../workflow/server/request-security";

export const runtime = "nodejs";

/** Storage and provider status for the owner. `?fresh=true` skips the one-minute cache. */
export async function GET(request: NextRequest) {
  try {
    await authenticateOwnerRequest(request, "Service status");
    const fresh = ["1", "true"].includes(request.nextUrl.searchParams.get("fresh") ?? "");
    return NextResponse.json(await getHealthReport({ fresh }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Health check failed.");
    return NextResponse.json({ error: "Unable to check service status." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
