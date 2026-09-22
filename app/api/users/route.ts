import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "../../workflow/server/auth";
import {
  getLiveblocks,
  getRoomId,
  getWorkflow,
} from "../../workflow/server/liveblocks";
import { ApiError } from "../../workflow/server/request-security";

export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) {
      throw new ApiError(401, "Sign in with an authorized GitHub account.");
    }
    const workflowId = request.nextUrl.searchParams.get("workflowId") ?? "";
    const userIds = request.nextUrl.searchParams.getAll("userIds");
    if (
      userIds.length === 0 ||
      userIds.length > 50 ||
      userIds.some((id) => !/^github:[1-9]\d{0,19}$/.test(id))
    ) {
      throw new ApiError(400, "Request between 1 and 50 valid collaborator IDs.");
    }
    if (!(await getWorkflow(workflowId, principal))) {
      throw new ApiError(404, "Workflow not found.");
    }
    const { data } = await getLiveblocks().getActiveUsers(getRoomId(workflowId));
    const connected = new Map(data.map((user) => [user.id, user.info]));
    const users = userIds.map((id) =>
      id === principal.id
        ? { name: principal.name, avatar: principal.avatar, color: principal.color }
        : connected.get(id) ?? null
    );
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
