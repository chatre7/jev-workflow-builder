"use client";

import { AvatarStack } from "@liveblocks/react-ui";
import { ChevronRight, Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { HelpButton } from "../../components/help-button";
import { createWorkflowAction, renameWorkflowAction } from "./actions";
import type { WorkflowSummary } from "./server/liveblocks";

export function WorkflowHeader({
  workflow,
}: {
  workflow: WorkflowSummary;
}) {
  const router = useRouter();
  const [name, setName] = useState(workflow.name);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setName(workflow.name);
  }, [workflow.name]);

  function commitName() {
    const next = name.trim() || "Untitled workflow";
    setName(next);

    if (next === workflow.name) {
      return;
    }

    startTransition(async () => {
      await renameWorkflowAction(workflow.workflowId, next);
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
              setName(workflow.name);
              event.currentTarget.blur();
            }
          }}
          className="workflow-title"
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <div className="hidden border-r border-neutral-200 pr-3 sm:block">
          <AvatarStack size={24} gap={3} max={3} />
        </div>
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
