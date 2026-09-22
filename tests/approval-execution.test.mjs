import assert from "node:assert/strict";
import { test } from "node:test";
import * as csvParse from "csv-parse/sync";
import { createModuleLoader } from "./load-module.mjs";

function approvalStore() {
  const records = new Map();
  let serial = 0;
  return {
    records,
    async saveApprovalCheckpoint(checkpoint, token, initial) {
      const previous = records.get(checkpoint.runId);
      assert(initial ? !previous : previous?.status === "running" && previous.token === token);
      records.set(checkpoint.runId, { status: "waiting", token, payload: JSON.stringify(checkpoint) });
    },
    async finishApprovalRun(_roomId, runId, token, status) {
      if (records.get(runId)?.token === token) records.set(runId, { token, status });
    },
    async claim(runId, nodeId, decision = "approved") {
      const record = records.get(runId);
      if (record?.status !== "waiting") throw new Error("Already consumed");
      const checkpoint = JSON.parse(record.payload);
      assert(checkpoint.pending.some((item) => item.nodeId === nodeId));
      const token = `claim-${++serial}`;
      records.set(runId, { status: "running", token });
      return { checkpoint, token, nodeId, decision, decidedAt: Date.now(), decidedBy: "owner" };
    },
  };
}

async function harness({ store = approvalStore(), graph, http, llm, knowledge } = {}) {
  const events = [];
  const calls = { graph: 0, http: [], llm: [], knowledge: [] };
  let serial = 0;
  const client = {
    createFeed: async (args) => events.push({ kind: "createFeed", ...structuredClone(args) }),
    updateFeed: async (args) => events.push({ kind: "updateFeed", ...structuredClone(args) }),
    createFeedMessage: async (args) => events.push({ kind: "createMessage", ...structuredClone(args) }),
    updateFeedMessage: async (args) => events.push({ kind: "updateMessage", ...structuredClone(args) }),
  };
  const load = createModuleLoader({ stubs: {
    nanoid: { nanoid: () => `id${++serial}` },
    "csv-parse/sync": csvParse,
    "./liveblocks": { getLiveblocks: () => client, readWorkflowGraph: async () => { calls.graph++; return graph; } },
    "./approvals": store,
    "./http": { runHttpRequest: async (options) => { calls.http.push(options); return http ? http(options) : { text: "upstream-result", status: 200 }; } },
    "./knowledge": { searchKnowledge: async (options) => { calls.knowledge.push(options); return knowledge ? knowledge(options) : '{"matches":[]}'; } },
    "./llm": { runLlm: async (options) => {
      calls.llm.push(options);
      const text = llm ? llm(options) : "provider-result";
      options.reserveOutput(text);
      return { text, model: "test", mock: false };
    } },
    "./typesafe": { askJev: async () => { throw new Error("Unexpected Jev call"); }, toTypeSafeQuestions: () => ({}) },
  } });
  const shared = await load("app/workflow/shared");
  const executor = await load("app/workflow/server/executor");
  return { shared, executor, load, store, events, calls, setGraph: (value) => { graph = value; } };
}

function node(shared, type, id) {
  const factory = { input: shared.createInputNode, output: shared.createOutputNode, http: shared.createHttpNode,
    approval: shared.createApprovalNode, llm: shared.createLlmNode, knowledge: shared.createKnowledgeNode }[type];
  const value = factory({ id, position: { x: 0, y: 0 } });
  if (type === "http") Object.assign(value.data, { connection: "test", path: "/lookup", method: "GET", body: "" });
  if (type === "llm") value.data.prompt = "Reply to {{input}}";
  if (type === "approval") value.data.prompt = "Approve {{input}}?";
  return value;
}

function edge(shared, source, target, sourceHandle = "out", targetHandle = target === "output" ? "customer" : "in") {
  return shared.createWorkflowEdge({ source, target, sourceHandle, targetHandle });
}

function chain(h, types) {
  const middle = types.map((type, index) => node(h.shared, type, `${type}-${index}`));
  const nodes = [node(h.shared, "input", "input"), ...middle, node(h.shared, "output", "output")];
  return { nodes, edges: nodes.slice(1).map((target, index) => edge(h.shared, nodes[index].id, target.id, nodes[index].type === "approval" ? "approved" : "out")) };
}

async function start(h, input = "original-input") {
  return h.executor.startWorkflowRun({ roomId: "room", input, trigger: "test" }).trace$;
}

for (const decision of ["approved", "rejected"]) {
  test(`${decision}: restart resumes immutable graph exactly once without replaying HTTP or provider work`, async () => {
    const h = await harness();
    const graph = chain(h, ["llm", "http", "approval", "llm"]);
    graph.edges.push(edge(h.shared, "approval-2", "output", "rejected", "team"));
    h.setGraph(graph);
    const waiting = await start(h);
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.completedAt, undefined);
    assert.equal(waiting.nodes.some((entry) => entry.nodeId === "llm-3" || entry.nodeId === "output"), false);
    assert.equal(h.calls.llm.length, 1);
    assert.equal(h.calls.http.length, 1);
    assert.deepEqual(Array.from(waiting.output.customer), []);
    assert.equal(h.events.at(-1).metadata.status, "waiting");
    const expiresAt = waiting.nodes.find((entry) => entry.nodeType === "approval").approval.expiresAt;
    assert(expiresAt > Date.now() + 23 * 60 * 60 * 1000);

    // New module context models a server restart; edited live graph is never read.
    graph.nodes.find((entry) => entry.id === "llm-3").data.prompt = "edited live graph";
    const restarted = await harness({ store: h.store, graph, llm: (options) => options.prompt });
    const claim = await h.store.claim(waiting.runId, "approval-2", decision);
    const resumed = await restarted.executor.resumeWorkflowRun(claim).trace$;
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.runId, waiting.runId);
    assert.equal(resumed.startedAt, waiting.startedAt);
    assert.equal(restarted.calls.graph, 0);
    assert.equal(restarted.calls.http.length, 0);
    assert.equal(restarted.calls.llm.length, decision === "approved" ? 1 : 0);
    assert.deepEqual(Array.from(resumed.output.customer), decision === "approved" ? ["Reply to upstream-result"] : []);
    assert.deepEqual(Array.from(resumed.output.team), decision === "rejected" ? ["upstream-result"] : []);
    const approval = resumed.nodes.find((entry) => entry.nodeId === "approval-2");
    assert.equal(approval.approval.decision, decision);
    assert.equal(approval.approval.decidedBy, "owner");
    assert.equal(approval.approval.expiresAt, expiresAt);
    assert.equal(restarted.events.some((entry) => entry.kind === "createFeed"), false);
    assert(restarted.events.some((entry) => entry.kind === "updateMessage" && entry.messageId === `${waiting.runId}-approval-2`));
    await assert.rejects(h.store.claim(waiting.runId, "approval-2", decision), /consumed/);
  });
}

test("parallel approvals block OR joins and output until every potential parent settles", async () => {
  const h = await harness({ llm: (options) => options.prompt });
  const s = h.shared;
  const graph = {
    nodes: [node(s, "input", "input"), node(s, "approval", "left"), node(s, "approval", "right"), node(s, "llm", "join"), node(s, "output", "output")],
    edges: [edge(s, "input", "left"), edge(s, "input", "right"), edge(s, "input", "join"),
      edge(s, "left", "join", "approved"), edge(s, "right", "join", "approved"), edge(s, "join", "output"),
      edge(s, "left", "output", "rejected", "team"), edge(s, "right", "output", "rejected", "team")],
  };
  h.setGraph(graph);
  const waiting = await start(h);
  assert.equal(h.calls.llm.length, 0);
  const one = await h.executor.resumeWorkflowRun(await h.store.claim(waiting.runId, "left")).trace$;
  assert.equal(one.status, "waiting");
  assert.equal(h.calls.llm.length, 0);
  assert.equal(one.nodes.some((entry) => entry.nodeId === "output"), false);
  const both = await h.executor.resumeWorkflowRun(await h.store.claim(waiting.runId, "right", "rejected")).trace$;
  assert.equal(both.status, "complete");
  assert.equal(h.calls.llm.length, 1);
  assert.deepEqual(Array.from(both.output.customer), ["Reply to original-input\n\noriginal-input"]);
  assert.deepEqual(Array.from(both.output.team), ["original-input"]);
});

test("sequential approval phases preserve inherited results, execution counts and cumulative budgets", async () => {
  const h = await harness();
  h.setGraph(chain(h, ["approval", "http", "approval", "knowledge"]));
  const first = await start(h);
  const second = await h.executor.resumeWorkflowRun(await h.store.claim(first.runId, "approval-0")).trace$;
  assert.equal(second.status, "waiting");
  assert.equal(h.calls.http.length, 1);
  assert.equal(h.calls.knowledge.length, 0);
  const saved = JSON.parse(h.store.records.get(first.runId).payload);
  assert.equal(saved.executions, 3);
  const { MAX_RUN_PROMPT_CHARS } = await h.load("app/workflow/server/execution-policy");
  // A legitimate persisted run at the prompt boundary must not get a new budget.
  saved.budget.prompts = MAX_RUN_PROMPT_CHARS;
  h.store.records.get(first.runId).payload = JSON.stringify(saved);
  const limited = await h.executor.resumeWorkflowRun(await h.store.claim(first.runId, "approval-2")).trace$;
  assert.equal(limited.status, "error");
  assert.match(limited.error, /Run prompts/);
  assert.equal(h.calls.http.length, 1);
  assert.equal(h.calls.knowledge.length, 0);
});

test("literal run questions survive multiple frozen approval phases and a server restart", async () => {
  const h = await harness();
  const graph = chain(h, ["approval", "approval", "llm"]);
  h.setGraph(graph);
  const input = "original-data";
  const question = "Explain {{input}} without expanding it.\n" + "q".repeat(300);
  const first = await h.executor.startWorkflowRun({ roomId: "room", input, question, trigger: "test" }).trace$;
  assert.equal(first.status, "waiting");
  assert.equal(first.question, question);
  assert.equal(first.nodes.find((entry) => entry.nodeType === "input").question, question);
  const second = await h.executor.resumeWorkflowRun(await h.store.claim(first.runId, "approval-0")).trace$;
  assert.equal(second.status, "waiting");
  assert.equal(second.question, question);
  // Neither live graph edits nor a fresh process replace checkpoint state.
  graph.nodes.find((entry) => entry.type === "llm").data.prompt = "edited live prompt";
  const restarted = await harness({ store: h.store, graph });
  const resumed = await restarted.executor.resumeWorkflowRun(await h.store.claim(first.runId, "approval-1")).trace$;
  assert.equal(resumed.status, "complete", resumed.error);
  assert.equal(restarted.calls.graph, 0);
  assert.equal(restarted.calls.llm.length, 1);
  assert.ok(restarted.calls.llm[0].prompt.startsWith("Reply to original-data"));
  assert.ok(restarted.calls.llm[0].prompt.endsWith(question));
  assert.doesNotMatch(restarted.calls.llm[0].prompt, /edited live prompt/);
  assert.equal(resumed.question, question);
  assert.equal(resumed.nodes.find((entry) => entry.nodeType === "input").question, question);
  for (const entry of resumed.nodes.filter((node) => node.nodeType === "approval")) {
    assert.equal(entry.input, input);
    assert.equal(entry.output, input);
    assert.equal(entry.approval.prompt, "Approve original-data?");
  }
});

test("approval resume reserves the literal question against the remaining cumulative prompt budget", async () => {
  for (const overflow of [0, 1]) {
    const h = await harness();
    h.setGraph(chain(h, ["approval", "llm"]));
    const question = "q".repeat(h.shared.MAX_QUESTION_CHARS);
    const input = "original-data";
    const waiting = await h.executor.startWorkflowRun({ roomId: "room", input, question, trigger: "test" }).trace$;
    assert.equal(waiting.status, "waiting");
    const record = h.store.records.get(waiting.runId);
    const saved = JSON.parse(record.payload);
    const { MAX_RUN_PROMPT_CHARS } = await h.load("app/workflow/server/execution-policy");
    const prompt = "Reply to original-data\n\nQuestion for this run (answer this question using the data above):\n" + question;
    saved.budget.prompts = MAX_RUN_PROMPT_CHARS - prompt.length + overflow;
    record.payload = JSON.stringify(saved);
    const resumed = await h.executor.resumeWorkflowRun(await h.store.claim(waiting.runId, "approval-0")).trace$;
    assert.equal(resumed.status, overflow ? "error" : "complete", resumed.error);
    assert.equal(h.calls.llm.length, overflow ? 0 : 1);
    if (overflow) assert.match(resumed.error, /Run prompts/);
  }
});

test("knowledge and HTTP render bounded templates and expose real result text and status", async () => {
  const h = await harness({ knowledge: ({ query }) => JSON.stringify({ query, match_count: 0, matches: [] }) });
  const graph = chain(h, ["knowledge", "http"]);
  graph.nodes[1].data.query = "Search {{input}}";
  Object.assign(graph.nodes[2].data, { method: "POST", path: "/search", body: "{{input}}" });
  h.setGraph(graph);
  const trace = await start(h, "policies");
  assert.equal(trace.status, "complete");
  assert.equal(h.calls.knowledge[0].query, "Search policies");
  assert.equal(h.calls.http[0].body, '{"query":"Search policies","match_count":0,"matches":[]}');
  assert.equal(trace.nodes.find((entry) => entry.nodeType === "http").httpStatus, 200);
  assert.deepEqual(Array.from(trace.output.customer), ["upstream-result"]);
});

test("failed checkpoint persistence closes the run and never executes downstream work", async () => {
  const store = approvalStore();
  let finalized = false;
  store.saveApprovalCheckpoint = async () => { throw new Error("private redis credential"); };
  store.finishApprovalRun = async () => { finalized = true; };
  const h = await harness({ store });
  h.setGraph(chain(h, ["approval", "http"]));
  const trace = await start(h);
  assert.equal(trace.status, "error");
  assert.equal(trace.nodes.find((entry) => entry.nodeType === "approval").status, "error");
  assert.equal(h.calls.http.length, 0);
  assert.equal(finalized, true);
  assert.equal(JSON.stringify(trace).includes("private redis credential"), false);
});

test("ambiguous saved checkpoint never publishes its phase token when tombstone cleanup also fails", async () => {
  const store = approvalStore();
  const save = store.saveApprovalCheckpoint.bind(store);
  store.saveApprovalCheckpoint = async (...args) => {
    await save(...args);
    throw new Error("SAVE response was lost");
  };
  store.finishApprovalRun = async () => { throw new Error("Redis remains unavailable"); };
  const h = await harness({ store });
  h.setGraph(chain(h, ["approval", "http"]));
  const trace = await start(h);
  assert.equal(trace.status, "error");
  assert.equal(store.records.get(trace.runId).status, "waiting");
  assert.equal(h.events.some((event) => event.metadata?.approvalToken), false);
  assert.equal(h.calls.http.length, 0);
});

test("a maximum-size graph does not spend execution quota again on approval resumes", async () => {
  const h = await harness();
  h.setGraph(chain(h, Array.from({ length: 24 }, () => "approval")));
  let trace = await start(h, "bounded input");
  for (let index = 0; index < 24; index++) {
    assert.equal(trace.status, "waiting");
    const saved = JSON.parse(h.store.records.get(trace.runId).payload);
    assert.equal(saved.executions, index + 1);
    trace = await h.executor.resumeWorkflowRun(await h.store.claim(trace.runId, `approval-${index}`)).trace$;
  }
  assert.equal(trace.status, "complete");
  assert.deepEqual(Array.from(trace.output.customer), ["bounded input"]);
});

async function routeHarness() {
  let principal = { id: "owner", name: "Owner" };
  let busy = false;
  let unavailable = false;
  let finished;
  let claimFailure;
  let feedMetadata = { status: "waiting", approvalToken: "published-approval-token-for-tests" };
  const calls = { admissions: 0, claims: 0, resumes: 0, releases: 0 };
  const load = createModuleLoader({ env: { NEXTAUTH_URL: "https://workflow.example" }, stubs: {
    nanoid: { nanoid: () => "test-id" },
    "./auth": { getPrincipal: async () => principal },
    "../../../../../../workflow/server/auth": { getPrincipal: async () => principal },
    "next/server": { NextResponse: Response, after: (callback) => { finished = callback(); } },
    "../../../../../../workflow/server/liveblocks": {
      getWorkflow: async () => ({ workflowId: "workflow-id" }), getRoomId: () => "room",
      getLiveblocks: () => ({ getFeed: async () => ({ metadata: feedMetadata }) }),
    },
    "../../../../../../workflow/server/run-admission": { acquireRunLease: async () => {
      calls.admissions++;
      if (busy) throw new security.ApiError(429, "Too many active runs. Wait for a run to finish.");
      if (unavailable) throw new security.ApiError(429, "Daily run or reserved output-token budget reached.");
      return { release: async () => { calls.releases++; } };
    } },
    "../../../../../../workflow/server/approvals": { claimApproval: async (options) => {
      calls.claims++;
      if (claimFailure) throw new security.ApiError(claimFailure, "Approval is unavailable.");
      return options;
    } },
    "../../../../../../workflow/server/executor": { resumeWorkflowRun: (options) => {
      calls.resumes++;
      return { runId: options.runId, trace$: Promise.resolve({ runId: options.runId, status: "waiting", nodes: [], output: {} }) };
    } },
  } });
  const security = await load("app/workflow/server/request-security");
  const route = await load("app/api/workflows/[workflowId]/runs/[runId]/approval/route.ts");
  return {
    calls, security, setPrincipal: (value) => { principal = value; }, setBusy: () => { busy = true; }, setQuota: () => { unavailable = true; },
    failClaim: (status) => { claimFailure = status; },
    setFeed: (metadata) => { feedMetadata = metadata; },
    async post({ body = { nodeId: "approval", decision: "approved" }, headers = {}, wait = false } = {}) {
      const request = new Request(`https://workflow.example/api/workflows/workflow-id/runs/run-test/approval${wait ? "?wait=true" : ""}`, {
        method: "POST", headers: { "content-type": "application/json", origin: "https://workflow.example", ...headers }, body: JSON.stringify(body),
      });
      request.nextUrl = new URL(request.url);
      const response = await route.POST(request, { params: Promise.resolve({ workflowId: "workflow-id", runId: "run-test" }) });
      await finished;
      return response;
    },
  };
}

test("approval endpoint refuses tokens even with an owner session and enforces CSRF and bounded JSON", async () => {
  const h = await routeHarness();
  for (const headers of [{ authorization: "Bearer valid-run-only-token" }, { origin: "https://attacker.example" }, { origin: "" }]) {
    assert.equal((await h.post({ headers })).status, 403);
  }
  assert.equal((await h.post({ body: { nodeId: "a", decision: "approved", decidedBy: "owner" } })).status, 400);
  assert.equal((await h.post({ body: { nodeId: "a", decision: "x".repeat(5000) } })).status, 413);
  h.setPrincipal(null);
  assert.equal((await h.post()).status, 401);
  assert.equal(h.calls.admissions, 0);
  assert.equal(h.calls.claims, 0);
  assert.equal(h.calls.resumes, 0);
});

test("approval admission preserves quotas, maps active phase conflict, and releases on waiting", async () => {
  const quota = await routeHarness();
  quota.setQuota();
  assert.equal((await quota.post()).status, 429);
  assert.equal(quota.calls.claims, 0);
  const busy = await routeHarness();
  busy.setBusy();
  assert.equal((await busy.post()).status, 409);
  assert.equal(busy.calls.resumes, 0);
  const accepted = await routeHarness();
  const response = await accepted.post();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { runId: "run-test", status: "running" });
  assert.equal(accepted.calls.releases, 1);
  const waiting = await accepted.post({ wait: true });
  assert.equal(waiting.status, 200);
  assert.equal((await waiting.json()).status, "waiting");
  assert.equal(accepted.calls.releases, 2);
});

test("duplicate and expired approval claims release admission without starting execution", async () => {
  for (const status of [409, 410, 503]) {
    const h = await routeHarness();
    h.failClaim(status);
    assert.equal((await h.post()).status, status);
    assert.equal(h.calls.resumes, 0);
    assert.equal(h.calls.releases, 1);
  }
});

test("missing publication fence cannot authorize a durable but unconfirmed checkpoint", async () => {
  const h = await routeHarness();
  h.setFeed({ status: "waiting" });
  assert.equal((await h.post()).status, 410);
  assert.equal(h.calls.claims, 0);
  assert.equal(h.calls.resumes, 0);
  assert.equal(h.calls.releases, 1);
});
