import "server-only";

import { runHttpRequest } from "./http";

const NOTIFY_TIMEOUT_MS = 10_000;
const MAX_PROMPT_CHARS = 500;
const FORMATS = ["slack", "discord", "telegram", "json"] as const;
type NotifyFormat = (typeof FORMATS)[number];

type NotifyConfig = { connection: string; path: string; format: NotifyFormat; chatId?: string };

export type ApprovalNotice = {
  workflowId: string;
  runId: string;
  approvals: { label: string; prompt: string; expiresAt: number }[];
};

/**
 * WORKFLOW_APPROVAL_NOTIFY selects one HTTP connection from
 * WORKFLOW_HTTP_CONNECTIONS, so notices get the same HTTPS, address and
 * header protections as HTTP Request nodes. Example (Telegram):
 *   {"connection":"alerts","path":"sendMessage","format":"telegram","chatId":"123456"}
 */
function readConfig(): NotifyConfig | null {
  const raw = process.env.WORKFLOW_APPROVAL_NOTIFY;
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const { connection, path = "", format, chatId } = value as Record<string, unknown>;
  if (typeof connection !== "string" || typeof path !== "string" || path.length > 512
      || !FORMATS.includes(format as NotifyFormat)
      || (format === "telegram" ? typeof chatId !== "string" || !/^-?[\w@]{1,64}$/.test(chatId) : chatId !== undefined)) {
    return invalid();
  }
  return { connection, path, format: format as NotifyFormat, ...(typeof chatId === "string" ? { chatId } : {}) };
}

function invalid(): null {
  console.error("WORKFLOW_APPROVAL_NOTIFY is invalid; approval notices are disabled.");
  return null;
}

function reviewUrl(workflowId: string): string | null {
  try {
    return new URL(`/w/${encodeURIComponent(workflowId)}`, process.env.NEXTAUTH_URL).href;
  } catch {
    return null;
  }
}

function message(notice: ApprovalNotice): string {
  const url = reviewUrl(notice.workflowId);
  const lines = notice.approvals.map(({ label, prompt, expiresAt }) => {
    const text = prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}…` : prompt;
    return `• ${label}: ${text} (expires ${new Date(expiresAt).toISOString()})`;
  });
  return [`Approval needed for run ${notice.runId}`, ...lines, ...(url ? [`Review: ${url}`] : [])].join("\n");
}

export function approvalPayload(config: Pick<NotifyConfig, "format" | "chatId">, notice: ApprovalNotice): Record<string, unknown> {
  const text = message(notice);
  switch (config.format) {
    case "slack": return { text };
    case "discord": return { content: text.slice(0, 2_000), allowed_mentions: { parse: [] } };
    case "telegram": return { chat_id: config.chatId, text: text.slice(0, 4_096), disable_web_page_preview: true };
    case "json": return { event: "approval.waiting", ...notice, reviewUrl: reviewUrl(notice.workflowId), text };
  }
}

export function isApprovalNotifyConfigured(): boolean {
  return readConfig() !== null;
}

/**
 * Best effort: a failed notice is logged and never changes the run. The run is
 * already saved as waiting before this is called, and Runs still shows it.
 */
export async function notifyApprovalWaiting(notice: ApprovalNotice): Promise<void> {
  const config = readConfig();
  if (!config || notice.approvals.length === 0) return;
  try {
    await runHttpRequest({
      connection: config.connection,
      method: "POST",
      path: config.path,
      body: JSON.stringify(approvalPayload(config, notice)),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
  } catch {
    console.error("Approval notice could not be delivered.");
  }
}
