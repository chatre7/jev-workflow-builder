import assert from "node:assert/strict";
import test from "node:test";
import { createModuleLoader } from "./load-module.mjs";
import * as csvParse from "csv-parse/sync";
import { createFakeRedis } from "./fake-redis.mjs";

const owner = { id: "owner", name: "Owner", avatar: "", color: "#7654cb" };
const env = {
  NEXTAUTH_URL: "https://workflow.example",
  UPSTASH_REDIS_REST_URL: "https://redis.example",
  UPSTASH_REDIS_REST_TOKEN: "local-redis-token",
  WORKFLOW_WORKSPACE_ID: "team-a",
};
// Modules run in a vm realm, so compare structure rather than prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function harness({ principal = owner, stubs = {} } = {}) {
  let ids = 0;
  const auth = { getPrincipal: async () => principal };
  const redis = createFakeRedis();
  const load = createModuleLoader({ env, stubs: {
    nanoid: { nanoid: () => `generated${++ids}` },
    "next/server": { NextResponse: Response, after: (callback) => { void callback(); } },
    "./auth": auth,
    "../../../../workflow/server/auth": auth,
    "../../../../../workflow/server/auth": auth,
    "@upstash/redis": { Redis: redis.Redis },
    "csv-parse/sync": csvParse,
    ...stubs,
  } });
  const shared = await load("app/workflow/shared");
  const store = await load("app/workflow/server/store");
  return { load, shared, store, redis };
}

function request(path, init = {}) {
  const value = new Request(`https://workflow.example${path}`, init);
  value.nextUrl = new URL(value.url);
  return value;
}

function graphOf(shared) {
  const input = shared.createInputNode({ position: { x: 0, y: 0 } });
  const output = shared.createOutputNode({ position: { x: 2, y: 0 } });
  return {
    nodes: [input, output],
    edges: [shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "output", targetHandle: "customer" })],
  };
}

test("graph saves are versioned: a stale version is refused and the newer graph survives", async () => {
  const h = await harness();
  const created = await h.store.createWorkflow(owner, { name: "Versioned" });
  const first = await h.store.getWorkflowGraph(created.workflowId, owner);
  assert.deepEqual(plain(first), { graph: { nodes: [], edges: [] }, version: 1 });
  const graph = graphOf(h.shared);
  const saved = await h.store.saveWorkflowGraph(created.workflowId, owner, graph, 1);
  assert.equal(saved.version, 2);
  // Runtime state is stripped before storage.
  const decorated = { nodes: graph.nodes.map((node) => ({ ...node, selected: true, measured: { width: 1 } })), edges: graph.edges };
  assert.equal((await h.store.saveWorkflowGraph(created.workflowId, owner, decorated, 2)).version, 3);
  const stored = await h.store.getWorkflowGraph(created.workflowId, owner);
  assert.equal(stored.version, 3);
  assert.ok(stored.graph.nodes.every((node) => !("selected" in node) && !("measured" in node)));
  await assert.rejects(h.store.saveWorkflowGraph(created.workflowId, owner, { nodes: [], edges: [] }, 2), (error) => error.status === 409);
  assert.equal((await h.store.getWorkflowGraph(created.workflowId, owner)).graph.nodes.length, 2);
  await assert.rejects(h.store.saveWorkflowGraph("missing-workflow", owner, graph, 1), (error) => error.status === 404);
  // The executor reads the same graph through the workflow scope.
  const read = await h.store.readWorkflowGraph(h.store.getRoomId(created.workflowId));
  assert.deepEqual(plain(read), plain(stored.graph));
  await assert.rejects(h.store.readWorkflowGraph("jev:workflows:team-b:" + created.workflowId), /Invalid workflow scope/);
  // Renaming bumps the list order without touching the graph version.
  await h.store.renameWorkflow(created.workflowId, owner, "  Renamed  ");
  assert.equal((await h.store.getWorkflow(created.workflowId, owner)).name, "Renamed");
  assert.equal((await h.store.getWorkflowGraph(created.workflowId, owner)).version, 3);
});

test("run store keeps the newest runs per workflow, upserts node traces, and refuses to delete a running run", async () => {
  const h = await harness();
  const created = await h.store.createWorkflow(owner, { name: "Runs" });
  const roomId = h.store.getRoomId(created.workflowId);
  const runStore = h.store.getRunStore();
  for (let index = 1; index <= h.store.MAX_STORED_RUNS + 2; index++) {
    await runStore.createRun({ roomId, runId: `run-${index}`, metadata: { status: "complete", trigger: "test", input: `${index}`, startedAt: String(index) } });
  }
  const runs = await h.store.listRuns(created.workflowId);
  assert.equal(runs.length, h.store.MAX_STORED_RUNS);
  assert.equal(runs[0].runId, `run-${h.store.MAX_STORED_RUNS + 2}`);
  assert.equal(await h.store.getRun(created.workflowId, "run-1"), null);
  assert.equal(await h.store.getRunMetadata(created.workflowId, "run-2"), null);

  const runId = "run-live";
  await runStore.createRun({ roomId, runId, metadata: { status: "running", trigger: "api", input: "hello", startedAt: "100" } });
  await runStore.writeNode({ roomId, runId, data: { nodeId: "input", nodeType: "input", label: "Input", status: "complete", parentNodeIds: [], input: "hello", startedAt: 100 } });
  await runStore.writeNode({ roomId, runId, data: { nodeId: "llm", nodeType: "llm", label: "LLM", status: "running", parentNodeIds: ["input"], input: "hello", output: "Par", startedAt: 101 } });
  await runStore.writeNode({ roomId, runId, data: { nodeId: "llm", nodeType: "llm", label: "LLM", status: "complete", parentNodeIds: ["input"], input: "hello", output: "Partial reply done", startedAt: 101 } });
  const run = await h.store.getRun(created.workflowId, runId);
  assert.deepEqual(plain(run.nodes.map((node) => [node.nodeId, node.status])), [["input", "complete"], ["llm", "complete"]]);
  assert.equal(run.metadata.status, "running");
  assert.equal(await h.store.deleteRun(created.workflowId, runId), false);
  await runStore.updateRun({ roomId, runId, metadata: { status: "complete", trigger: "api", input: "hello", startedAt: "100", completedAt: "200", cost: "0.01" } });
  assert.deepEqual(plain(await h.store.getRunMetadata(created.workflowId, runId)), {
    status: "complete", trigger: "api", input: "hello", startedAt: "100", completedAt: "200", cost: "0.01",
  });
  // Another workflow cannot read or delete this run by ID.
  const other = await h.store.createWorkflow(owner, { name: "Other" });
  assert.equal(await h.store.getRun(other.workflowId, runId), null);
  assert.equal(await h.store.getRunMetadata(other.workflowId, runId), null);
  assert.equal(await h.store.deleteRun(created.workflowId, runId), true);
  assert.equal(await h.store.getRun(created.workflowId, runId), null);
  assert.ok(!(await h.store.listRuns(created.workflowId)).some((entry) => entry.runId === runId));
});

test("graph route requires the owner session and same origin, validates shape, and reports conflicts", async () => {
  const h = await harness();
  const route = await h.load("app/api/workflows/[workflowId]/graph/route");
  const created = await h.store.createWorkflow(owner, { name: "Route" });
  const params = { params: Promise.resolve({ workflowId: created.workflowId }) };
  const put = (body, headers = {}) => route.PUT(request(`/api/workflows/${created.workflowId}/graph`, {
    method: "PUT", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "https://workflow.example", ...headers },
  }), params);
  const graph = graphOf(h.shared);
  assert.equal((await put({ graph, version: 1 }, { authorization: "Bearer run-only-token-0123456789abcdef" })).status, 403);
  assert.equal((await put({ graph, version: 1 }, { origin: "https://attacker.example" })).status, 403);
  assert.equal((await put({ graph: { nodes: [{ id: "x" }], edges: [] }, version: 1 })).status, 400);
  assert.equal((await put({ graph, version: 1, extra: true })).status, 400);
  const ok = await put({ graph, version: 1 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { version: 2 });
  assert.equal((await put({ graph, version: 1 })).status, 409);
  const get = await route.GET(request(`/api/workflows/${created.workflowId}/graph`), params);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).version, 2);
  const anonymous = await harness({ principal: null });
  const anonymousRoute = await anonymous.load("app/api/workflows/[workflowId]/graph/route");
  assert.equal((await anonymousRoute.GET(request(`/api/workflows/${created.workflowId}/graph`), params)).status, 401);
});

test("run history routes expose stored runs to the owner only and delete finished runs", async () => {
  const h = await harness();
  const created = await h.store.createWorkflow(owner, { name: "History" });
  const roomId = h.store.getRoomId(created.workflowId);
  const runStore = h.store.getRunStore();
  await runStore.createRun({ roomId, runId: "run-a", metadata: { status: "complete", trigger: "test", input: "a", startedAt: "1" } });
  await runStore.writeNode({ roomId, runId: "run-a", data: { nodeId: "input", nodeType: "input", label: "Input", status: "complete", parentNodeIds: [], input: "a", startedAt: 1 } });
  const list = await h.load("app/api/workflows/[workflowId]/runs/route");
  const one = await h.load("app/api/workflows/[workflowId]/runs/[runId]/route");
  const listParams = { params: Promise.resolve({ workflowId: created.workflowId }) };
  const oneParams = { params: Promise.resolve({ workflowId: created.workflowId, runId: "run-a" }) };
  const bearer = { headers: { authorization: "Bearer run-only-token-0123456789abcdef" } };
  assert.equal((await list.GET(request(`/api/workflows/${created.workflowId}/runs`, bearer), listParams)).status, 403);
  assert.equal((await one.GET(request(`/api/workflows/${created.workflowId}/runs/run-a`, bearer), oneParams)).status, 403);
  const listed = await list.GET(request(`/api/workflows/${created.workflowId}/runs`), listParams);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).runs.map((run) => run.runId), ["run-a"]);
  const loaded = await one.GET(request(`/api/workflows/${created.workflowId}/runs/run-a`), oneParams);
  assert.equal(loaded.status, 200);
  const body = await loaded.json();
  assert.equal(body.metadata.status, "complete");
  assert.equal(body.nodes.length, 1);
  assert.equal((await one.GET(request(`/api/workflows/${created.workflowId}/runs/run-zzz`), { params: Promise.resolve({ workflowId: created.workflowId, runId: "run-zzz" }) })).status, 404);
  const remove = (headers = {}) => one.DELETE(request(`/api/workflows/${created.workflowId}/runs/run-a`, {
    method: "DELETE", headers: { origin: "https://workflow.example", ...headers },
  }), oneParams);
  assert.equal((await remove({ origin: "https://attacker.example" })).status, 403);
  assert.equal((await remove()).status, 200);
  assert.equal((await one.GET(request(`/api/workflows/${created.workflowId}/runs/run-a`), oneParams)).status, 404);
});

test("streamed runs announce the run ID first, then every node and metadata change, then the trace", async () => {
  const events = [];
  const h = await harness({ stubs: {
    "../../../../workflow/server/executor": {
      startWorkflowRun: ({ onEvent }) => {
        const trace = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          onEvent({ type: "run", metadata: { status: "running", trigger: "test", input: "hi", startedAt: "1" } });
          onEvent({ type: "node", data: { nodeId: "input", nodeType: "input", label: "Input", status: "complete", parentNodeIds: [], input: "hi", startedAt: 1 } });
          onEvent({ type: "run", metadata: { status: "complete", trigger: "test", input: "hi", startedAt: "1", completedAt: "2" } });
          return { runId: "run-stream", status: "complete", trigger: "test", input: "hi", startedAt: 1, completedAt: 2, nodes: [], output: {} };
        })();
        return { runId: "run-stream", trace$: trace };
      },
    },
    "../../../../workflow/server/run-admission": { acquireRunLease: async () => ({ release: async () => { events.push("released"); } }) },
  } });
  const created = await h.store.createWorkflow(owner, { name: "Stream" });
  const route = await h.load("app/api/workflows/[workflowId]/runs/route");
  const response = await route.POST(request(`/api/workflows/${created.workflowId}/runs?stream=true`, {
    method: "POST", body: JSON.stringify({ input: "hi", trigger: "test" }),
    headers: { "content-type": "application/json", origin: "https://workflow.example" },
  }), { params: Promise.resolve({ workflowId: created.workflowId }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  const frames = text.trim().split("\n\n").map((frame) => {
    const [eventLine, dataLine] = frame.split("\n");
    return [eventLine.slice(7), JSON.parse(dataLine.slice(6))];
  });
  assert.deepEqual(frames.map(([event]) => event), ["start", "run", "node", "run", "done"]);
  assert.deepEqual(frames[0][1], { runId: "run-stream" });
  assert.equal(frames[2][1].nodeId, "input");
  assert.equal(frames[3][1].status, "complete");
  assert.equal(frames[4][1].runId, "run-stream");
  assert.deepEqual(events, ["released"]);
});
