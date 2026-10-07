import "server-only";

import type { RunEvent, RunTrace } from "../runs";

/**
 * Streams a run's progress to the request that started or resumed it as
 * Server-Sent Events: `run` and `node` events while it executes, then one
 * `done` event carrying the final trace (or `failed` with a message).
 */
export function createRunEventStream(): {
  response: (status?: number) => Response;
  /** First frame: the run ID, so the client can select it before any trace. */
  start: (runId: string) => void;
  emit: (event: RunEvent) => void;
  finish: (trace: RunTrace) => void;
  fail: (message: string) => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  // Events before the stream is consumed are kept so none are lost.
  const backlog: string[] = [];
  const write = (chunk: string) => {
    if (closed) return;
    if (controller) {
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        closed = true;
      }
    } else {
      backlog.push(chunk);
    }
  };
  const end = () => {
    if (closed) return;
    closed = true;
    try {
      controller?.close();
    } catch { /* already closed by the client */ }
  };
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of backlog) c.enqueue(encoder.encode(chunk));
      backlog.length = 0;
      if (closed) c.close();
    },
    cancel() {
      closed = true;
    },
  });
  return {
    response: (status = 200) => new Response(stream, {
      status,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    }),
    start: (runId) => write(frame("start", { runId })),
    emit: (event) => write(frame(event.type, event.type === "run" ? event.metadata : event.data)),
    finish: (trace) => {
      write(frame("done", trace));
      end();
    },
    fail: (message) => {
      write(frame("failed", { error: message }));
      end();
    },
  };
}
