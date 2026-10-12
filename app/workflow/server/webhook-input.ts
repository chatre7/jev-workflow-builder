import { ApiError } from "./request-security";

/**
 * Turns a webhook request body into the workflow's Input text.
 *
 * Callers differ: form tools post `application/x-www-form-urlencoded`, chat
 * platforms and Zapier post JSON objects (often with the useful text nested,
 * such as `{"message":{"text":"..."}}`), and scripts may post plain text.
 * Downstream nodes read Input as text: Transform, Condition and Table parse
 * it as JSON through `json.<field>`, while Jev and LLM read it as prose.
 *
 * Objects and arrays therefore pass through as JSON, so no field is lost and a
 * Transform can pick what it needs. A bare JSON string becomes its text. Forms
 * become a JSON object; a repeated field becomes an array in order.
 *
 * @param body        The raw UTF-8 body, already size-limited (≤ 96 KiB).
 * @param contentType The media type without parameters, lower-cased
 *                    (for example "application/json"), or "" when absent.
 * @returns The Input text. The route rejects an empty result (400) and one
 *          longer than MAX_INPUT_CHARS (413), so this function need not.
 * @throws ApiError(400 | 415) for bodies this endpoint should refuse.
 */
export function webhookInput(body: string, contentType: string): string {
  if (!body.trim()) throw new ApiError(400, "Webhook body is empty.");

  if (contentType === "application/json" || contentType.endsWith("+json")) {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new ApiError(400, "Webhook body is not valid JSON.");
    }
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object") return String(value);
    // The original text, not a re-serialization: key order and number spelling survive.
    return body.trim();
  }

  if (contentType === "application/x-www-form-urlencoded") {
    // Null prototype: a field named __proto__ stays an ordinary key.
    const fields: Record<string, string | string[]> = Object.create(null);
    for (const [key, value] of new URLSearchParams(body)) {
      const existing = fields[key];
      fields[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
    return JSON.stringify(fields);
  }

  if (contentType === "" || contentType.startsWith("text/")) return body;

  throw new ApiError(415, "Send the webhook body as JSON, form data or plain text.");
}
