import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "../../../workflow/server/auth";
import { backupFilename, exportAllWorkflows } from "../../../workflow/server/backup";
import { STORAGE_TIMEOUT_MS, boundedOperation } from "../../../workflow/server/execution-policy";
import { ApiError } from "../../../workflow/server/request-security";

export const runtime = "nodejs";
// One storage read per workflow, bounded to STORAGE_TIMEOUT_MS each.
const EXPORT_ALL_TIMEOUT_MS = 50 * STORAGE_TIMEOUT_MS;

/** Downloads every workflow in the workspace as one backup file. Owner browser session only. */
export async function GET(request: NextRequest) {
  try {
    if (request.headers.has("authorization")) {
      throw new ApiError(403, "Backups require the owner browser session, not an API token.");
    }
    const principal = await getPrincipal();
    if (!principal || principal.id !== "owner") throw new ApiError(401, "Sign in with the owner password.");
    const backup = await boundedOperation(
      (signal) => exportAllWorkflows(principal, signal), EXPORT_ALL_TIMEOUT_MS, request.signal
    );
    return new NextResponse(JSON.stringify(backup, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${backupFilename(null)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Workspace export failed.");
    return NextResponse.json({ error: "Unable to export workflows. Try again later." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
