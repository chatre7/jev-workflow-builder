import assert from "node:assert/strict";
import { test } from "node:test";
import { createModuleLoader } from "./load-module.mjs";

const member = { id: "github:123", name: "member", avatar: "", color: "#7654cb" };
const configured = {
  GITHUB_ID: "local-client", GITHUB_SECRET: "local-secret",
  NEXTAUTH_SECRET: "local-session-secret-at-least-32-characters",
  NEXTAUTH_URL: "https://workflow.example", GITHUB_ALLOWED_USERS: "member",
  LIVEBLOCKS_SECRET_KEY: "sk_localdev", WORKFLOW_WORKSPACE_ID: "team-a",
};

test("OAuth allowlist cannot be bypassed by another provider or a client session update", async () => {
  const env = { ...configured };
  let claims = { githubId: "123", githubLogin: "member" };
  const load = createModuleLoader({ env, stubs: {
    "next-auth": { getServerSession: async options => options.callbacks.session({ session: {}, token: claims }) },
    "next-auth/providers/github": { default: options => options },
    "next/navigation": { redirect: () => { throw new Error("redirect"); } },
  } });
  const auth = await load("app/workflow/server/auth.ts");
  const callbacks = auth.getAuthOptions().callbacks;
  assert.equal(await callbacks.signIn({ account: { provider: "github" }, profile: { login: "outsider" } }), false);
  assert.equal(await callbacks.signIn({ account: { provider: "other" }, profile: { login: "member" } }), false);
  const updated = await callbacks.jwt({ token: claims, trigger: "update", session: { githubId: "999", githubLogin: "admin" } });
  claims = updated;
  assert.equal((await auth.getPrincipal()).id, "github:123");
  env.GITHUB_ALLOWED_USERS = "other-member";
  assert.equal(await auth.getPrincipal(), null);
  env.GITHUB_ALLOWED_USERS = "";
  assert.equal(await auth.getPrincipal(), null);
});

test("private storage rejects public, legacy, wrong-workspace and mismatched-ID rooms", async () => {
  const id = "workflow123";
  const room = {
    id: `jev:workflows:team-a:${id}`, defaultAccesses: [],
    metadata: { app: "jev-workflows", workspaceId: "team-a", workflowId: id, name: "Private" },
    createdAt: new Date(0).toISOString(), lastConnectionAt: null,
  };
  let returned = room;
  let fail = false;
  const load = createModuleLoader({ env: { ...configured }, stubs: {
    "@liveblocks/node": {
      LiveblocksError: class extends Error {},
      Liveblocks: class {
        async getRoom() { if (fail) throw new Error("Provider unavailable"); return returned; }
        async getRooms() { return { data: [returned] }; }
      },
    },
    "@liveblocks/react-flow/node": { mutateFlow: () => { throw new Error("Not used"); } },
    nanoid: { nanoid: () => "generated123" },
  } });
  const storage = await load("app/workflow/server/liveblocks.ts");
  assert.equal((await storage.getWorkflow(id, member)).name, "Private");
  await assert.rejects(storage.getWorkflow(id, null), /Authentication/);
  for (const altered of [
    { ...room, defaultAccesses: ["room:write"] },
    { ...room, id: `liveblocks:examples:old:${id}` },
    { ...room, metadata: { ...room.metadata, workspaceId: "team-b" } },
    { ...room, metadata: { ...room.metadata, workflowId: "different123" } },
    { ...room, metadata: { ...room.metadata, app: "other-app" } },
  ]) {
    returned = altered;
    assert.equal(await storage.getWorkflow(id, member), null);
    assert.equal((await storage.listWorkflows(member)).length, 0);
  }
  fail = true;
  await assert.rejects(storage.getWorkflow(id, member), /Provider unavailable/);
});

test("room-token endpoint rejects anonymous and cross-workspace access before authorizing", async () => {
  let principal = null;
  let issued = 0;
  const id = "workflow123";
  const room = `jev:workflows:team-a:${id}`;
  const load = createModuleLoader({ env: { ...configured }, stubs: {
    "next/server": { NextResponse: Response },
    "../../workflow/server/auth": { getAuthConfigurationError: () => null, getPrincipal: async () => principal },
    "./auth": { getPrincipal: async () => principal },
    "../../workflow/server/liveblocks": {
      getLiveblocksConfigurationError: () => null, getWorkspaceId: () => "team-a",
      getWorkflow: async workflowId => workflowId === id ? { workflowId } : null,
      getLiveblocks: () => ({ prepareSession() { issued++; throw new Error("Should never authorize rejected requests"); } }),
    },
    nanoid: { nanoid: () => "unused" },
  } });
  const route = await load("app/api/liveblocks-auth/route.ts");
  const request = target => new Request("https://workflow.example/api/liveblocks-auth", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://workflow.example" },
    body: JSON.stringify({ room: target, userId: "github:123" }),
  });
  assert.equal((await route.POST(request(room))).status, 401);
  principal = member;
  assert.equal((await route.POST(request(`jev:workflows:team-b:${id}`))).status, 404);
  assert.equal((await route.POST(request(`liveblocks:examples:any:${id}`))).status, 404);
  assert.equal(issued, 0);
});
