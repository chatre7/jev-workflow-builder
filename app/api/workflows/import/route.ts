import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "../../../workflow/server/auth";
import { importWorkflows, parseBackup } from "../../../workflow/server/backup";
import { ExecutionError } from "../../../workflow/server/execution-policy";
import { ApiError, assertSameOrigin, readJsonObject } from "../../../workflow/server/request-security";

export const runtime = "nodejs";
// Fits serverless request limits; larger backups are restored one workflow at a time.
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

/** Restores a backup file as new workflows. Never overwrites existing ones. */
export async function POST(request: NextRequest) {
  try {
    if (request.headers.has("authorization")) {
      throw new ApiError(403, "Backups require the owner browser session, not an API token.");
    }
    const principal = await getPrincipal();
    if (!principal || principal.id !== "owner") throw new ApiError(401, "Sign in with the owner password.");
    assertSameOrigin(request);
    const body = await readJsonObject(request, MAX_IMPORT_BYTES);
    const workflows = parseBackup(body);
    const created = await importWorkflows(principal, workflows);
    return NextResponse.json({
      workflows: created.map(({ workflowId, name }) => ({ workflowId, name })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ApiError || error instanceof ExecutionError) {
      return NextResponse.json({ error: error.message }, {
        status: error instanceof ApiError ? error.status : 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    console.error("Workflow import failed.");
    return NextResponse.json({ error: "Unable to import this backup. Try again later." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
