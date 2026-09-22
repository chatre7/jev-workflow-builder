import assert from "node:assert/strict";
import { test } from "node:test";
import { createModuleLoader } from "./load-module.mjs";

const member = { id: "owner", name: "Owner", avatar: "", color: "#7654cb" };
const configured = {
  OWNER_PASSWORD: "local-owner-password-at-least-16-characters",
  NEXTAUTH_SECRET: "local-session-secret-at-least-32-characters",
  NEXTAUTH_URL: "https://workflow.example",
  UPSTASH_REDIS_REST_URL: "https://redis.example",
  UPSTASH_REDIS_REST_TOKEN: "local-redis-token",
  LIVEBLOCKS_SECRET_KEY: "sk_localdev", WORKFLOW_WORKSPACE_ID: "team-a",
};

test("owner sign-in rejects wrong passwords, forged updates and obsolete sessions", async () => {
  const env = { ...configured };
  let claims = {};
  const load = createModuleLoader({ env, stubs: {
    "next-auth": { getServerSession: async options => options.callbacks.session({ session: {}, token: claims }) },
    "next-auth/providers/credentials": { default: options => options },
    "next/navigation": { redirect: () => { throw new Error("redirect"); } },
    "@upstash/redis": { Redis: class { async eval() { return 1; } } },
  } });
  const auth = await load("app/workflow/server/auth.ts");
  const options = auth.getAuthOptions();
  assert.equal(await options.providers[0].authorize({ password: "wrong-password" }), null);
  claims = await options.callbacks.jwt({
    token: {}, trigger: "update", session: { sub: "owner", ownerVersion: "forged" },
  });
  assert.equal(await auth.getPrincipal(), null);
  claims = { sub: "123", githubId: "123", githubLogin: "previous-owner" };
  assert.equal(await auth.getPrincipal(), null);
  const user = await options.providers[0].authorize({ password: env.OWNER_PASSWORD });
  assert.equal(user.id, "owner");
  claims = await options.callbacks.jwt({ token: {}, account: { provider: "credentials" }, user });
  assert.equal((await auth.getPrincipal()).id, "owner");
  env.OWNER_PASSWORD = "a-different-long-owner-password";
  assert.equal(await auth.getPrincipal(), null);
  env.OWNER_PASSWORD = "";
  assert.equal(await auth.getPrincipal(), null);
});

test("password guessing is throttled and Redis failure cannot allow sign-in", async () => {
  let attempts = 0;
  let unavailable = false;
  const load = createModuleLoader({ env: { ...configured }, stubs: {
    "next-auth": { getServerSession: async () => null },
    "next-auth/providers/credentials": { default: options => options },
    "next/navigation": { redirect: () => { throw new Error("redirect"); } },
    "@upstash/redis": { Redis: class {
      async eval() { if (unavailable) throw new Error("Redis offline"); return ++attempts; }
    } },
  } });
  const auth = await load("app/workflow/server/auth.ts");
  const authorize = auth.getAuthOptions().providers[0].authorize;
  for (let i = 0; i < 10; i++) assert.equal(await authorize({ password: "incorrect" }), null);
  await assert.rejects(authorize({ password: configured.OWNER_PASSWORD }));
  unavailable = true;
  await assert.rejects(authorize({ password: configured.OWNER_PASSWORD }));
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
    body: JSON.stringify({ room: target, userId: "forged-owner" }),
  });
  assert.equal((await route.POST(request(room))).status, 401);
  principal = member;
  assert.equal((await route.POST(request(`jev:workflows:team-b:${id}`))).status, 404);
  assert.equal((await route.POST(request(`liveblocks:examples:any:${id}`))).status, 404);
  assert.equal(issued, 0);
});
