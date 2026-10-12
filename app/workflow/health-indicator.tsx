"use client";

import { CircleAlert, CircleCheck, FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import type { HealthReport } from "./server/health";

const POLL_MS = 5 * 60_000;

function describe(report: HealthReport): { tone: "ok" | "mock" | "error"; label: string; detail: string } {
  const problems = [report.redis, report.openrouter].filter((service) => service.status === "error");
  if (problems.length > 0) {
    return { tone: "error", label: "Service issue", detail: problems.map((service) => service.message).join("\n") };
  }
  if (report.openrouter.status === "mock") {
    return { tone: "mock", label: "Mock AI", detail: report.openrouter.message ?? "" };
  }
  const remaining = report.openrouter.limitRemaining;
  return {
    tone: "ok",
    label: "Services OK",
    detail: `Redis and OpenRouter are reachable.${typeof remaining === "number" ? ` Key credit remaining: $${remaining.toFixed(2)}.` : ""}`,
  };
}

/** Surfaces an expired provider key or unreachable storage before a run fails on it. */
export function HealthIndicator() {
  const [report, setReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store", signal: controller.signal });
        if (response.ok) setReport((await response.json()) as HealthReport);
      } catch { /* keep the last report; the next poll retries */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, []);

  if (!report) return null;
  const { tone, label, detail } = describe(report);
  const Icon = tone === "error" ? CircleAlert : tone === "mock" ? FlaskConical : CircleCheck;
  return (
    <span
      role="status"
      title={detail}
      className={`hidden items-center gap-1 border-r border-neutral-200 pr-3 text-[11px] sm:flex ${
        tone === "error" ? "font-medium text-red-600" : tone === "mock" ? "text-amber-700" : "text-neutral-500"
      }`}
    >
      <Icon className="size-3.5" aria-hidden />
      {tone === "ok" ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
