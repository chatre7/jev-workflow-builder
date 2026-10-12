import { MAX_INPUT_CHARS } from "../shared";
import { ApiError } from "./request-security";

export const MIN_SCHEDULE_MINUTES = 5;
export const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type WorkflowSchedule = {
  input: string;
  timezone: string;
} & (
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string }
);

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Accepts only the documented shape; unknown keys are refused rather than stored. */
export function parseSchedule(value: unknown): WorkflowSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "Provide a schedule object.");
  const raw = value as Record<string, unknown>;
  const allowed = raw.kind === "interval" ? ["kind", "everyMinutes", "input", "timezone"]
    : raw.kind === "daily" ? ["kind", "time", "input", "timezone"] : null;
  if (!allowed) throw new ApiError(400, "Schedule kind must be interval or daily.");
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new ApiError(400, "Schedule contains unsupported fields.");
  if (typeof raw.input !== "string" || !raw.input.trim()) throw new ApiError(400, "Scheduled runs need a non-empty input.");
  if (raw.input.length > MAX_INPUT_CHARS) throw new ApiError(413, `Scheduled input must be at most ${MAX_INPUT_CHARS.toLocaleString()} characters.`);
  if (!isTimezone(raw.timezone)) throw new ApiError(400, "Schedule timezone must be an IANA name such as Asia/Bangkok.");
  if (raw.kind === "interval") {
    const minutes = raw.everyMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_SCHEDULE_MINUTES || minutes > MAX_SCHEDULE_MINUTES) {
      throw new ApiError(400, `Interval must be a whole number of minutes from ${MIN_SCHEDULE_MINUTES} to ${MAX_SCHEDULE_MINUTES}.`);
    }
    return { kind: "interval", everyMinutes: minutes, input: raw.input, timezone: raw.timezone };
  }
  if (typeof raw.time !== "string" || !TIME.test(raw.time)) throw new ApiError(400, "Daily time must use 24-hour HH:MM.");
  return { kind: "daily", time: raw.time, input: raw.input, timezone: raw.timezone };
}

/** Milliseconds to add to UTC to get the wall-clock time in `timeZone` at `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `timeZone` reads the given local time. */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffset(guess, timeZone);
  // A second pass corrects guesses that straddle a daylight-saving change.
  return guess - zoneOffset(first, timeZone);
}

/** The first scheduled instant strictly after `after`. */
export function nextRunAt(schedule: WorkflowSchedule, after: number): number {
  if (schedule.kind === "interval") {
    // Aligned to the epoch, so a missed or late tick never shifts later runs.
    const step = schedule.everyMinutes * MINUTE_MS;
    return Math.floor(after / step) * step + step;
  }
  const [hour, minute] = schedule.time.split(":").map(Number);
  const local = new Date(after + zoneOffset(after, schedule.timezone));
  for (let days = 0; days <= 2; days++) {
    const date = new Date(local.getTime() + days * DAY_MS);
    const candidate = zonedTime(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, schedule.timezone);
    if (candidate > after) return candidate;
  }
  throw new Error("Unable to compute the next scheduled time.");
}
