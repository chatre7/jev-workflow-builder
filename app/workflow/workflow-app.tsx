"use client";

import {
  ClientSideSuspense,
  LiveblocksProvider,
  RoomProvider,
} from "@liveblocks/react/suspense";
import { ReactFlowProvider } from "@xyflow/react";
import Loading from "../loading";
import { WorkflowEditor } from "./editor";
import { WorkflowHeader } from "./header";
import { RunProvider } from "./run-context";
import type { WorkflowSummary } from "./server/liveblocks";
import { SidePanel } from "./side-panel";

export function WorkflowApp({
  roomId,
  workflow,
}: {
  roomId: string;
  workflow: WorkflowSummary;
}) {
  return (
    <LiveblocksProvider
      throttle={16}
      authEndpoint="/api/liveblocks-auth"
      // Only set when running against the local Liveblocks dev server.
      baseUrl={process.env.NEXT_PUBLIC_LIVEBLOCKS_BASE_URL}
      resolveUsers={async ({ userIds }) => {
        const params = new URLSearchParams({ workflowId: workflow.workflowId });
        for (const userId of userIds) {
          params.append("userIds", userId);
        }
        const response = await fetch(`/api/users?${params}`);
        if (!response.ok) {
          throw new Error("Unable to resolve workflow collaborators.");
        }
        const users = (await response.json()) as (
          | Liveblocks["UserMeta"]["info"]
          | null
        )[];
        return users.map((user) => user ?? undefined);
      }}
    >
      <RoomProvider id={roomId} initialPresence={{ selectedRunId: null }}>
        <ClientSideSuspense fallback={<Loading />}>
          <ReactFlowProvider>
            <RunProvider>
              <div className="flex h-dvh flex-col overflow-hidden text-neutral-900">
                <WorkflowHeader workflow={workflow} />
                <div className="workspace-body flex min-h-0 flex-1">
                  <WorkflowEditor className="min-w-0 flex-1" />
                  <SidePanel workflow={workflow} />
                </div>
              </div>
            </RunProvider>
          </ReactFlowProvider>
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  );
}
