import assert from "node:assert/strict";
import test from "node:test";
import * as csvParse from "csv-parse/sync";
import { createModuleLoader } from "./load-module.mjs";

async function harness({ principal = { id: "owner" }, available = true, delimiter = ",", headers = true, otherParent = false } = {}) {
  let graph;
  const auth = { getPrincipal: async () => principal };
  const load = createModuleLoader({
    env: { NEXTAUTH_URL: "https://workflow.example" },
    stubs: {
      nanoid: { nanoid: () => "unused" },
      "csv-parse/sync": csvParse,
      "next/server": { NextResponse: Response },
      "./auth": auth,
      "../../../../workflow/server/auth": auth,
      "../../../../workflow/server/liveblocks": {
        getWorkflow: async () => available ? { workflowId: "csv-preview" } : null,
        getRoomId: () => "authorized-room",
        readWorkflowGraph: async () => graph,
      },
    },
  });
  const s = await load("app/workflow/shared");
  graph = {
    nodes: [s.createInputNode({ position: { x: 0, y: 0 } }), s.createCsvNode({ id: "csv", position: { x: 1, y: 0 }, delimiter, headers })],
    edges: [s.createWorkflowEdge({ source: s.INPUT_NODE_ID, sourceHandle: s.OUT_HANDLE, target: "csv" })],
  };
  if (otherParent) graph.edges.push(s.createWorkflowEdge({ source: "other", sourceHandle: s.OUT_HANDLE, target: "csv" }));
  const route = await load("app/api/workflows/[workflowId]/csv-preview/route");
  return async (input, extraHeaders = {}, nodeId = "csv") => route.POST(new Request("https://workflow.example/api/workflows/csv-preview/csv-preview", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://workflow.example", ...extraHeaders },
    body: JSON.stringify({ input, nodeId }),
  }), { params: Promise.resolve({ workflowId: "csv-preview" }) });
}

test("CSV preview requires owner session and same origin, never run-only bearer authority", async () => {
  const anonymous = await harness({ principal: null });
  assert.equal((await anonymous("id\n001")).status, 401);
  const owner = await harness();
  assert.equal((await owner("id\n001", { origin: "https://attacker.example" })).status, 403);
  assert.equal((await owner("id\n001", { authorization: "Bearer run-only" })).status, 403);
  const missing = await harness({ available: false });
  assert.equal((await missing("id\n001")).status, 404);
});

test("preview keeps original numeric header order and exposes header-only schemas", async () => {
  const preview = await harness();
  const response = await preview('2,1,รหัส\nสอง,หนึ่ง,00123');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    rowCount: 1, columnCount: 3, headers: true, delimiter: ",",
    columns: ["2", "1", "รหัส"], rows: [["สอง", "หนึ่ง", "00123"]],
  });
  assert.deepEqual(await (await preview("ชื่อ,รหัส")).json(), {
    rowCount: 0, columnCount: 2, headers: true, delimiter: ",", columns: ["ชื่อ", "รหัส"], rows: [],
  });
});

test("preview uses saved delimiter and headerless mode without coercing values", async () => {
  const preview = await harness({ delimiter: ";", headers: false });
  assert.deepEqual(await (await preview('0007;"มี;ตัวคั่น"\n0008;"หลาย\nบรรทัด"')).json(), {
    rowCount: 2, columnCount: 2, headers: false, delimiter: ";",
    columns: ["Column 1", "Column 2"], rows: [["0007", "มี;ตัวคั่น"], ["0008", "หลาย\nบรรทัด"]],
  });
});

test("preview samples display only while validating every row and the full JSON size", async () => {
  const preview = await harness();
  const columns = Array.from({ length: 10 }, (_, column) => `c${column}`);
  const rows = Array.from({ length: 7 }, (_, row) => columns.map((_, column) => `00${row}-${column}`));
  const text = [columns, ...rows].map(row => row.join(",")).join("\n");
  assert.deepEqual(await (await preview(text)).json(), {
    rowCount: 7, columnCount: 10, headers: true, delimiter: ",",
    columns: columns.slice(0, 8), rows: rows.slice(0, 5).map(row => row.slice(0, 8)),
  });
  const invalidTail = await preview(text + '\n"sensitive unfinished field');
  assert.equal(invalidTail.status, 400);
  assert.doesNotMatch(JSON.stringify(await invalidTail.json()), /sensitive/);
  const amplified = await preview("h".repeat(128) + "\n" + Array(251).fill("x").join("\n"));
  assert.equal(amplified.status, 400);
  assert.match((await amplified.json()).error, /CSV output/);
});

test("preview rejects oversized run input and graphs whose CSV input would differ", async () => {
  const preview = await harness();
  assert.equal((await preview("x".repeat(20_001))).status, 413);
  assert.equal((await preview("id\n001", {}, "unknown")).status, 400);
  const joined = await harness({ otherParent: true });
  assert.equal((await joined("id\n001")).status, 400);
});
