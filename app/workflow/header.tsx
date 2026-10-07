"use client";

import { Check, ChevronRight, CloudOff, Download, Loader2, Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { HelpButton } from "../../components/help-button";
import { createWorkflowAction, renameWorkflowAction } from "./actions";
import { useGraph } from "./graph-context";
import type { WorkflowSummary } from "./server/store";

export function WorkflowHeader({
  workflow,
}: {
  workflow: WorkflowSummary;
}) {
  const router = useRouter();
  const { saveState } = useGraph();
  const [name, setName] = useState(workflow.name);
  const [isPending, startTransition] = useTransition();
  // Escape blurs before React re-renders, so blur would otherwise save the edit.
  const cancelled = useRef(false);

  useEffect(() => {
    setName(workflow.name);
  }, [workflow.name]);

  function commitName() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = name.trim() || "Untitled workflow";
    setName(next);

    if (next === workflow.name) {
      return;
    }

    startTransition(async () => {
      try {
        await renameWorkflowAction(workflow.workflowId, next);
      } catch {
        setName(workflow.name);
        return;
      }
      router.refresh();
    });
  }

  return (
    <header className="workspace-header">
      <Link
        href="/"
        className="brand-mark shrink-0"
        aria-label="All workflows"
      >
        <Workflow className="size-4" aria-hidden />
      </Link>
      <Link
        href="/"
        className="hidden text-[13px] text-neutral-500 transition-colors hover:text-neutral-900 lg:block"
      >
        Workflows
      </Link>
      <ChevronRight
        className="hidden size-3.5 shrink-0 text-neutral-300 lg:block"
        aria-hidden
      />

      <div className="workflow-title-field">
        <span className="workflow-title-measure" aria-hidden>
          {name || " "}
        </span>
        <input
          aria-label="Workflow name"
          size={1}
          value={name}
          maxLength={120}
          disabled={isPending}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              cancelled.current = true;
              setName(workflow.name);
              event.currentTarget.blur();
            }
          }}
          className="workflow-title"
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <span
          role="status"
          title={
            saveState === "saved" ? "All changes saved"
              : saveState === "saving" || saveState === "dirty" ? "Saving changes"
              : "Changes are not saved"
          }
          className={`hidden items-center gap-1 border-r border-neutral-200 pr-3 text-[11px] sm:flex ${
            saveState === "error" || saveState === "conflict" ? "text-red-600" : "text-neutral-500"
          }`}
        >
          {saveState === "saved" ? <Check className="size-3.5" aria-hidden />
            : saveState === "error" || saveState === "conflict" ? <CloudOff className="size-3.5" aria-hidden />
            : <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {saveState === "saved" ? "Saved" : saveState === "error" || saveState === "conflict" ? "Not saved" : "Saving…"}
        </span>
        <a
          href={`/api/workflows/${workflow.workflowId}/export`}
          download
          title="Download a backup of this workflow"
          aria-label="Download a backup of this workflow"
          className="icon-button"
        >
          <Download className="size-4" />
        </a>
        <button
          type="button"
          title="New workflow"
          aria-label="New workflow"
          disabled={isPending}
          onClick={() => startTransition(() => createWorkflowAction())}
          className="icon-button"
        >
          <Plus className="size-4" />
        </button>
        <Link
          href="/api/auth/signout?callbackUrl=%2F"
          className="px-1 text-xs text-neutral-600 hover:text-neutral-900"
        >
          Sign out
        </Link>
        <HelpButton />
      </div>
    </header>
  );
}
