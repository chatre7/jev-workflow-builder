import assert from "node:assert/strict";
import { test } from "node:test";
import { createModuleLoader } from "./load-module.mjs";

const token = "a-local-regression-token-with-at-least-32-characters";
const member = { id: "owner", name: "Owner", avatar: "", color: "#7654cb" };

async function setup(principal = null) {
  const load = createModuleLoader({
    env: { NEXTAUTH_URL: "https://workflow.example", WORKFLOW_API_TOKEN: token },
    stubs: { "./auth": { getPrincipal: async () => principal } },
  });
  return load("app/workflow/server/request-security.ts");
}

function request(body, headers = {}) {
  return new Request("https://workflow.example/api/workflows/test/runs", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

test("anonymous calls and invalid bearer credentials cannot borrow a browser session", async () => {
  const anonymous = await setup();
  await assert.rejects(anonymous.authenticateRunRequest(request({ input: "test" })), error => error.status === 401);
  const signedIn = await setup(member);
  await assert.rejects(signedIn.authenticateRunRequest(request({}, {
    authorization: "Bearer incorrect", origin: "https://workflow.example",
  })), error => error.status === 401);
  const service = await anonymous.authenticateRunRequest(request({}, { authorization: `Bearer ${token}` }));
  assert.equal(service.id, "api:automation");
});

test("cookie-authenticated mutations reject missing or foreign Origin", async () => {
  const security = await setup(member);
  for (const headers of [{}, { origin: "https://attacker.example" }]) {
    await assert.rejects(security.authenticateRunRequest(request({}, headers)), error => error.status === 403);
  }
  const principal = await security.authenticateRunRequest(request({}, { origin: "https://workflow.example" }));
  assert.equal(principal.id, member.id);
});

test("JSON parser rejects null, arrays and non-JSON content before execution", async () => {
  const security = await setup();
  for (const body of [null, [], "text"]) {
    await assert.rejects(security.readJsonObject(request(body)), error => error.status === 400);
  }
  await assert.rejects(security.readJsonObject(request({}, { "content-type": "text/plain" })), error => error.status === 415);
  const parsed = await security.readJsonObject(request({ input: "ข้อความทดสอบ" }));
  assert.equal(parsed.input, "ข้อความทดสอบ");
});

test("body byte budget also applies to streaming requests without Content-Length", async () => {
  const security = await setup();
  const chunks = [new TextEncoder().encode('{"input":"'), new Uint8Array(32), new Uint8Array(32)];
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { const chunk = chunks.shift(); chunk ? controller.enqueue(chunk) : controller.close(); },
    cancel() { cancelled = true; },
  });
  const streamed = new Request("https://workflow.example/api", {
    method: "POST", body, duplex: "half", headers: { "content-type": "application/json" },
  });
  await assert.rejects(security.readJsonObject(streamed, 24), error => error.status === 413);
  assert.equal(cancelled, true);
});

test("run endpoint denies before side effects and fails closed when shared quota is unavailable", async () => {
  let principal = null;
  let admissions = 0;
  let executions = 0;
  const load = createModuleLoader({
    env: { NEXTAUTH_URL: "https://workflow.example" },
    stubs: {
      nanoid: { nanoid: () => "test-id" },
      "./auth": { getPrincipal: async () => principal },
      "next/server": { NextResponse: Response, after: () => {} },
      "../../../../workflow/server/liveblocks": {
        getWorkflow: async () => ({ workflowId: "test" }), getRoomId: () => "private-room",
        readWorkflowGraph: async () => { throw new Error("No question should not pre-read graph"); },
      },
      "../../../../workflow/server/run-admission": {
        acquireRunLease: async () => { admissions++; throw new Error("Redis unavailable"); },
      },
      "../../../../workflow/server/executor": {
        startWorkflowRun: () => { executions++; throw new Error("Must not execute"); },
      },
    },
  });
  const route = await load("app/api/workflows/[workflowId]/runs/route.ts");
  const params = { params: Promise.resolve({ workflowId: "test" }) };
  const unauthenticated = request({ input: "test" });
  unauthenticated.nextUrl = new URL(unauthenticated.url);
  assert.equal((await route.POST(unauthenticated, params)).status, 401);
  assert.equal(admissions, 0);
  principal = member;
  const authenticated = request({ input: "test" }, { origin: "https://workflow.example" });
  authenticated.nextUrl = new URL(authenticated.url);
  assert.equal((await route.POST(authenticated, params)).status, 503);
  assert.equal(executions, 0);
});

test("run questions reject invalid types, UTF-16 overflow and unreachable LLMs before admission", async () => {
  let graph;
  let serial = 0;
  let admissions = 0;
  let executions = 0;
  let reads = 0;
  const load = createModuleLoader({
    env: { NEXTAUTH_URL: "https://workflow.example" },
    stubs: {
      nanoid: { nanoid: () => `id${++serial}` },
      "./auth": { getPrincipal: async () => member },
      "next/server": { NextResponse: Response, after: () => {} },
      "../../../../workflow/server/liveblocks": {
        getWorkflow: async () => ({ workflowId: "test" }), getRoomId: () => "private-room",
        readWorkflowGraph: async () => { reads++; return graph; },
      },
      "../../../../workflow/server/run-admission": {
        acquireRunLease: async () => { admissions++; return { release: async () => {} }; },
      },
      "../../../../workflow/server/executor": {
        startWorkflowRun: () => {
          executions++;
          return { runId: "run-test", trace$: Promise.resolve({ status: "complete" }) };
        },
      },
    },
  });
  const route = await load("app/api/workflows/[workflowId]/runs/route.ts");
  const s = await load("app/workflow/shared");
  async function post(question) {
    const req = request({ input: "data", question }, { origin: "https://workflow.example" });
    req.nextUrl = new URL(req.url);
    return route.POST(req, { params: Promise.resolve({ workflowId: "test" }) });
  }
  for (const question of [null, 42, {}, []]) assert.equal((await post(question)).status, 400);
  assert.equal((await post("😀".repeat(s.MAX_QUESTION_CHARS / 2) + "x")).status, 413);
  assert.equal(reads, 0);
  graph = {
    nodes: [
      s.createInputNode({ position: { x: 0, y: 0 } }),
      s.createLlmNode({ id: "disconnected", position: { x: 1, y: 0 } }),
      s.createOutputNode({ position: { x: 2, y: 0 } }),
    ],
    edges: [s.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "output", targetHandle: "customer" })],
  };
  assert.equal((await post("Summarize")).status, 400);
  assert.equal(admissions, 0);
  assert.equal(executions, 0);
  // Blank questions preserve ordinary no-question runs, even without an LLM.
  assert.equal((await post(" \n\t ")).status, 202);
  assert.equal(reads, 1);
  graph.edges.push(s.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "disconnected" }));
  assert.equal((await post("😀".repeat(s.MAX_QUESTION_CHARS / 2))).status, 202);
  assert.equal(admissions, 2);
  assert.equal(executions, 2);
});
