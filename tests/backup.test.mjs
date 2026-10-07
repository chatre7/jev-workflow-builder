import assert from "node:assert/strict";
import test from "node:test";
import { createModuleLoader } from "./load-module.mjs";

const owner = { id: "owner", name: "Owner", avatar: "", color: "#7654cb" };
const env = {
  NEXTAUTH_URL: "https://workflow.example",
  LIVEBLOCKS_SECRET_KEY: "sk_localdev",
  WORKFLOW_WORKSPACE_ID: "team-a",
};

/** Real liveblocks.ts and backup.ts over an in-memory Liveblocks SDK stub. */
async function harness({ principal = owner } = {}) {
  const rooms = new Map();
  const storage = new Map();
  let ids = 0;
  const auth = { getPrincipal: async () => principal };
  const roomOf = (id) => {
    const room = rooms.get(id);
    if (!room) {
      const error = new LiveblocksError("Room not found");
      error.status = 404;
      throw error;
    }
    return room;
  };
  class LiveblocksError extends Error {}
  const load = createModuleLoader({ env, stubs: {
    nanoid: { nanoid: () => `generated${++ids}` },
    "next/server": { NextResponse: Response },
    "./auth": auth,
    "../../../workflow/server/auth": auth,
    "../../../../workflow/server/auth": auth,
    "@liveblocks/node": {
      LiveblocksError,
      Liveblocks: class {
        async createRoom(id, { metadata, defaultAccesses }) {
          const room = { id, metadata, defaultAccesses, createdAt: new Date(0).toISOString(), lastConnectionAt: null };
          rooms.set(id, room);
          return room;
        }
        async getRoom(id) { return roomOf(id); }
        async getRooms() { return { data: [...rooms.values()] }; }
        async getStorageDocument(id) { roomOf(id); return storage.get(id) ?? {}; }
      },
    },
    "@liveblocks/react-flow/node": {
      mutateFlow: async ({ roomId, storageKey }, mutate) => {
        const nodes = {};
        const edges = {};
        mutate({
          addNodes: (list) => { for (const node of list) nodes[node.id] = node; },
          addEdges: (list) => { for (const edge of list) edges[edge.id] = edge; },
        });
        storage.set(roomId, { [storageKey]: { nodes, edges } });
      },
    },
  } });
  const shared = await load("app/workflow/shared");
  const demo = await load("app/workflow/demo");
  const liveblocks = await load("app/workflow/server/liveblocks");
  const backup = await load("app/workflow/server/backup");
  return { load, shared, demo, liveblocks, backup, rooms, storage };
}

// Modules run in a vm realm, so compare structure rather than prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

function request(path, init = {}) {
  return new Request(`https://workflow.example${path}`, init);
}

test("export writes only saved node and edge fields and import restores an identical graph", async () => {
  const h = await harness();
  const { nodes, edges } = h.demo.createDemoWorkflow();
  // React Flow runtime state that must never reach a backup or an import.
  const runtime = { selected: true, dragging: true, measured: { width: 300, height: 120 }, width: 300 };
  const created = await h.liveblocks.createWorkflow(owner, {
    name: "Triage ✓", graph: { nodes: nodes.map((node) => ({ ...node, ...runtime })), edges },
  });
  const exported = await h.backup.exportWorkflow(created.workflowId, owner);
  assert.equal(exported.format, "jev-workflow-backup");
  assert.equal(exported.version, 1);
  assert.equal(exported.workflows.length, 1);
  const [workflow] = exported.workflows;
  assert.equal(workflow.name, "Triage ✓");
  assert.equal(workflow.sourceWorkflowId, created.workflowId);
  for (const node of workflow.nodes) assert.deepEqual(Object.keys(node).sort(), ["data", "id", "position", "type"]);
  assert.deepEqual(plain(workflow.nodes.map((node) => node.data)), plain(nodes.map((node) => node.data)));
  // Edge data is always empty and is not written to backups.
  assert.deepEqual(plain(workflow.edges), plain(edges.map((edge) => { const copy = { ...edge }; delete copy.data; return copy; })));

  const restored = h.backup.parseBackup(JSON.parse(JSON.stringify(exported)));
  const [imported] = await h.backup.importWorkflows(owner, restored);
  assert.notEqual(imported.workflowId, created.workflowId);
  const again = await h.backup.exportWorkflow(imported.workflowId, owner);
  assert.deepEqual(
    plain({ name: again.workflows[0].name, nodes: again.workflows[0].nodes, edges: again.workflows[0].edges }),
    plain({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges }),
  );
  assert.equal(await h.backup.exportWorkflow("missing1234", owner), null);
});

test("exporting everything includes empty workflows, which also round-trip", async () => {
  const h = await harness();
  await h.liveblocks.createWorkflow(owner, { name: "Empty" });
  await h.liveblocks.createWorkflow(owner, { seedDemo: true });
  const all = await h.backup.exportAllWorkflows(owner);
  assert.deepEqual(plain(all.workflows.map((workflow) => workflow.nodes.length).sort()), [0, 8]);
  const created = await h.backup.importWorkflows(owner, h.backup.parseBackup(JSON.parse(JSON.stringify(all))));
  assert.equal(created.length, 2);
  assert.equal(h.rooms.size, 4);
});

test("import rejects files that are not backups, invalid graphs, and unsafe values", async () => {
  const h = await harness();
  const { nodes, edges } = h.demo.createDemoWorkflow();
  const valid = () => ({ format: "jev-workflow-backup", version: 1, exportedAt: "", workflows: [{ name: "ok", nodes, edges }] });
  const rejects = (mutate, pattern) => {
    const file = valid();
    mutate(file);
    assert.throws(() => h.backup.parseBackup(file), pattern);
  };
  assert.throws(() => h.backup.parseBackup([]), /JSON object/);
  rejects((file) => { file.format = "other"; }, /not a workflow backup/);
  rejects((file) => { file.version = 2; }, /not a workflow backup/);
  rejects((file) => { file.workflows = []; }, /between 1 and 50/);
  rejects((file) => { file.workflows = Array(51).fill(file.workflows[0]); }, /between 1 and 50/);
  rejects((file) => { file.workflows[0].name = "x".repeat(121); }, /Workflow 1: .*120 characters/);
  rejects((file) => { file.workflows[0].nodes = [file.workflows[0].nodes[0]]; }, /Workflow 1: .*input and output/);
  rejects((file) => { file.workflows[0].edges = []; file.workflows[0].nodes = nodes.map((node) => ({ ...node, position: { x: Infinity, y: 0 } })); }, /finite numbers/);
  rejects((file) => { file.workflows[0].nodes = nodes.map((node) => ({ ...node, position: { x: 0, y: "1" } })); }, /finite numbers/);
  rejects((file) => { file.workflows[0].nodes = nodes.map((node) => ({ ...node, type: "__proto__" })); }, /node type/);
  rejects((file) => { file.workflows[0].edges = edges.map((edge) => ({ ...edge, type: "bezier" })); }, /edge type/);
  rejects((file) => { file.workflows[0].edges = [{ ...edges[0], source: "nowhere" }]; }, /existing nodes/);
  rejects((file) => {
    const llm = nodes.find((node) => node.type === "llm");
    file.workflows[0].nodes = nodes.map((node) => node === llm ? { ...node, data: { ...node.data, model: "vendor/unknown" } } : node);
  }, /Workflow 1:/);
  // A blank name falls back; unknown top-level node fields are dropped, not stored.
  const [parsed] = h.backup.parseBackup({ ...valid(), workflows: [{ name: "  ", nodes: nodes.map((node) => ({ ...node, extra: 1 })), edges }] });
  assert.equal(parsed.name, "Untitled workflow");
  assert.ok(parsed.nodes.every((node) => !("extra" in node)));
});

test("backup routes require the owner browser session and import checks origin and size", async () => {
  const anonymous = await harness({ principal: null });
  const exportOne = await anonymous.load("app/api/workflows/[workflowId]/export/route");
  const exportAll = await anonymous.load("app/api/workflows/export/route");
  const importRoute = await anonymous.load("app/api/workflows/import/route");
  const params = { params: Promise.resolve({ workflowId: "generated123" }) };
  assert.equal((await exportOne.GET(request("/api/workflows/generated123/export"), params)).status, 401);
  assert.equal((await exportAll.GET(request("/api/workflows/export"))).status, 401);
  assert.equal((await importRoute.POST(request("/api/workflows/import", { method: "POST" }))).status, 401);

  const h = await harness();
  const one = await h.load("app/api/workflows/[workflowId]/export/route");
  const all = await h.load("app/api/workflows/export/route");
  const imp = await h.load("app/api/workflows/import/route");
  const bearer = { headers: { authorization: "Bearer valid-run-only-token-0123456789" } };
  assert.equal((await one.GET(request("/api/workflows/generated123/export", bearer), params)).status, 403);
  assert.equal((await all.GET(request("/api/workflows/export", bearer))).status, 403);
  assert.equal((await one.GET(request("/api/workflows/generated123/export"), params)).status, 404);

  const created = await h.liveblocks.createWorkflow(owner, { seedDemo: true });
  const response = await one.GET(request(`/api/workflows/${created.workflowId}/export`), { params: Promise.resolve({ workflowId: created.workflowId }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="support-ticket-triage-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const file = await response.json();
  assert.equal(file.workflows[0].nodes.length, 8);
  const everything = await (await all.GET(request("/api/workflows/export"))).json();
  assert.equal(everything.workflows.length, 1);

  const post = (body, headers = {}) => imp.POST(request("/api/workflows/import", {
    method: "POST", body, headers: { "content-type": "application/json", origin: "https://workflow.example", ...headers },
  }));
  assert.equal((await post(JSON.stringify(file), { origin: "https://attacker.example" })).status, 403);
  assert.equal((await post(JSON.stringify(file), bearer.headers)).status, 403);
  assert.equal((await post(JSON.stringify({ format: "nope" }))).status, 400);
  assert.equal((await post("x".repeat(4 * 1024 * 1024 + 1))).status, 413);
  const imported = await post(JSON.stringify(file));
  assert.equal(imported.status, 200);
  const { workflows } = await imported.json();
  assert.equal(workflows.length, 1);
  assert.notEqual(workflows[0].workflowId, created.workflowId);
  assert.equal(workflows[0].name, "Support ticket triage");
  assert.equal(h.rooms.size, 2);
});
