import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { getPrincipal, type Principal } from "./auth";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function assertSameOrigin(request: Request): void {
  const configured = process.env.NEXTAUTH_URL;
  if (!configured) throw new ApiError(503, "Authentication is not configured.");
  let expected: string;
  try {
    expected = new URL(configured).origin;
  } catch {
    throw new ApiError(503, "Authentication is not configured.");
  }
  if (request.headers.get("origin") !== expected) {
    throw new ApiError(403, "This request must come from the application origin.");
  }
}

/** Automation credentials authorize runs only, never room tokens or editing. */
export async function authenticateRunRequest(request: Request): Promise<Principal> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const configured = process.env.WORKFLOW_API_TOKEN;
    const supplied = /^Bearer ([^\s]{32,256})$/.exec(authorization)?.[1];
    if (!configured || configured.length < 32 || configured.length > 256 || !supplied) {
      throw new ApiError(401, "Invalid workflow API token.");
    }
    const expectedHash = createHash("sha256").update(configured).digest();
    const suppliedHash = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(expectedHash, suppliedHash)) {
      throw new ApiError(401, "Invalid workflow API token.");
    }
    return { id: "api:automation", name: "Workflow automation", avatar: "", color: "#7654cb" };
  }

  const principal = await getPrincipal();
  if (!principal) throw new ApiError(401, "Sign in with an authorized GitHub account.");
  assertSameOrigin(request);
  return principal;
}

/** Enforce a byte budget while reading, not after request.json() has allocated. */
export async function readJsonObject(
  request: Request,
  maxBytes = 96 * 1024
): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "Content-Type must be application/json.");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new ApiError(413, "Request body is too large.");
  }
  if (!request.body) throw new ApiError(400, "A JSON object is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(408, "Request body timed out.")), 5_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new ApiError(413, "Request body is too large.");
      chunks.push(value);
    }
    complete = true;
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "A JSON object is required.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "A valid JSON object is required.");
  } finally {
    clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
