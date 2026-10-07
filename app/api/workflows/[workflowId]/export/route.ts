import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "../../../../workflow/server/auth";
import { backupFilename, exportWorkflow } from "../../../../workflow/server/backup";
import { STORAGE_TIMEOUT_MS, boundedOperation } from "../../../../workflow/server/execution-policy";
import { ApiError } from "../../../../workflow/server/request-security";

export const runtime = "nodejs";

/** Downloads one workflow as a backup file. Owner browser session only. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    if (request.headers.has("authorization")) {
      throw new ApiError(403, "Backups require the owner browser session, not an API token.");
    }
    const principal = await getPrincipal();
    if (!principal || principal.id !== "owner") throw new ApiError(401, "Sign in with the owner password.");
    const { workflowId } = await params;
    const backup = await boundedOperation(
      (signal) => exportWorkflow(workflowId, principal, signal), STORAGE_TIMEOUT_MS, request.signal
    );
    if (!backup) throw new ApiError(404, "Workflow not found.");
    return new NextResponse(JSON.stringify(backup, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${backupFilename(backup.workflows[0].name)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Workflow export failed.");
    return NextResponse.json({ error: "Unable to export this workflow. Try again later." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
