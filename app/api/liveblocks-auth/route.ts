import { NextRequest, NextResponse } from "next/server";
import { ROOM_ID_PREFIX } from "../../workflow/shared";
import {
  getAuthConfigurationError,
  getPrincipal,
} from "../../workflow/server/auth";
import {
  getLiveblocks,
  getLiveblocksConfigurationError,
  getWorkflow,
  getWorkspaceId,
} from "../../workflow/server/liveblocks";
import {
  ApiError,
  assertSameOrigin,
  readJsonObject,
} from "../../workflow/server/request-security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const configurationError =
      getAuthConfigurationError() ?? getLiveblocksConfigurationError();
    if (configurationError) {
      throw new ApiError(503, configurationError);
    }
    const principal = await getPrincipal();
    if (!principal) {
      throw new ApiError(401, "Sign in with the owner password.");
    }
    assertSameOrigin(request);
    const { room } = await readJsonObject(request, 4096);
    if (typeof room !== "string" || room.length > 160) {
      throw new ApiError(400, "A valid workflow room is required.");
    }
    const prefix = `${ROOM_ID_PREFIX}:${getWorkspaceId()}:`;
    const workflowId = room.startsWith(prefix) ? room.slice(prefix.length) : "";
    if (!(await getWorkflow(workflowId, principal))) {
      throw new ApiError(404, "Workflow not found.");
    }
    const session = getLiveblocks().prepareSession(principal.id, {
      userInfo: {
        name: principal.name,
        avatar: principal.avatar,
        color: principal.color,
      },
    });
    session.allow(room, ["*:write"]);
    const { status, body } = await session.authorize();
    if (status !== 200) {
      throw new ApiError(502, "Unable to authorize workflow collaboration.");
    }
    return new NextResponse(body, {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ApiError
            ? error.message
            : "Unable to authorize workflow collaboration.",
      },
      {
        status: error instanceof ApiError ? error.status : 502,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
