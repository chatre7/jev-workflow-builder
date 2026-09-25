import assert from "node:assert/strict";
import test from "node:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { Redis } from "@upstash/redis";
import * as csvParse from "csv-parse/sync";
import { createModuleLoader } from "./load-module.mjs";

function fixtures(shared, kind = "llm") {
  const input = shared.createInputNode({ position: { x: 0, y: 0 } });
  const output = shared.createOutputNode({ position: { x: 2, y: 0 } });
  const factory = {
    jev: shared.createJevNode,
    llm: shared.createLlmNode,
    condition: shared.createConditionNode,
    transform: shared.createTransformNode,
  }[kind];
  const middle = factory({ id: "middle", position: { x: 1, y: 0 } });
  return {
    nodes: [input, middle, output],
    edges: [
      shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "middle" }),
      shared.createWorkflowEdge({ source: "middle", sourceHandle: kind === "jev" ? "any" : kind === "condition" ? "true" : "out", target: "output", targetHandle: "customer" }),
      ...(kind === "condition" ? [
        shared.createWorkflowEdge({ source: "middle", sourceHandle: "false", target: "output", targetHandle: "team" }),
      ] : []),
    ],
  };
}

async function harness({ streamText, readGraph, clientOverrides = {}, approvals, env = {}, globals = {} } = {}) {
  let serial = 0;
  let graph;
  const events = [];
  const client = {
    createFeed: async (params) => { events.push({ kind: "createFeed", ...structuredClone(params) }); },
    updateFeed: async (params) => { events.push({ kind: "updateFeed", ...structuredClone(params) }); },
    createFeedMessage: async (params) => { events.push({ kind: "message", ...structuredClone(params) }); return { id: params.id }; },
    updateFeedMessage: async (params) => { events.push({ kind: "message", ...structuredClone(params) }); },
    ...clientOverrides,
  };
  const load = createModuleLoader({
    stubs: {
      nanoid: { nanoid: () => `id${++serial}` },
      "@openrouter/ai-sdk-provider": { createOpenRouter },
      "@upstash/redis": { Redis },
      "csv-parse/sync": csvParse,
      "./auth": { getPrincipal: async () => null },
      "./liveblocks": { getWorkspaceId: () => "private", getLiveblocks: () => client, readWorkflowGraph: (...args) => readGraph ? readGraph(...args) : Promise.resolve(graph) },
      ...(approvals ? { "./approvals": approvals } : {}),
      ai: { streamText: streamText ?? (() => ({ textStream: (async function* () { yield "A helpful reply."; })() })) },
    },
    env,
    globals,
  });
  const shared = await load("app/workflow/shared");
  return { load, shared, events, setGraph: (value) => { graph = value; } };
}

test("current demo routes validated Jev results to customer and team outputs", async () => {
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: () => ({ textStream: (async function* () { yield "We apologize for the duplicate charge and will refund it today."; })() }),
    globals: { fetch: async (_url, init) => {
      const { questions } = JSON.parse(init.body);
      const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        if (question.type === "noul") return [id, { type: "noul", noul: 1 }];
        if (question.type === "choice") return [id, {
          type: "choice", choice: "billing", confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "billing" ? 1 : 0])),
        }];
        return [id, {
          type: "score", score: 2, confidence: 1,
          probabilities: { "0": 0, "1": 0, "2": 1 },
          legend: { "0": "calm", "1": "concerned", "2": "angry" },
        }];
      }));
      return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 10 } }));
    } },
  });
  const demo = await h.load("app/workflow/demo");
  h.setGraph(demo.createDemoWorkflow());
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: demo.DEMO_SAMPLE_INPUT, trigger: "test" }).trace$;
  assert.equal(trace.status, "complete");
  assert.deepEqual(Array.from(trace.output.customer), ["We apologize for the duplicate charge and will refund it today."]);
  assert.deepEqual(Array.from(trace.output.team), ["We apologize for the duplicate charge and will refund it today."]);
  assert.equal(h.events.at(-1).metadata.status, "complete");
});

test("rejects hostile storage structures before any provider is called", async () => {
  let providerCalls = 0;
  const h = await harness({ env: { OPENROUTER_API_KEY: "test-key" }, streamText: () => { providerCalls++; throw new Error("must not call"); } });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const variants = [
    (g) => { g.nodes[1].data.model = "unlisted/expensive-model"; },
    (g) => { g.nodes[1].type = "unknown"; },
    (g) => { g.nodes[1].id = "input"; },
    (g) => { g.edges[0].sourceHandle = "invented"; },
    (g) => { g.edges[1].targetHandle = "invented"; },
    (g) => { g.nodes[2].data.properties[0].name = "__proto__"; },
    (g) => { g.nodes[1].type = "jev"; g.nodes[1].data = { label: "Empty bypass", questions: [] }; },
    (g) => { g.edges.push({ ...g.edges[0], id: "duplicate" }); },
  ];
  for (const mutate of variants) {
    const graph = fixtures(h.shared);
    mutate(graph);
    h.setGraph(graph);
    const trace = await startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" }).trace$;
    assert.equal(trace.status, "error");
    assert.equal(h.events.at(-1).metadata.status, "error");
  }
  assert.equal(providerCalls, 0);
});

test("Jev model selection, question limits, and reserved state keys are enforced", async () => {
  const h = await harness();
  const { validateWorkflowGraph } = await h.load("app/workflow/server/execution-validation");
  const { MAX_QUESTIONS, MAX_CRITERIA } = await h.load("app/workflow/server/execution-policy");
  for (const mutate of [
    (data) => { data.model = "openai/gpt-5.4-nano"; },
    (data) => { data.questions = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => h.shared.createQuestion("choice", i)); },
    (data) => { data.questions[0].options = Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => ({ key: `key_${i}`, description: "" })); },
    (data) => { data.questions[0].id = "input"; },
    (data) => { data.questions[0].options[1].key = data.questions[0].options[0].key; },
    (data) => { data.questions = [{ id: "q", type: "noul", instructions: "", threshold: NaN }]; },
  ]) {
    const graph = fixtures(h.shared, "jev");
    mutate(graph.nodes[1].data);
    assert.throws(() => validateWorkflowGraph(graph));
  }
});

test("fan-in amplification fails before allocating downstream input", async () => {
  const h = await harness();
  const graph = fixtures(h.shared);
  const branches = ["left", "right"].map((id) => h.shared.createJevNode({ id, position: { x: 1, y: 0 } }));
  graph.nodes.push(...branches);
  graph.edges = [graph.edges[1], ...branches.flatMap((node) => [
    h.shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: node.id }),
    h.shared.createWorkflowEdge({ source: node.id, sourceHandle: "any", target: "middle" }),
  ])];
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "x".repeat(20_000), trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.match(trace.error, /Node text/);
  assert.equal(trace.nodes.find((node) => node.nodeId === "middle").input, "");
});

test("hard fan-in cap rejects a graph before execution", async () => {
  const h = await harness();
  const graph = fixtures(h.shared);
  for (let i = 0; i < 9; i++) {
    const id = `branch_${i}`;
    graph.nodes.push(h.shared.createJevNode({ id, position: { x: 1, y: 0 } }));
    graph.edges.push(h.shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: id }));
    graph.edges.push(h.shared.createWorkflowEdge({ source: id, sourceHandle: "any", target: "middle" }));
  }
  const { validateWorkflowGraph } = await h.load("app/workflow/server/execution-validation");
  assert.throws(() => validateWorkflowGraph(graph), /incoming connections/);
});

test("template substitution is preflighted and prompt budgets are cumulative", async () => {
  const h = await harness();
  const { boundedTemplates, RunBudget, MAX_RUN_PROMPT_CHARS, MAX_NODE_PROMPT_CHARS } = await h.load("app/workflow/server/execution-policy");
  const budget = new RunBudget();
  assert.throws(() => boundedTemplates(["{{input}}".repeat(20)], { input: "x".repeat(20_000), answers: {} }, budget), /Node prompt/);
  const context = { input: "x".repeat(MAX_NODE_PROMPT_CHARS), answers: {} };
  for (let size = 0; size < MAX_RUN_PROMPT_CHARS; size += MAX_NODE_PROMPT_CHARS) boundedTemplates(["{{input}}"], context, budget);
  assert.throws(() => boundedTemplates(["extra"], context, budget), /Run prompts/);
});

test("templates read only own answer fields", async () => {
  const h = await harness();
  const { renderTemplate } = await h.load("app/workflow/shared");
  const answers = { risk: { value: "high", probability: 0.25, confidence: 0.5 } };
  const render = (template) => renderTemplate(template, { input: "in", answers });
  assert.equal(render("{{answers.risk}}|{{answers.risk.probability}}|{{answers.risk.confidence}}"), "high|0.25|0.50");
  assert.equal(render("[{{answers.constructor}}][{{answers.toString.probability}}][{{answers.risk.unknown}}]"), "[][][]");
});

test("streaming previews leave room for every downstream running and complete message", async () => {
  const runs = [];
  for (const streaming of [false, true]) {
    let now = 1_000;
    const h = await harness({
      env: { OPENROUTER_API_KEY: "test-key" },
      globals: { Date: class extends Date { static now() { return now; } } },
      streamText: () => ({ textStream: (async function* () {
        for (let i = 0; i < 100; i++) {
          if (streaming) now += 251;
          yield "b".repeat(80);
        }
      })() }),
    });
    const graph = fixtures(h.shared);
    const conditions = Array.from({ length: 21 }, (_, i) => h.shared.createConditionNode({
      id: `condition-${i}`, position: { x: i + 2, y: 0 },
      source: "input", operator: "contains", value: "b",
    }));
    graph.nodes.splice(2, 0, ...conditions);
    graph.edges = graph.nodes.slice(1).map((target, index) => {
      const source = graph.nodes[index];
      return h.shared.createWorkflowEdge({
        source: source.id, target: target.id,
        sourceHandle: source.type === "condition" ? "true" : "out",
        ...(target.type === "output" ? { targetHandle: "customer" } : {}),
      });
    });
    h.setGraph(graph);
    const { startWorkflowRun } = await h.load("app/workflow/server/executor");
    const trace = await startWorkflowRun({ roomId: "private-room", input: "a".repeat(10_000), trigger: "test" }).trace$;
    assert.equal(trace.status, "complete", trace.error);
    assert.deepEqual(Array.from(trace.output.customer), ["b".repeat(8_000)]);
    assert.equal(trace.nodes.find((node) => node.nodeId === "condition-20").status, "complete");
    const previews = h.events.filter((event) => event.data?.nodeType === "llm" && event.data.status === "running" && event.data.output);
    if (streaming) assert(previews.length > 0, "ordinary runs must retain streaming previews");
    else assert.equal(previews.length, 0);
    const { MAX_RUN_FEED_CHARS, MAX_RUN_TRACE_CHARS } = await h.load("app/workflow/server/execution-policy");
    const written = h.events.reduce((sum, event) => sum + (event.data ? JSON.stringify(event.data).length : 0), 0);
    assert(written <= MAX_RUN_FEED_CHARS - MAX_RUN_TRACE_CHARS - 4_096);
    assert.equal(h.events.at(-1).metadata.status, "complete");
    runs.push(trace);
  }
  assert.deepEqual(Array.from(runs[1].output.customer), Array.from(runs[0].output.customer));
});

test("approval restarts preserve spent preview capacity and the mandatory feed limit", async () => {
  let now = 1_000;
  let checkpoint;
  const approvals = {
    saveApprovalCheckpoint: async (value) => { checkpoint = JSON.parse(JSON.stringify(value)); },
    finishApprovalRun: async () => {},
  };
  const options = {
    approvals,
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: { Date: class extends Date { static now() { return now; } } },
    streamText: () => ({ textStream: (async function* () {
      for (let i = 0; i < 100; i++) {
        now += 251;
        yield "b".repeat(80);
      }
    })() }),
  };
  const h = await harness(options);
  const s = h.shared;
  const nodes = [
    s.createInputNode({ position: { x: 0, y: 0 } }),
    s.createLlmNode({ id: "first-llm", position: { x: 1, y: 0 } }),
    s.createApprovalNode({ id: "first-approval", position: { x: 2, y: 0 } }),
    s.createLlmNode({ id: "second-llm", position: { x: 3, y: 0 } }),
    s.createApprovalNode({ id: "second-approval", position: { x: 4, y: 0 } }),
    s.createOutputNode({ position: { x: 5, y: 0 } }),
  ];
  h.setGraph({ nodes, edges: nodes.slice(1).map((target, index) => s.createWorkflowEdge({
    source: nodes[index].id, target: target.id,
    sourceHandle: nodes[index].type === "approval" ? "approved" : "out",
    ...(target.type === "output" ? { targetHandle: "customer" } : {}),
  })) });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const waiting = await startWorkflowRun({ roomId: "private-room", input: "a".repeat(10_000), trigger: "test" }).trace$;
  assert.equal(waiting.status, "waiting", waiting.error);
  assert(h.events.some((event) => event.data?.nodeType === "llm" && event.data.status === "running" && event.data.output));
  const written = (events) => events.reduce((sum, event) => sum + (event.data ? JSON.stringify(event.data).length : 0), 0);
  assert.equal(checkpoint.budget.feed, written(h.events));
  const claim = (value, nodeId) => ({
    checkpoint: value, nodeId, token: "claimed-phase", decision: "approved", decidedAt: now, decidedBy: "owner",
  });
  const restarted = await harness(options);
  const { resumeWorkflowRun } = await restarted.load("app/workflow/server/executor");
  const next = await resumeWorkflowRun(claim(checkpoint, "first-approval")).trace$;
  assert.equal(next.status, "waiting", next.error);
  assert.equal(restarted.events.filter((event) => event.data?.nodeType === "llm" && event.data.status === "running" && event.data.output).length, 0);
  assert.equal(checkpoint.budget.feed, written(h.events) + written(restarted.events));
  const finalCheckpoint = structuredClone(checkpoint);
  const final = await resumeWorkflowRun(claim(finalCheckpoint, "second-approval")).trace$;
  assert.equal(final.status, "complete", final.error);
  assert.deepEqual(Array.from(final.output.customer), ["b".repeat(8_000)]);

  // A persisted run at the mandatory limit must still fail, not borrow the
  // error-finalization reserve or silently reset its counter on restart.
  const capped = await harness(options);
  const { MAX_RUN_FEED_CHARS, MAX_RUN_TRACE_CHARS } = await capped.load("app/workflow/server/execution-policy");
  finalCheckpoint.budget.feed = MAX_RUN_FEED_CHARS - MAX_RUN_TRACE_CHARS - 4_096;
  const cappedExecutor = await capped.load("app/workflow/server/executor");
  const failed = await cappedExecutor.resumeWorkflowRun(claim(finalCheckpoint, "second-approval")).trace$;
  assert.equal(failed.status, "error");
  assert.match(failed.error, /Run feed writes/);
  assert.equal(capped.events.at(-1).metadata.status, "error");
  assert(capped.events.some((event) => event.data?.nodeId === "second-approval" && event.data.status === "error"));
  assert(finalCheckpoint.budget.feed + written(capped.events) <= MAX_RUN_FEED_CHARS);
});

test("numeric conditions compare decimal text exactly", async () => {
  const h = await harness();
  const { evaluateCondition } = await h.load("app/workflow/server/data-nodes");
  const check = (source, operator, value) => evaluateCondition(
    { source: "json.n", operator, value }, { input: JSON.stringify({ n: source }), answers: {}, parents: {} },
  );
  assert.equal(check("9007199254740993", "gt", "9007199254740992"), true);
  assert.equal(check("0.30000000000000001", "gt", "0.3"), true);
  assert.equal(check("-0.30000000000000001", "lt", "-0.3"), true);
  assert.equal(check("1.50", "gte", "1.5"), true);
  assert.equal(check("1.50", "lte", "15e-1"), true);
  assert.equal(check(".05", "lt", "0.5"), true);
  assert.equal(check("-0", "gte", "0"), true);
  assert.equal(check("-2", "lt", "-1"), true);
  assert.equal(check("0.001", "gt", "-1000"), true);
  assert.equal(check(1e21, "gt", "999999999999999999999"), true);
  assert.equal(check(0.1, "eq", "0.100"), true);
  assert.equal(check(0.1, "ne", "0.1000000000000000055511151231257827"), true);
  assert.throws(() => check("1e400", "gt", "0"), /finite decimal/);
  assert.throws(() => check("0x10", "gt", "0"), /finite decimal/);
  assert.throws(() => check(" 1", "gt", "0"), /finite decimal/);
});

test("JSON trace preflight counts escaping and rejects without serializing", async () => {
  const h = await harness();
  const { jsonSize } = await h.load("app/workflow/server/execution-policy");
  const value = { text: '\u0000\n\t"\\\ud800\udc00\ud800', nested: [true, null, 1.25] };
  const size = JSON.stringify(value).length;
  assert.equal(jsonSize(value, size, "trace"), size);
  assert.throws(() => jsonSize(value, size - 1, "trace"), /trace/);
});

test("LLM refuses oversized deltas before publishing and cancels its transport", async () => {
  let transportSignal;
  const chunks = [];
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: (options) => {
      transportSignal = options.abortSignal;
      return { textStream: (async function* () { yield "x".repeat(16_385); })() };
    },
  });
  const { runLlm } = await h.load("app/workflow/server/llm");
  await assert.rejects(runLlm({
    model: h.shared.DEFAULT_LLM_MODEL, system: "", prompt: "hello", signal: new AbortController().signal,
    reserveOutput: () => { throw new Error("oversized output must be rejected before reservation"); },
    onChunk: (text) => chunks.push(text),
  }), /LLM output/);
  assert.deepEqual(chunks, []);
  assert.equal(transportSignal.aborted, true);
});

test("provider stream errors cannot turn partial output into a successful run", async () => {
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: (options) => ({
      textStream: (async function* () {
        yield "Partial response";
        options.onError({ error: new Error("Bearer private-provider-detail") });
      })(),
    }),
  });
  h.setGraph(fixtures(h.shared));
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.equal(h.events.at(-1).metadata.status, "error");
  assert.equal(JSON.stringify(trace).includes("private-provider-detail"), false);
});

test("mock LLM aborts instead of returning a partial successful answer", async () => {
  const controller = new AbortController();
  const chunks = [];
  const h = await harness();
  const { runLlm } = await h.load("app/workflow/server/llm");
  await assert.rejects(runLlm({
    model: h.shared.DEFAULT_LLM_MODEL, system: "", prompt: "hello", signal: controller.signal,
    reserveOutput: () => {}, onChunk: (text) => { chunks.push(text); controller.abort(); },
  }), /cancelled/);
  assert.equal(chunks.length, 1);
});

test("Jev cancellation reaches the OpenRouter fetch transport", async () => {
  const started = Promise.withResolvers();
  const controller = new AbortController();
  let transportSignal;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: { fetch: async (_url, init) => {
      transportSignal = init.signal;
      started.resolve();
      const pending = Promise.withResolvers();
      init.signal.addEventListener("abort", () => pending.reject(new Error("credential-do-not-leak")), { once: true });
      return pending.promise;
    } },
  });
  const { askJev } = await h.load("app/workflow/server/typesafe");
  const run = askJev(fixtures(h.shared, "jev").nodes[1].data, { input: "hello" }, controller.signal);
  const rejected = assert.rejects(run, /cancelled/);
  await started.promise;
  controller.abort();
  await rejected;
  assert.equal(transportSignal.aborted, true);
});

test("Jev cancels an oversized response before accepting provider data", async () => {
  let cancelled = false;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: { fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(128_001)); },
      cancel() { cancelled = true; },
    })) },
  });
  const { askJev } = await h.load("app/workflow/server/typesafe");
  await assert.rejects(askJev(
    fixtures(h.shared, "jev").nodes[1].data,
    { input: "hello" },
    new AbortController().signal
  ), /oversized response/);
  assert.equal(cancelled, true);
});

test("Jev provider rejection cannot become a mock success or leak its body", async () => {
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: { fetch: async () => new Response("private-provider-detail", { status: 429 }) },
  });
  h.setGraph(fixtures(h.shared, "jev"));
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.doesNotMatch(JSON.stringify(trace), /private-provider-detail/);
});

test("Jev rejects provider choices outside the configured answer set", async () => {
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: { fetch: async () => new Response(JSON.stringify({
      model: "typesafe/jev-1.13",
      answers: { question_1: { type: "choice", choice: "unconfigured", confidence: 1, probabilities: {} } },
    })) },
  });
  const { askJev } = await h.load("app/workflow/server/typesafe");
  await assert.rejects(askJev(
    fixtures(h.shared, "jev").nodes[1].data,
    { input: "hello" },
    new AbortController().signal
  ), /outside the configured criteria/);
});

test("slow providers hit the real deadline and cannot update a finished feed", async () => {
  let fireDeadline;
  const entered = Promise.withResolvers();
  const late = Promise.withResolvers();
  let providerSignal;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: {
      setTimeout: (callback, ms) => ms === 60_000 ? (fireDeadline = callback, { deadline: true }) : setTimeout(callback, ms),
      clearTimeout: (timer) => { if (!timer?.deadline) clearTimeout(timer); },
    },
    streamText: (options) => {
      providerSignal = options.abortSignal;
      return { textStream: (async function* () { entered.resolve(); yield await late.promise; })() };
    },
  });
  h.setGraph(fixtures(h.shared));
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const run = startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" });
  await entered.promise;
  fireDeadline();
  const trace = await run.trace$;
  assert.equal(trace.status, "error");
  assert.match(trace.error, /exceeded/);
  assert.equal(providerSignal.aborted, true);
  assert.equal(h.events.at(-1).metadata.status, "error");
  const terminalCount = h.events.length;
  late.resolve("late provider text");
  const nextTurn = Promise.withResolvers();
  setImmediate(nextTurn.resolve);
  await nextTurn.promise;
  assert.equal(h.events.length, terminalCount);
  assert.equal(trace.nodes.some((node) => node.status === "running"), false);
});

test("snapshot rejection and hanging feed writes still attempt bounded terminal metadata", async () => {
  const metadata = [];
  const h = await harness({
    readGraph: async () => { throw new Error("Bearer credential-do-not-leak"); },
    clientOverrides: {
      createFeed: () => Promise.withResolvers().promise,
      updateFeed: async (params) => { metadata.push(params.metadata); },
    },
    globals: { setTimeout: (callback, ms) => setTimeout(callback, ms === 1_000 ? 5 : ms) },
  });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.equal(metadata.at(-1).status, "error");
  assert.doesNotMatch(JSON.stringify(trace), /credential-do-not-leak/);
});

test("provider execution is bounded to four concurrent calls per run", async () => {
  let concurrent = 0;
  let peak = 0;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: () => ({ textStream: (async function* () {
      concurrent++;
      peak = Math.max(peak, concurrent);
      const nextTurn = Promise.withResolvers();
      setImmediate(nextTurn.resolve);
      await nextTurn.promise;
      concurrent--;
      yield "reply";
    })() }),
  });
  const input = h.shared.createInputNode({ position: { x: 0, y: 0 } });
  const output = h.shared.createOutputNode({ position: { x: 2, y: 0 } });
  const middles = Array.from({ length: 8 }, (_, i) => h.shared.createLlmNode({ id: `llm_${i}`, position: { x: 1, y: i } }));
  h.setGraph({ nodes: [input, ...middles, output], edges: middles.flatMap((node) => [
    h.shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: node.id }),
    h.shared.createWorkflowEdge({ source: node.id, sourceHandle: "out", target: "output", targetHandle: "customer" }),
  ]) });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" }).trace$;
  assert.equal(trace.status, "complete");
  assert.equal(peak, 4);
  assert.deepEqual(Array.from(trace.output.customer), Array(8).fill("reply"));
});

test("a hanging snapshot is cancelled and the run still reaches terminal error", async () => {
  let snapshotSignal;
  const h = await harness({
    readGraph: (_roomId, signal) => { snapshotSignal = signal; return Promise.withResolvers().promise; },
    globals: { setTimeout: (callback, ms) => setTimeout(callback, ms === 5_000 ? 5 : ms) },
  });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.equal(snapshotSignal.aborted, true);
  assert.equal(h.events.at(-1).metadata.status, "error");
});

test("a slow Jev call reaches terminal error and its transport is cancelled", async () => {
  let fireDeadline;
  let transportSignal;
  const entered = Promise.withResolvers();
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: {
      setTimeout: (callback, ms) => ms === 60_000 ? (fireDeadline = callback, { deadline: true }) : setTimeout(callback, ms),
      clearTimeout: (timer) => { if (!timer?.deadline) clearTimeout(timer); },
      fetch: async (_url, init) => {
        transportSignal = init.signal;
        entered.resolve();
        const pending = Promise.withResolvers();
        init.signal.addEventListener("abort", () => pending.reject(new Error("secret-provider-error")), { once: true });
        return pending.promise;
      },
    },
  });
  h.setGraph(fixtures(h.shared, "jev"));
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const run = startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" });
  await entered.promise;
  fireDeadline();
  const trace = await run.trace$;
  assert.equal(trace.status, "error");
  assert.equal(transportSignal.aborted, true);
  assert.equal(h.events.at(-1).metadata.status, "error");
  assert.doesNotMatch(JSON.stringify(trace), /secret-provider-error/);
});

test("failed message writes cannot starve terminal metadata finalization", async () => {
  const metadata = [];
  let cancelledMessage = false;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: () => { throw new Error("Bearer secret-provider-error"); },
    clientOverrides: {
      updateFeedMessage: (params, options) => {
        if (params.data.status !== "error") return Promise.resolve();
        options.signal.addEventListener("abort", () => { cancelledMessage = true; }, { once: true });
        return Promise.withResolvers().promise;
      },
      updateFeed: async (params) => { metadata.push(params.metadata); },
    },
    globals: {
      setTimeout: (callback, ms) => setTimeout(callback, ms === 1_000 ? 5 : ms === 2_000 ? 50 : ms),
    },
  });
  h.setGraph(fixtures(h.shared));
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "hello", trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.equal(cancelledMessage, true);
  assert.equal(metadata.at(-1).status, "error");
  assert.doesNotMatch(JSON.stringify(trace), /secret-provider-error/);
});

test("Condition enforces the refund threshold and selects exactly one output", async () => {
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: () => { throw new Error("A deterministic rule must not call AI."); },
    globals: { fetch: async () => { throw new Error("A deterministic rule must not call AI."); } },
  });
  const graph = fixtures(h.shared, "condition");
  Object.assign(graph.nodes[1].data, { source: "json.amount", operator: "gt", value: "1000" });
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  for (const amount of [1000, 1000.01]) {
    const input = JSON.stringify({ amount });
    const trace = await startWorkflowRun({ roomId: "private-room", input, trigger: "test" }).trace$;
    assert.equal(trace.status, "complete");
    const matched = amount > 1000;
    assert.deepEqual(Array.from(trace.output[matched ? "customer" : "team"]), [input]);
    assert.deepEqual(Array.from(trace.output[matched ? "team" : "customer"]), []);
  }
});

test("invalid Condition inputs fail instead of silently taking the false branch", async () => {
  const h = await harness();
  const graph = fixtures(h.shared, "condition");
  Object.assign(graph.nodes[1].data, { source: "json.amount", operator: "gt", value: "1000" });
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  for (const input of ["not JSON", "{}", '{"amount":null}', '{"amount":"0x20"}']) {
    const trace = await startWorkflowRun({ roomId: "private-room", input, trigger: "test" }).trace$;
    assert.equal(trace.status, "error");
    assert.equal(trace.nodes.find((node) => node.nodeId === "middle").status, "error");
    assert.equal(trace.nodes.some((node) => node.nodeId === "output" && node.status === "complete"), false);
  }
});

test("Transform projects typed JSON without exposing unselected fields", async () => {
  const h = await harness();
  const graph = fixtures(h.shared, "transform");
  graph.nodes[1].data.fields = [
    { id: "reply", name: "customer_draft", source: "json.customer.reply" },
    { id: "note", name: "internal_note", source: "json.internal.note" },
    { id: "approved", name: "approved", source: "json.approved" },
    { id: "amount", name: "amount", source: "json.amount" },
    { id: "items", name: "items", source: "json.items" },
    { id: "first", name: "first_sku", source: "json.items.0.sku" },
  ];
  h.setGraph(graph);
  const input = JSON.stringify({
    customer: { reply: 'Hello\n"customer"' },
    internal: { note: "Keep internal" },
    approved: false, amount: 0, items: [{ sku: "A", quantity: 2 }],
    secret: "Do not include this field",
  });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input, trigger: "test" }).trace$;
  assert.equal(trace.status, "complete");
  assert.deepEqual(JSON.parse(trace.output.customer[0]), {
    customer_draft: 'Hello\n"customer"', internal_note: "Keep internal",
    approved: false, amount: 0, items: [{ sku: "A", quantity: 2 }], first_sku: "A",
  });
});

test("Transform keeps parallel parent outputs separate at an all join", async () => {
  const h = await harness();
  const graph = fixtures(h.shared, "transform");
  const left = h.shared.createTransformNode({
    id: "left", position: { x: 1, y: 0 },
    fields: [{ id: "public", name: "text", source: "json.public" }],
  });
  const right = h.shared.createTransformNode({
    id: "right", position: { x: 1, y: 1 },
    fields: [{ id: "private", name: "note", source: "json.private" }],
  });
  graph.nodes.push(left, right);
  Object.assign(graph.nodes[1].data, {
    activation: "all",
    fields: [
      { id: "customer", name: "customer_draft", source: "parents.left" },
      { id: "team", name: "internal_note", source: "parents.right" },
    ],
  });
  graph.edges = [graph.edges[1], ...[left, right].flatMap((node) => [
    h.shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: node.id }),
    h.shared.createWorkflowEdge({ source: node.id, sourceHandle: "out", target: "middle" }),
  ])];
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({
    roomId: "private-room", input: '{"public":"Hello","private":"Staff only"}', trigger: "test",
  }).trace$;
  assert.equal(trace.status, "complete");
  assert.deepEqual(JSON.parse(trace.output.customer[0]), {
    customer_draft: '{"text":"Hello"}', internal_note: '{"note":"Staff only"}',
  });
});

test("Transform cannot read a parent whose conditional connection did not fire", async () => {
  const h = await harness();
  const graph = fixtures(h.shared, "transform");
  const condition = h.shared.createConditionNode({
    id: "branch", position: { x: 1, y: 0 }, source: "input", operator: "eq", value: "left",
  });
  const right = h.shared.createTransformNode({
    id: "right", position: { x: 1, y: 1 },
    fields: [{ id: "text", name: "text", source: "input" }],
  });
  graph.nodes.push(condition, right);
  graph.nodes[1].data.fields = [{ id: "private", name: "private", source: "parents.right" }];
  graph.edges = [
    graph.edges[1],
    h.shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "branch" }),
    h.shared.createWorkflowEdge({ source: "branch", sourceHandle: "true", target: "middle" }),
    h.shared.createWorkflowEdge({ source: "branch", sourceHandle: "false", target: "right" }),
    h.shared.createWorkflowEdge({ source: "right", sourceHandle: "out", target: "middle" }),
  ];
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "left", trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.equal(trace.nodes.find((node) => node.nodeId === "middle").status, "error");
  assert.equal(trace.nodes.some((node) => node.nodeId === "output" && node.status === "complete"), false);
});

test("data node validation rejects unsafe paths and ambiguous mapping fields", async () => {
  const h = await harness();
  const { validateWorkflowGraph } = await h.load("app/workflow/server/execution-validation");
  for (const mutate of [
    (data) => { data.fields[0].source = "json.account.constructor.prototype"; },
    (data) => { data.fields[0].name = "__proto__"; },
    (data) => { data.fields[0].source = "parents.not-connected"; },
    (data) => { data.fields.push({ ...data.fields[0], id: "other" }); },
    (data) => { data.fields = Array.from({ length: h.shared.MAX_TRANSFORM_FIELDS + 1 }, (_, i) => ({ id: `id_${i}`, name: `field_${i}`, source: "input" })); },
  ]) {
    const graph = fixtures(h.shared, "transform");
    mutate(graph.nodes[1].data);
    assert.throws(() => validateWorkflowGraph(graph));
  }
  const graph = fixtures(h.shared, "condition");
  graph.nodes[1].data.operator = "execute";
  assert.throws(() => validateWorkflowGraph(graph));
});

test("Transform preserves Jev confidence for a later deterministic review rule", async () => {
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    globals: { fetch: async () => new Response(JSON.stringify({
      model: "typesafe/jev-1.13",
      answers: { question_1: { type: "choice", choice: "option_a", confidence: 0.49, probabilities: { option_a: 0.6, option_b: 0.4 } } },
    })) },
  });
  const graph = fixtures(h.shared, "condition");
  Object.assign(graph.nodes[1].data, { source: "answers.question_1.confidence", operator: "lt", value: "0.5" });
  const jev = h.shared.createJevNode({ id: "decision", position: { x: 1, y: 0 } });
  const transform = h.shared.createTransformNode({
    id: "mapped", position: { x: 2, y: 0 },
    fields: [{ id: "message", name: "message", source: "input" }],
  });
  graph.nodes.push(jev, transform);
  graph.edges = [
    ...graph.edges.slice(1),
    h.shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "decision" }),
    h.shared.createWorkflowEdge({ source: "decision", sourceHandle: "any", target: "mapped" }),
    h.shared.createWorkflowEdge({ source: "mapped", sourceHandle: "out", target: "middle" }),
  ];
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "uncertain case", trigger: "test" }).trace$;
  assert.equal(trace.status, "complete");
  assert.deepEqual(Array.from(trace.output.customer), ['{"message":"uncertain case"}']);
  assert.deepEqual(Array.from(trace.output.team), []);
});

test("Transform expansion cannot bypass output text limits", async () => {
  const h = await harness();
  const graph = fixtures(h.shared, "transform");
  graph.nodes[1].data.fields = Array.from({ length: 8 }, (_, i) => ({
    id: `id_${i}`, name: `copy_${i}`, source: "input",
  }));
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "private-room", input: "x".repeat(5000), trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.equal(trace.nodes.find((node) => node.nodeId === "middle").status, "error");
  assert.equal(trace.nodes.some((node) => node.nodeId === "output" && node.status === "complete"), false);
});

test("connected node configuration fails validation before execution", async () => {
  const h = await harness();
  const { validateWorkflowGraph } = await h.load("app/workflow/server/execution-validation");
  const variants = [
    h.shared.createHttpNode({ id: "middle", position: { x: 1, y: 0 }, connection: "__proto__" }),
    h.shared.createHttpNode({ id: "middle", position: { x: 1, y: 0 }, connection: "orders", method: "DELETE" }),
    h.shared.createHttpNode({ id: "middle", position: { x: 1, y: 0 }, connection: "orders", method: "GET", body: "{}" }),
    h.shared.createKnowledgeNode({ id: "middle", position: { x: 1, y: 0 }, topK: 6 }),
    h.shared.createKnowledgeNode({ id: "middle", position: { x: 1, y: 0 }, query: " " }),
    h.shared.createApprovalNode({ id: "middle", position: { x: 1, y: 0 }, prompt: "" }),
    h.shared.createCsvNode({ id: "middle", position: { x: 1, y: 0 }, delimiter: "|" }),
    h.shared.createCsvNode({ id: "middle", position: { x: 1, y: 0 }, headers: "true" }),
  ];
  for (const node of variants) {
    const graph = fixtures(h.shared);
    graph.nodes[1] = node;
    graph.edges[1].sourceHandle = node.type === "approval" ? "approved" : "out";
    assert.throws(() => validateWorkflowGraph(graph));
  }
});

test("CSV arrays remain consumable by Transform without coercing identifiers", async () => {
  const h = await harness();
  const s = h.shared;
  h.setGraph({
    nodes: [
      s.createInputNode({ position: { x: 0, y: 0 } }),
      s.createCsvNode({ id: "csv", position: { x: 1, y: 0 } }),
      s.createTransformNode({ id: "project", position: { x: 2, y: 0 }, fields: [
        { id: "order", name: "first_order", source: "json.0.order_id" },
        { id: "rows", name: "rows", source: "json" },
      ] }),
      s.createOutputNode({ position: { x: 3, y: 0 } }),
    ],
    edges: [
      s.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "csv" }),
      s.createWorkflowEdge({ source: "csv", sourceHandle: "out", target: "project" }),
      s.createWorkflowEdge({ source: "project", sourceHandle: "out", target: "output", targetHandle: "customer" }),
    ],
  });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({
    roomId: "private-room", input: 'order_id,note\r\n00123,"ไทย, ""quoted""\nnext line"\r\n', trigger: "test",
  }).trace$;
  assert.equal(trace.status, "complete", trace.error);
  assert.deepEqual(JSON.parse(trace.output.customer[0]), {
    first_order: "00123", rows: [{ order_id: "00123", note: 'ไทย, "quoted"\nnext line' }],
  });
});

test("CSV to Table computes exact grouped totals and persists counts without provider work", async () => {
  let providerCalls = 0;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: () => { providerCalls++; throw new Error("must not call"); },
  });
  const s = h.shared;
  h.setGraph({
    nodes: [
      s.createInputNode({ position: { x: 0, y: 0 } }),
      s.createCsvNode({ id: "csv", position: { x: 1, y: 0 } }),
      s.createTableNode({
        id: "table", position: { x: 2, y: 0 }, groupBy: "ภูมิภาค",
        filters: [{ id: "paid", column: "status", operator: "eq", value: "paid" }],
        aggregates: [
          { id: "sum", operation: "sum", column: "ยอด.ขาย", name: "ยอดรวม" },
          { id: "count", operation: "count", column: "", name: "จำนวน" },
        ],
      }),
      s.createOutputNode({ position: { x: 3, y: 0 } }),
    ],
    edges: [["input", "csv"], ["csv", "table"], ["table", "output"]].map(([source, target]) =>
      s.createWorkflowEdge({ source, sourceHandle: "out", target, targetHandle: target === "output" ? "customer" : "in" })),
  });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({
    roomId: "private-room", input: "ภูมิภาค,ยอด.ขาย,status\nเหนือ,0.1,paid\nเหนือ,0.2,paid\nใต้,bad,cancelled\nใต้,1.25,paid", trigger: "test",
  }).trace$;
  assert.equal(trace.status, "complete", trace.error);
  assert.deepEqual(JSON.parse(trace.output.customer[0]), [
    { ภูมิภาค: "เหนือ", ยอดรวม: "0.3", จำนวน: 2 }, { ภูมิภาค: "ใต้", ยอดรวม: "1.25", จำนวน: 1 },
  ]);
  const persisted = h.events.findLast((entry) => entry.data?.nodeType === "table" && entry.data.status === "complete").data;
  assert.deepEqual(persisted.table, { inputRows: 4, matchedRows: 3, outputRows: 2 });
  assert.equal(persisted.output, trace.output.customer[0]);
  assert.equal(providerCalls, 0);
});

test("invalid Table configuration prevents even an independent LLM branch from starting", async () => {
  let providerCalls = 0;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: () => { providerCalls++; throw new Error("must not call"); },
  });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const variants = [
    { groupBy: "region", aggregates: [] },
    { aggregates: [{ id: "sum", operation: "sum", column: "amount", name: "__proto__" }] },
    { filters: [{ id: "filter", column: "amount", operator: "gte", value: "1e101" }] },
  ];
  for (const options of variants) {
    const graph = fixtures(h.shared);
    graph.nodes.push(h.shared.createTableNode({ id: "table", position: { x: 1, y: 1 }, ...options }));
    graph.edges.push(
      h.shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "table" }),
      h.shared.createWorkflowEdge({ source: "table", sourceHandle: "out", target: "output", targetHandle: "team" })
    );
    h.setGraph(graph);
    const trace = await startWorkflowRun({ roomId: "private-room", input: "[]", trigger: "test" }).trace$;
    assert.equal(trace.status, "error");
    assert.equal(trace.nodes.some((node) => node.nodeType === "llm"), false);
  }
  assert.equal(providerCalls, 0);
});

test("run questions stay literal at the provider boundary without contaminating CSV or system text", async () => {
  const calls = [];
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: (options) => {
      calls.push(options);
      return { textStream: (async function* () { yield "answer"; })() };
    },
  });
  const s = h.shared;
  const question = 'Keep {{input}} and {{answers.secret}} literal.\n' + "q".repeat(300);
  const input = 'id,note\n001,"two, fields"\n';
  h.setGraph({
    nodes: [
      s.createInputNode({ position: { x: 0, y: 0 } }),
      s.createCsvNode({ id: "csv", position: { x: 1, y: 0 } }),
      s.createLlmNode({ id: "first", position: { x: 2, y: 0 }, prompt: "Analyze {{input}}", system: "Only analyze data." }),
      s.createLlmNode({ id: "second", position: { x: 3, y: 0 }, prompt: "Review {{input}}", system: "Only review data." }),
      s.createOutputNode({ position: { x: 4, y: 0 } }),
    ],
    edges: [["input", "csv"], ["csv", "first"], ["first", "second"], ["second", "output"]].map(([source, target]) =>
      s.createWorkflowEdge({ source, sourceHandle: "out", target, targetHandle: target === "output" ? "customer" : "in" })),
  });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const trace = await startWorkflowRun({ roomId: "room", input, question, trigger: "test" }).trace$;
  assert.equal(trace.status, "complete", trace.error);
  const suffix = "\n\nQuestion for this run (answer this question using the data above):\n" + question;
  assert.deepEqual(calls.map(({ prompt }) => prompt), [
    'Analyze [{"id":"001","note":"two, fields"}]' + suffix,
    "Review answer" + suffix,
  ]);
  assert.deepEqual(calls.map(({ system }) => system), ["Only analyze data.", "Only review data."]);
  const inputTrace = trace.nodes.find((node) => node.nodeType === "input");
  assert.equal(inputTrace.input, input);
  assert.equal(inputTrace.output, input);
  assert.equal(inputTrace.question, question);
  assert.equal(trace.question, question);
  assert.equal(trace.nodes.find((node) => node.nodeType === "csv").input, input);
  assert.deepEqual(JSON.parse(trace.nodes.find((node) => node.nodeType === "csv").output), [{ id: "001", note: "two, fields" }]);
  const { MAX_INPUT_PREVIEW } = await h.load("app/workflow/runs");
  assert.equal(h.events.at(-1).metadata.question, question.slice(0, MAX_INPUT_PREVIEW - 1) + "…");
});

test("combined resolved prompt, system and question enforce the node boundary before provider work", async () => {
  let calls = 0;
  const h = await harness({
    env: { OPENROUTER_API_KEY: "test-key" },
    streamText: () => { calls++; return { textStream: (async function* () { yield "answer"; })() }; },
  });
  const { MAX_NODE_PROMPT_CHARS } = await h.load("app/workflow/server/execution-policy");
  const question = "q".repeat(h.shared.MAX_QUESTION_CHARS);
  const prefix = "\n\nQuestion for this run (answer this question using the data above):\n";
  const remaining = MAX_NODE_PROMPT_CHARS - prefix.length - question.length - "system".length;
  const graph = fixtures(h.shared);
  graph.nodes[1].data.prompt = "{{input}}{{input}}" + "x".repeat(remaining % 2);
  graph.nodes[1].data.system = "system";
  h.setGraph(graph);
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  const input = "x".repeat(Math.floor(remaining / 2));
  const accepted = await startWorkflowRun({ roomId: "room", input, question, trigger: "test" }).trace$;
  assert.equal(accepted.status, "complete", accepted.error);
  const denied = await startWorkflowRun({ roomId: "room", input: input + "x", question, trigger: "test" }).trace$;
  assert.equal(denied.status, "error");
  assert.match(denied.error, /Node prompt/);
  assert.equal(calls, 1);
});

test("internal callers cannot bypass question validation or silently ignore questions", async () => {
  let reads = 0;
  const h = await harness({ readGraph: () => { reads++; return fixtures(h.shared, "transform"); } });
  const { startWorkflowRun } = await h.load("app/workflow/server/executor");
  for (const question of [null, 42, "x".repeat(h.shared.MAX_QUESTION_CHARS + 1)]) {
    const trace = await startWorkflowRun({ roomId: "room", input: "data", question, trigger: "test" }).trace$;
    assert.equal(trace.status, "error");
    assert.equal(h.events.length, 0);
  }
  assert.equal(reads, 0);
  const trace = await startWorkflowRun({ roomId: "room", input: "data", question: "Summarize", trigger: "test" }).trace$;
  assert.equal(trace.status, "error");
  assert.match(trace.error, /reachable/);
  assert.equal(trace.nodes.length, 0);
  const blank = await startWorkflowRun({ roomId: "room", input: "data", question: " \n\t ", trigger: "test" }).trace$;
  assert.equal(blank.status, "complete", blank.error);
  assert.equal(blank.question, undefined);
  assert.equal(blank.nodes.find((node) => node.nodeType === "input").question, undefined);
});
