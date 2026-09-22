import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModuleLoader } from "./load-module.mjs";

async function harness(t, catalog, { configured = true, raw } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-knowledge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "catalog.json");
  await writeFile(filename, raw ?? JSON.stringify(catalog));
  const env = configured ? { WORKFLOW_KNOWLEDGE_FILE: filename } : {};
  const load = createModuleLoader({ env, stubs: { nanoid: { nanoid: () => "unused" } } });
  const { searchKnowledge } = await load("app/workflow/server/knowledge");
  const { MAX_NODE_TEXT_CHARS } = await load("app/workflow/server/execution-policy");
  return {
    searchKnowledge,
    filename,
    MAX_NODE_TEXT_CHARS,
    search: async (query, topK = 5) => JSON.parse(await searchKnowledge({ query, topK, signal: new AbortController().signal })),
  };
}

const refund = { id: "refund", title: "Refund policy", text: "A refund above 1000 requires supervisor approval." };

test("ranks lexical relevance and returns source citations with matched late excerpts", async (t) => {
  const h = await harness(t, [
    { id: "delivery", title: "Delivery tracking", text: "Check the carrier tracking record for the delivery status." },
    { id: "brief", title: "General support", text: "Contact a supervisor for assistance." },
    { id: "refund", title: "Refund policy", url: "https://example.com/policies/refunds", text: "Background information. ".repeat(90) + "A refund above 1000 requires supervisor approval. Supervisor approval is mandatory for refund requests above 1000." },
  ]);
  const result = await h.search("REFUND supervisor approval", 2);
  assert.equal(result.query, "REFUND supervisor approval");
  assert.equal(result.match_count, 2);
  assert.deepEqual(result.matches.map((match) => match.id), ["refund", "brief"]);
  assert.equal(result.matches[0].title, "Refund policy");
  assert.equal(result.matches[0].url, "https://example.com/policies/refunds");
  assert.ok(result.matches[0].score > result.matches[1].score);
  // A title hit is valid matching material; body-only matches must reach the late passage.
  const late = await h.search("mandatory 1000", 1);
  assert.equal(late.matches[0].id, "refund");
  assert.match(late.matches[0].excerpt, /above 1000 requires supervisor approval/);
  assert.match(late.matches[0].excerpt, /mandatory/);
  assert.ok(late.matches[0].excerpt.length <= 600);
});

test("retrieves Thai words without spaces and preserves the real Thai citation", async (t) => {
  const catalog = JSON.parse(await readFile(new URL("../examples/knowledge.json", import.meta.url), "utf8"));
  const h = await harness(t, catalog);
  const result = await h.search("คืนเงิน", 2);
  assert.equal(result.match_count, 1);
  assert.equal(result.matches[0].id, "demo-refund-policy-th");
  assert.equal(result.matches[0].title, catalog[1].title);
  assert.match(result.matches[0].excerpt, /คืนเงิน/);
  assert.equal(Object.hasOwn(result.matches[0], "url"), false);
});

test("returns no hits for absent words or punctuation rather than substring matches", async (t) => {
  const h = await harness(t, [refund]);
  for (const query of ["volcano", "fund", "!!! — ..."]) {
    assert.deepEqual(await h.search(query), { query, match_count: 0, matches: [] });
  }
});

test("equal scores preserve catalog order and topK limits the returned matches", async (t) => {
  const h = await harness(t, ["third", "first", "second"].map((id) => ({ ...refund, id })));
  const result = await h.search("refund", 2);
  assert.deepEqual(result.matches.map((match) => match.id), ["third", "first"]);
  assert.equal(result.match_count, 2);
  assert.equal(result.matches[0].score, result.matches[1].score);
});

test("missing configuration and unreadable files fail even for no-word queries", async (t) => {
  const missing = await harness(t, [], { configured: false });
  await assert.rejects(missing.search("!!!"), /not configured.*WORKFLOW_KNOWLEDGE_FILE/);
  const unreadable = await harness(t, [refund]);
  await rm(unreadable.filename);
  await assert.rejects(unreadable.search("refund"), /could not be read/);
});

test("rejects malformed catalogs instead of ignoring broken source documents", async (t) => {
  const h = await harness(t, []);
  const cases = [
    ["not json", /valid UTF-8 JSON/],
    [Buffer.from([0xff, 0xfe]), /valid UTF-8 JSON/],
    [{ documents: [refund] }, /must be an array/],
    [[null], /must be an object/],
    [[refund, refund], /id must be unique/],
    [[{ ...refund, id: "bad id" }], /id must use/],
    [[{ ...refund, id: "x".repeat(97) }], /id must use/],
    [[{ ...refund, title: " " }], /title must contain/],
    [[{ ...refund, title: "x".repeat(161) }], /title must contain/],
    [[{ ...refund, text: "" }], /text must contain/],
    [[{ ...refund, text: "x".repeat(8001) }], /text must contain/],
    [[{ ...refund, url: "http://example.com/policy" }], /HTTPS URL/],
    [[{ ...refund, url: "https://user:secret@example.com/policy" }], /without embedded credentials/],
    [[{ ...refund, url: null }], /HTTPS URL/],
    [[{ ...refund, url: "https://example.com/" + "x".repeat(2048) }], /2048 characters/],
    [[{ ...refund, unexpected: true }], /only id, title, text and url/],
    [Array.from({ length: 101 }, (_, i) => ({ ...refund, id: `doc-${i}` })), /at most 100 documents/],
  ];
  for (const [value, error] of cases) {
    await writeFile(h.filename, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    await assert.rejects(h.search("refund"), error);
  }
});

test("bounds the bytes read from a catalog independently of JSON validity", async (t) => {
  const h = await harness(t, [], { raw: " ".repeat(1_048_577) });
  await assert.rejects(h.search("refund"), /1048576 byte limit/);
});

test("honors cancellation before I/O and during catalog retrieval", async (t) => {
  const h = await harness(t, Array.from({ length: 100 }, (_, i) => ({ ...refund, id: `doc-${i}`, text: "refund ".repeat(1100) })));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(h.searchKnowledge({ query: "refund", topK: 1, signal: cancelled.signal }), /cancelled/);
  const active = new AbortController();
  const pending = h.searchKnowledge({ query: "refund", topK: 1, signal: active.signal });
  active.abort();
  await assert.rejects(pending, /cancelled/);
});

test("rejects invalid topK and applies the serialized output bound including escapes", async (t) => {
  const h = await harness(t, Array.from({ length: 5 }, (_, i) => ({
    ...refund, id: `doc-${i}`, text: "refund " + "\u0000".repeat(590),
  })));
  for (const topK of [0, 6, 1.5]) {
    await assert.rejects(h.search("refund", topK), /integer from 1 to 5/);
  }
  const text = await h.searchKnowledge({ query: "refund", topK: 5, signal: new AbortController().signal });
  assert.equal(JSON.parse(text).matches.length, 5);
  assert.ok(text.length <= h.MAX_NODE_TEXT_CHARS);
  // The raw query fits, but JSON escaping it would overflow the node output.
  await assert.rejects(h.search("refund" + "\u0000".repeat(6000)), /Knowledge output exceeds/);
  await assert.rejects(h.search("x".repeat(h.MAX_NODE_TEXT_CHARS + 1)), /Knowledge query exceeds/);
});
