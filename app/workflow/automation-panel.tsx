"use client";

import { CalendarClock, Check, Copy, Loader2, Webhook } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { MAX_INPUT_CHARS } from "./shared";

const SERVER_ORIGIN = "http://localhost:3000";
const subscribeNever = () => () => {};

/** The page origin; a fixed placeholder during server rendering, without a hydration mismatch. */
export function useOrigin(): string {
  return useSyncExternalStore(subscribeNever, () => window.location.origin, () => SERVER_ORIGIN);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

function Card({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="shrink-0 rounded-lg border border-neutral-200 bg-white p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-700">{icon}</span>
        <div>
          <h3 className="text-[12px] font-semibold text-neutral-900">{title}</h3>
          <p className="mt-0.5 text-[11px] text-neutral-500">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

const smallButton = "inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[11px] text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50";
const field = "workflow-field block w-full min-w-0 rounded-md border border-neutral-200 bg-neutral-50/70 px-2 py-1.5 text-[11px] text-neutral-700 focus:border-violet-400 focus:bg-white focus:outline-none";

/* ------------------------------- Webhook -------------------------------- */

export function WebhookSettings({ workflowId }: { workflowId: string }) {
  const origin = useOrigin();
  const endpoint = `/api/workflows/${encodeURIComponent(workflowId)}/webhook`;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // Shown once after creation; the server keeps only its hash.
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ enabled: boolean }>(endpoint, { signal: controller.signal })
      .then((body) => setEnabled(body.enabled))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't load webhook settings.");
      });
    return () => controller.abort();
  }, [endpoint]);

  async function change(method: "POST" | "DELETE") {
    setBusy(true);
    setError(null);
    try {
      const body = await requestJson<{ enabled: boolean; secret?: string }>(endpoint, { method });
      setEnabled(body.enabled);
      setSecret(body.secret ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the webhook.");
    } finally {
      setBusy(false);
    }
  }

  const url = secret ? `${origin}/api/hooks/${encodeURIComponent(workflowId)}/${secret}` : null;

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card icon={<Webhook className="size-3.5" aria-hidden />} title="Webhook" description="Let another service start this workflow with a POST.">
      {enabled === null && !error ? (
        <p className="flex items-center gap-1.5 text-[11px] text-neutral-500"><Loader2 className="size-3 animate-spin" aria-hidden /> Loading…</p>
      ) : null}
      {url ? (
        <div className="mb-2">
          <p className="mb-1 text-[11px] font-medium text-amber-800">Copy this URL now. It will not be shown again.</p>
          <div className="flex min-w-0 items-start gap-1">
            <code className="min-w-0 flex-1 break-all rounded bg-neutral-100 px-1.5 py-1 font-mono text-[10px] text-neutral-800">{url}</code>
            <button type="button" onClick={() => void copy()} className={smallButton} aria-label="Copy webhook URL">
              {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-neutral-500">
            Anyone with this URL can start runs, within the shared rate and daily limits. Add <code className="rounded bg-neutral-100 px-1">?wait=true</code> to receive the result.
          </p>
        </div>
      ) : enabled ? (
        <p className="mb-2 text-[11px] text-neutral-700">A webhook URL is active. Create a new URL if the old one was lost or exposed.</p>
      ) : enabled === false ? (
        <p className="mb-2 text-[11px] text-neutral-600">No webhook URL yet.</p>
      ) : null}
      {enabled !== null ? (
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => void change("POST")} disabled={busy} className="primary-button !min-h-7 !text-[11px]">
            {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
            {enabled ? "Replace URL" : "Create webhook URL"}
          </button>
          {enabled ? (
            <button type="button" onClick={() => void change("DELETE")} disabled={busy} className={smallButton}>Disable</button>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1.5 text-[11px] text-red-700">{error}</p> : null}
    </Card>
  );
}

/* ------------------------------- Schedule ------------------------------- */

type Schedule =
  | { kind: "interval"; everyMinutes: number; input: string; timezone: string }
  | { kind: "daily"; time: string; input: string; timezone: string };
type ScheduleResponse = { schedule?: Schedule | null; nextRunAt?: number | null; schedulerConfigured: boolean };

const INTERVALS = [5, 15, 30, 60, 180, 360, 720, 1440];

function intervalLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "hour" : minutes === 1440 ? "day" : `${minutes / 60} hours`;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function ScheduleSettings({ workflowId, sampleInput }: { workflowId: string; sampleInput: string }) {
  const endpoint = `/api/workflows/${encodeURIComponent(workflowId)}/schedule`;
  const [state, setState] = useState<ScheduleResponse | null>(null);
  const [draft, setDraft] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<ScheduleResponse>(endpoint, { signal: controller.signal })
      .then(setState)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't load the schedule.");
      });
    return () => controller.abort();
  }, [endpoint]);

  const value: Schedule = draft ?? state?.schedule ?? {
    kind: "daily", time: "08:00", input: sampleInput, timezone: localTimezone(),
  };
  const dirty = draft !== null;

  async function save(method: "PUT" | "DELETE") {
    setBusy(true);
    setError(null);
    try {
      const body = await requestJson<ScheduleResponse>(endpoint, method === "PUT"
        ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schedule: value }) }
        : { method });
      setState(body);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the schedule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card icon={<CalendarClock className="size-3.5" aria-hidden />} title="Schedule" description="Run this workflow automatically with a fixed input.">
      {state === null && !error ? (
        <p className="flex items-center gap-1.5 text-[11px] text-neutral-500"><Loader2 className="size-3 animate-spin" aria-hidden /> Loading…</p>
      ) : null}
      {state ? (
        <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void save("PUT"); }}>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-600">
            <label htmlFor="schedule-kind" className="sr-only">Repeat</label>
            <select
              id="schedule-kind"
              value={value.kind}
              onChange={(event) => setDraft(event.target.value === "interval"
                ? { kind: "interval", everyMinutes: 60, input: value.input, timezone: value.timezone }
                : { kind: "daily", time: "08:00", input: value.input, timezone: value.timezone })}
              className={`${field} !w-auto`}
            >
              <option value="daily">Every day at</option>
              <option value="interval">Every</option>
            </select>
            {value.kind === "daily" ? (
              <>
                <label htmlFor="schedule-time" className="sr-only">Time</label>
                <input id="schedule-time" type="time" required value={value.time}
                  onChange={(event) => setDraft({ ...value, time: event.target.value })} className={`${field} !w-auto`} />
              </>
            ) : (
              <>
                <label htmlFor="schedule-interval" className="sr-only">Interval</label>
                <select id="schedule-interval" value={value.everyMinutes}
                  onChange={(event) => setDraft({ ...value, everyMinutes: Number(event.target.value) })} className={`${field} !w-auto`}>
                  {INTERVALS.map((minutes) => <option key={minutes} value={minutes}>{intervalLabel(minutes)}</option>)}
                </select>
              </>
            )}
          </div>
          <div>
            <label htmlFor="schedule-timezone" className="mb-1 block text-[11px] font-medium text-neutral-600">Time zone</label>
            <input id="schedule-timezone" value={value.timezone} required maxLength={64}
              onChange={(event) => setDraft({ ...value, timezone: event.target.value })} className={field} />
          </div>
          <div>
            <label htmlFor="schedule-input" className="mb-1 block text-[11px] font-medium text-neutral-600">Input for each run</label>
            <textarea id="schedule-input" rows={3} required maxLength={MAX_INPUT_CHARS} value={value.input}
              onChange={(event) => setDraft({ ...value, input: event.target.value })} className={`${field} resize-y leading-5`} />
          </div>
          {state.schedule && state.nextRunAt ? (
            <p className="text-[11px] text-neutral-600">
              Next run: {new Date(state.nextRunAt).toLocaleString()}
            </p>
          ) : null}
          {!state.schedulerConfigured ? (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
              Schedules run only when the server has <code>CRON_SECRET</code> set and a cron service calls <code>/api/cron</code> every few minutes. See the README.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1">
            <button type="submit" disabled={busy || (!dirty && Boolean(state.schedule))} className="primary-button !min-h-7 !text-[11px]">
              {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              {state.schedule ? "Save schedule" : "Turn on schedule"}
            </button>
            {dirty ? <button type="button" onClick={() => setDraft(null)} disabled={busy} className={smallButton}>Discard changes</button> : null}
            {state.schedule ? <button type="button" onClick={() => void save("DELETE")} disabled={busy} className={smallButton}>Turn off</button> : null}
          </div>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-1.5 text-[11px] text-red-700">{error}</p> : null}
    </Card>
  );
}
