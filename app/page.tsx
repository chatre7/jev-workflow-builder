import { Workflow as WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { WorkflowList } from "./workflow/workflow-list";
import {
  getAuthConfigurationError,
  getPrincipal,
} from "./workflow/server/auth";
import {
  getLiveblocksConfigurationError,
  listWorkflows,
} from "./workflow/server/liveblocks";

export const dynamic = "force-dynamic";

export default async function Page() {
  const configurationError =
    getAuthConfigurationError() ?? getLiveblocksConfigurationError();
  const principal = configurationError ? null : await getPrincipal();

  if (!principal) {
    return (
      <main className="workflow-library min-h-dvh">
        <nav className="library-nav" aria-label="Workspace">
          <Link href="/" className="flex items-center gap-2">
            <span className="brand-mark !size-6 !rounded-md">
              <WorkflowIcon className="size-3.5" aria-hidden />
            </span>
            <span className="text-xs font-semibold tracking-tight">Workflows</span>
          </Link>
        </nav>
        <section className="mx-auto w-full max-w-xl px-6 py-16 sm:py-24">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Your private workflow workspace
          </h1>
          {configurationError ? (
            <div className="mt-4 space-y-3 text-base leading-relaxed text-neutral-600">
              <p>Workspace setup is incomplete. Private workflows are locked.</p>
              <p>{configurationError}</p>
              <p className="text-sm">
                Ask the deployment administrator to update the server environment
                and redeploy. No secret values should be shared here.
              </p>
            </div>
          ) : (
            <>
              <p className="mt-4 text-base leading-relaxed text-neutral-600">
                Enter your owner password to manage your private workflows.
                No GitHub account or OAuth setup is needed.
              </p>
              <Link
                href="/api/auth/signin?callbackUrl=%2F"
                className="primary-button mt-6 inline-flex"
              >
                Sign in
              </Link>
            </>
          )}
        </section>
      </main>
    );
  }

  const workflows = await listWorkflows(principal);
  return <WorkflowList workflows={workflows} />;
}
