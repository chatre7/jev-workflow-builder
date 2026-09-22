import "server-only";
import { createReadStream } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { ExecutionError, MAX_NODE_TEXT_CHARS, checkAbort, checkLimit, jsonSize } from "./execution-policy";

const MAX_CATALOG_BYTES = 1_048_576;
const MAX_DOCUMENTS = 100;
const MAX_DOCUMENT_CHARS = 8_000;
const MAX_TITLE_CHARS = 160;
const MAX_ID_CHARS = 96;
const MAX_URL_CHARS = 2_048;
const MAX_EXCERPT_CHARS = 600;
const segmenter = new Intl.Segmenter(["th", "en"], { granularity: "word" });

type Document = { id: string; title: string; text: string; url?: string };
type IndexedDocument = {
  document: Document;
  frequencies: Map<string, number>;
  length: number;
  firstMatch: number;
};


async function readCatalog(signal: AbortSignal): Promise<Document[]> {
  const filename = process.env.WORKFLOW_KNOWLEDGE_FILE;
  if (!filename?.trim()) {
    throw new ExecutionError("Knowledge Search is not configured. Set WORKFLOW_KNOWLEDGE_FILE to a JSON catalog on the server.");
  }
  checkAbort(signal);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    // Read and count the bytes themselves: a stat check alone races file growth.
    const stream = createReadStream(filename, { highWaterMark: 64 * 1024, signal });
    for await (const chunk of stream) {
      checkAbort(signal);
      bytes += chunk.length;
      if (bytes > MAX_CATALOG_BYTES) {
        throw new ExecutionError(`Knowledge catalog exceeds the ${MAX_CATALOG_BYTES} byte limit.`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    checkAbort(signal);
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("Knowledge catalog could not be read. Check WORKFLOW_KNOWLEDGE_FILE and server file permissions.");
  }
  checkAbort(signal);
  let catalog: unknown;
  try {
    catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    throw new ExecutionError("Knowledge catalog must contain valid UTF-8 JSON.");
  }
  if (!Array.isArray(catalog) || catalog.length > MAX_DOCUMENTS) {
    throw new ExecutionError(`Knowledge catalog must be an array of at most ${MAX_DOCUMENTS} documents.`);
  }
  const ids = new Set<string>();
  return catalog.map((entry: unknown, index): Document => {
    const invalid = (reason: string): never => {
      throw new ExecutionError(`Knowledge catalog document ${index + 1}: ${reason}`);
    };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return invalid("must be an object with id, title, text and optional url.");
    }
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !["id", "title", "text", "url"].includes(key))) {
      return invalid("only id, title, text and url fields are supported.");
    }
    const { id, title, text, url } = fields;
    if (typeof id !== "string" || id.length > MAX_ID_CHARS || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
      return invalid(`id must use 1-${MAX_ID_CHARS} letters, numbers, dots, underscores or hyphens and start with a letter or number.`);
    }
    if (ids.has(id)) return invalid("id must be unique within the catalog.");
    ids.add(id);
    if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE_CHARS) {
      return invalid(`title must contain 1-${MAX_TITLE_CHARS} characters of nonblank text.`);
    }
    if (typeof text !== "string" || !text.trim() || text.length > MAX_DOCUMENT_CHARS) {
      return invalid(`text must contain 1-${MAX_DOCUMENT_CHARS} characters of nonblank text.`);
    }
    if (Object.hasOwn(fields, "url")) {
      if (typeof url !== "string" || url.length > MAX_URL_CHARS || url !== url.trim()) {
        return invalid(`url must be an HTTPS URL of at most ${MAX_URL_CHARS} characters.`);
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
          return invalid("url must be an HTTPS URL without embedded credentials.");
        }
      } catch {
        return invalid("url must be an HTTPS URL without embedded credentials.");
      }
    }
    return { id, title, text, ...(typeof url === "string" ? { url } : {}) };
  });
}

function excerpt(indexed: IndexedDocument): string {
  const source = `${indexed.document.title}\n${indexed.document.text}`;
  let start = Math.max(0, indexed.firstMatch - 120);
  let end = Math.min(source.length, start + MAX_EXCERPT_CHARS - 2);
  // Do not split a surrogate pair at either boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(source[start])) start++;
  if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
  return `${start ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

export async function searchKnowledge({ query, topK, signal }: {
  query: string;
  topK: number;
  signal: AbortSignal;
}): Promise<string> {
  checkAbort(signal);
  if (typeof query !== "string") throw new ExecutionError("Knowledge query must be text.");
  checkLimit(query.length, MAX_NODE_TEXT_CHARS, "Knowledge query");
  if (!Number.isInteger(topK) || topK < 1 || topK > 5) {
    throw new ExecutionError("Knowledge Search topK must be an integer from 1 to 5.");
  }
  // Validate the source even for punctuation-only queries; bad configuration is never a no-hit.
  const catalog = await readCatalog(signal);
  const terms = new Set<string>();
  for (const part of segmenter.segment(query)) {
    if (part.isWordLike) terms.add(part.segment.normalize("NFKC").toLowerCase());
  }
  const indexed: IndexedDocument[] = [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (let i = 0; i < catalog.length && terms.size > 0; i++) {
    // Yield periodically so cancellation can interrupt CPU-only catalog indexing.
    if (i % 8 === 0) await setImmediate();
    checkAbort(signal);
    const document = catalog[i];
    const frequencies = new Map<string, number>();
    let length = 0;
    let firstMatch = -1;
    for (const part of segmenter.segment(`${document.title}\n${document.text}`)) {
      if (!part.isWordLike) continue;
      length++;
      const term = part.segment.normalize("NFKC").toLowerCase();
      if (!terms.has(term)) continue;
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      if (firstMatch < 0) firstMatch = part.index;
    }
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    totalLength += length;
    indexed.push({ document, frequencies, length, firstMatch });
  }
  const averageLength = indexed.length ? totalLength / indexed.length : 1;
  // Standard BM25 (k1=1.2, b=0.75), with a positive IDF and unique query terms.
  const ranked = indexed.filter((entry) => entry.firstMatch >= 0).map((entry) => {
    let score = 0;
    for (const [term, frequency] of entry.frequencies) {
      const count = documentFrequency.get(term)!;
      const idf = Math.log(1 + (indexed.length - count + 0.5) / (count + 0.5));
      score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * entry.length / averageLength));
    }
    return { entry, score };
  });
  // Stable Array.sort preserves catalog order for equal scores.
  ranked.sort((a, b) => b.score - a.score);
  const matches = ranked.slice(0, topK).map(({ entry, score }) => ({
    id: entry.document.id,
    title: entry.document.title,
    ...(entry.document.url ? { url: entry.document.url } : {}),
    excerpt: excerpt(entry),
    score,
  }));
  const result = { query, match_count: matches.length, matches };
  checkAbort(signal);
  jsonSize(result, MAX_NODE_TEXT_CHARS, "Knowledge output");
  return JSON.stringify(result);
}
