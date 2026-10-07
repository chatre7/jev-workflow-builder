"use client";

import {
  ChevronRight,
  Download,
  Plus,
  Upload,
  Workflow as WorkflowIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { HelpButton } from "../../components/help-button";
import { createWorkflowAction } from "./actions";
import type { WorkflowSummary } from "./server/store";

// Matches the server's import cap; checked first so a large file fails fast.
const MAX_BACKUP_FILE_BYTES = 4 * 1024 * 1024;

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours} h ago`;

  return new Date(timestamp).toLocaleDateString();
}

async function importBackup(file: File): Promise<{ workflowId: string; name: string }[]> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Backup files must be at most 4 MB. Export workflows one at a time for large workspaces.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  const response = await fetch("/api/workflows/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed),
  });
  const body: unknown = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "Unable to import this backup.";
    throw new Error(message);
  }
  return (body as { workflows: { workflowId: string; name: string }[] }).workflows;
}

export function WorkflowList({
  workflows,
}: {
  workflows: WorkflowSummary[];
}) {
  const router = useRouter();
  const [isCreating, startCreating] = useTransition();
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleImport(file: File | undefined) {
    if (!file || importing) return;
    setImporting(true);
    setNotice(null);
    try {
      const created = await importBackup(file);
      if (created.length === 1) {
        router.push(`/w/${created[0].workflowId}`);
        return;
      }
      setNotice({ kind: "success", text: `Imported ${created.length} workflows.` });
      router.refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Unable to import this backup." });
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <main className="workflow-library min-h-dvh">
      <nav className="library-nav" aria-label="Workspace">
        <div className="flex items-center gap-2">
          <span className="brand-mark !size-6 !rounded-md">
            <WorkflowIcon className="size-3.5" aria-hidden />
          </span>
          <span className="text-xs font-semibold tracking-tight">
            Workflows
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/api/auth/signout?callbackUrl=%2F"
            className="text-xs text-neutral-600 hover:text-neutral-900"
          >
            Sign out
          </Link>
          <HelpButton />
        </div>
      </nav>
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
              Workflows
            </h1>
            <span className="rounded bg-neutral-200/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-neutral-500">
              {workflows.length}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <a
              href="/api/workflows/export"
              download
              title="Download a backup of every workflow"
              aria-label="Download a backup of every workflow"
              className={`icon-button ${workflows.length === 0 ? "pointer-events-none opacity-40" : ""}`}
              aria-disabled={workflows.length === 0}
            >
              <Download className="size-4" />
            </a>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void handleImport(event.target.files?.[0])}
            />
            <button
              type="button"
              title="Import a backup file as new workflows"
              aria-label="Import a backup file as new workflows"
              disabled={importing}
              onClick={() => fileInput.current?.click()}
              className="icon-button"
            >
              <Upload className="size-4" />
            </button>
            <button
              type="button"
              disabled={isCreating}
              onClick={() => startCreating(() => createWorkflowAction())}
              className="primary-button"
            >
              <Plus className="size-3.5" />
              {isCreating ? "Creating…" : "New workflow"}
            </button>
          </div>
        </header>

        {importing ? (
          <p className="mb-3 text-xs text-neutral-500" role="status">Importing backup…</p>
        ) : notice ? (
          <p
            role={notice.kind === "error" ? "alert" : "status"}
            className={`mb-3 rounded-md border px-3 py-2 text-xs ${
              notice.kind === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {notice.text}
          </p>
        ) : null}

        <ul className="workflow-list">
          {workflows.length === 0 ? (
            <li className="px-3 py-4 text-xs text-neutral-400">
              No workflows yet.
            </li>
          ) : null}
          {workflows.map((workflow) => (
            <li
              key={workflow.workflowId}
              className="min-w-0 border-b border-neutral-100 last:border-b-0"
            >
              <Link
                href={`/w/${workflow.workflowId}`}
                className="workflow-list-row group flex items-center gap-2.5 px-3 py-2"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-violet-50 text-violet-600">
                  <WorkflowIcon className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-900">
                  {workflow.name}
                </span>
                <span className="shrink-0 whitespace-nowrap text-[10px] text-neutral-500">
                  <span className="hidden sm:inline">
                    {workflow.updatedAt > workflow.createdAt ? "Edited " : "Created "}
                  </span>
                  {formatRelative(
                    workflow.updatedAt
                  )}
                </span>
                <ChevronRight
                  className="size-3 shrink-0 text-neutral-300 transition-colors group-hover:text-violet-600"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
