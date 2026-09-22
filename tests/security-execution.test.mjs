import assert from "node:assert/strict";
import test from "node:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createModuleLoader } from "./load-module.mjs";

function fixtures(shared, kind = "llm") {
  const input = shared.createInputNode({ position: { x: 0, y: 0 } });
  const output = shared.createOutputNode({ position: { x: 2, y: 0 } });
  const middle = kind === "jev"
    ? shared.createJevNode({ id: "middle", position: { x: 1, y: 0 } })
    : shared.createLlmNode({ id: "middle", position: { x: 1, y: 0 } });
  return {
    nodes: [input, middle, output],
    edges: [
      shared.createWorkflowEdge({ source: "input", sourceHandle: "out", target: "middle" }),
      shared.createWorkflowEdge({ source: "middle", sourceHandle: kind === "jev" ? "any" : "out", target: "output", targetHandle: "customer" }),
    ],
  };
}

async function harness({ streamText, readGraph, clientOverrides = {}, env = {}, globals = {} } = {}) {
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
      "./liveblocks": { getLiveblocks: () => client, readWorkflowGraph: (...args) => readGraph ? readGraph(...args) : Promise.resolve(graph) },
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
