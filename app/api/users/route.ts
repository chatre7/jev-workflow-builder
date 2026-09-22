import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "../../workflow/server/auth";
import { getWorkflow } from "../../workflow/server/liveblocks";
import { ApiError } from "../../workflow/server/request-security";

export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) {
      throw new ApiError(401, "Sign in with the owner password.");
    }
    const workflowId = request.nextUrl.searchParams.get("workflowId") ?? "";
    const userIds = request.nextUrl.searchParams.getAll("userIds");
    if (
      userIds.length === 0 ||
      userIds.length > 50 ||
      userIds.some((id) => id !== principal.id)
    ) {
      throw new ApiError(400, "Only the signed-in owner can be resolved.");
    }
    if (!(await getWorkflow(workflowId, principal))) {
      throw new ApiError(404, "Workflow not found.");
    }
    const users = userIds.map(() => ({
      name: principal.name, avatar: principal.avatar, color: principal.color,
    }));
    return NextResponse.json(users, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof ApiError ? error.message : "Unable to resolve collaborators.",
      },
      {
        status: error instanceof ApiError ? error.status : 502,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
