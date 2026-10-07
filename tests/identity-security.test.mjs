import assert from "node:assert/strict";
import { test } from "node:test";
import { createModuleLoader } from "./load-module.mjs";
import { createFakeRedis } from "./fake-redis.mjs";

const member = { id: "owner", name: "Owner", avatar: "", color: "#7654cb" };
const configured = {
  OWNER_PASSWORD: "local-owner-password-at-least-16-characters",
  NEXTAUTH_SECRET: "local-session-secret-at-least-32-characters",
  NEXTAUTH_URL: "https://workflow.example",
  UPSTASH_REDIS_REST_URL: "https://redis.example",
  UPSTASH_REDIS_REST_TOKEN: "local-redis-token",
  WORKFLOW_WORKSPACE_ID: "team-a",
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
  // Refreshing the JWT keeps the original sign-in time; sessions end 8h after sign-in.
  const signedIn = claims;
  claims = await options.callbacks.jwt({ token: { ...signedIn } });
  assert.equal(claims.authTime, signedIn.authTime);
  claims = { ...signedIn, authTime: signedIn.authTime - 8 * 60 * 60 };
  assert.equal(await auth.getPrincipal(), null);
  claims = { ...signedIn };
  delete claims.authTime;
  assert.equal(await auth.getPrincipal(), null);
  claims = signedIn;
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

test("workspace storage is isolated by key, rejects anonymous callers, and ignores unknown or corrupt records", async () => {
  const redis = createFakeRedis();
  const open = (workspace) => createModuleLoader({ env: { ...configured, WORKFLOW_WORKSPACE_ID: workspace }, stubs: {
    "@upstash/redis": { Redis: redis.Redis },
    "./auth": { getPrincipal: async () => null },
    nanoid: { nanoid: () => `generated${workspace.length}${redis.calls.length}` },
  } })("app/workflow/server/store.ts");
  const a = await open("team-a");
  const b = await open("team-b");
  const created = await a.createWorkflow(member, { name: "Private" });
  assert.equal((await a.getWorkflow(created.workflowId, member)).name, "Private");
  await assert.rejects(a.getWorkflow(created.workflowId, null), /Authentication/);
  // The same ID is invisible from another workspace, and its list is empty.
  assert.equal(await b.getWorkflow(created.workflowId, member), null);
  assert.deepEqual([...await b.listWorkflows(member)], []);
  assert.equal((await a.listWorkflows(member)).length, 1);
  assert.equal(await a.getWorkflow("missing-workflow", member), null);
  assert.equal(await a.getWorkflow("../etc/passwd", member), null);
  // A record without timestamps is not a workflow.
  const key = [...redis.hashes.keys()].find((entry) => entry.endsWith(`:wf:${created.workflowId}`));
  redis.hashes.get(key).delete("createdAt");
  assert.equal(await a.getWorkflow(created.workflowId, member), null);
  assert.deepEqual([...await a.listWorkflows(member)], []);
});

