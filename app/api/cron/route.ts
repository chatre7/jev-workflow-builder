import { createHash, timingSafeEqual } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { startWorkflowRun } from "../../workflow/server/executor";
import { STORAGE_TIMEOUT_MS, boundedOperation } from "../../workflow/server/execution-policy";
import { acquireRunLease } from "../../workflow/server/run-admission";
import { ApiError } from "../../workflow/server/request-security";
import { claimDueSchedules, getRoomId } from "../../workflow/server/store";

export const runtime = "nodejs";
export const maxDuration = 120;

// Scheduled runs share one admission identity and stay within its concurrency.
const SCHEDULER_PRINCIPAL = "scheduler";
const MAX_RUNS_PER_TICK = 2;

function authorize(request: Request): void {
  const configured = process.env.CRON_SECRET;
  if (!configured || configured.length < 32 || configured.length > 256) {
    throw new ApiError(503, "Scheduled runs are disabled. Set CRON_SECRET (32–256 characters).");
  }
  const supplied = /^Bearer ([^\s]{32,256})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const expected = createHash("sha256").update(configured).digest();
  const actual = createHash("sha256").update(supplied ?? "").digest();
  if (!supplied || !timingSafeEqual(expected, actual)) throw new ApiError(401, "Invalid scheduler credentials.");
}

/**
 * One scheduler tick: claims the schedules that are due and starts their runs.
 * Call it every few minutes from Vercel Cron (GET, `Authorization: Bearer
 * $CRON_SECRET`), GitHub Actions or any external cron service. A tick that
 * finds the admission limits full skips that occurrence; it is not queued.
 */
async function tick(request: NextRequest): Promise<NextResponse> {
  try {
    authorize(request);
    const due = await boundedOperation(() => claimDueSchedules(Date.now(), MAX_RUNS_PER_TICK), STORAGE_TIMEOUT_MS);
    const started: { workflowId: string; runId: string }[] = [];
    const skipped: { workflowId: string; reason: string }[] = [];
    const traces: Promise<unknown>[] = [];
    for (const item of due) {
      let lease;
      try {
        lease = await acquireRunLease(SCHEDULER_PRINCIPAL, getRoomId(item.workflowId));
      } catch (error) {
        skipped.push({ workflowId: item.workflowId, reason: error instanceof ApiError ? error.message : "Admission is unavailable." });
        continue;
      }
      try {
        const run = startWorkflowRun({ roomId: getRoomId(item.workflowId), input: item.schedule.input, trigger: "schedule" });
        started.push({ workflowId: item.workflowId, runId: run.runId });
        traces.push(run.trace$.finally(() => lease.release()));
      } catch {
        await lease.release();
        skipped.push({ workflowId: item.workflowId, reason: "The run could not start." });
      }
    }
    after(async () => {
      const results = await Promise.allSettled(traces);
      if (results.some((result) => result.status === "rejected")) console.error("A scheduled workflow run failed.");
    });
    return NextResponse.json({ started, skipped }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Scheduler tick failed.");
    return NextResponse.json({ error: "Scheduler tick failed." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = tick;
export const POST = tick;
