import assert from "node:assert/strict";
import test from "node:test";
import * as csvParse from "csv-parse/sync";
import { createModuleLoader } from "./load-module.mjs";
import { createFakeRedis } from "./fake-redis.mjs";

const owner = { id: "owner", name: "Owner", avatar: "", color: "#7654cb" };
const CRON_SECRET = "cron-secret-0123456789abcdef-0123456789";
const baseEnv = {
  NEXTAUTH_URL: "https://workflow.example",
  UPSTASH_REDIS_REST_URL: "https://redis.example",
  UPSTASH_REDIS_REST_TOKEN: "local-redis-token",
  WORKFLOW_WORKSPACE_ID: "team-a",
};
const plain = (value) => JSON.parse(JSON.stringify(value));

async function harness({ env = {}, stubs = {} } = {}) {
  let ids = 0;
  const auth = { getPrincipal: async () => owner };
  const redis = createFakeRedis();
  const runs = [];
  const leases = [];
  const executor = {
    startWorkflowRun: (options) => {
      const runId = `run-started${runs.length + 1}`;
      runs.push({ runId, ...options });
      return { runId, trace$: Promise.resolve({ runId, status: "complete", trigger: options.trigger, input: options.input, startedAt: 1, nodes: [], output: {} }) };
    },
  };
  const admission = {
    acquireRunLease: async (userId, roomId) => {
      const lease = { userId, roomId, released: false };
      leases.push(lease);
      return { release: async () => { lease.released = true; } };
    },
  };
  const load = createModuleLoader({ env: { ...baseEnv, ...env }, stubs: {
    nanoid: { nanoid: () => `generated${++ids}` },
    "next/server": { NextResponse: Response, after: (callback) => { void callback(); } },
    "./auth": auth,
    "../../../../workflow/server/auth": auth,
    "@upstash/redis": { Redis: redis.Redis },
    "csv-parse/sync": csvParse,
    "../../../../workflow/server/executor": executor,
    "../../workflow/server/executor": executor,
    "../../../../workflow/server/run-admission": admission,
    "../../workflow/server/run-admission": admission,
    ...stubs,
  } });
  const store = await load("app/workflow/server/store");
  return { load, store, redis, runs, leases };
}

function request(path, init = {}) {
  const value = new Request(`https://workflow.example${path}`, init);
  value.nextUrl = new URL(value.url);
  return value;
}

test("interval schedules align to the epoch and daily schedules follow the zone's wall clock", async () => {
  const load = createModuleLoader({ stubs: { nanoid: { nanoid: () => "id" }, "./auth": { getPrincipal: async () => null } } });
  const { nextRunAt } = await load("app/workflow/server/schedule");
  const every15 = { kind: "interval", everyMinutes: 15, input: "x", timezone: "UTC" };
  assert.equal(nextRunAt(every15, Date.parse("2026-10-12T10:07:00Z")), Date.parse("2026-10-12T10:15:00Z"));
  assert.equal(nextRunAt(every15, Date.parse("2026-10-12T10:15:00Z")), Date.parse("2026-10-12T10:30:00Z"));

  const bangkok = { kind: "daily", time: "08:00", input: "x", timezone: "Asia/Bangkok" };
  assert.equal(nextRunAt(bangkok, Date.parse("2026-10-12T00:30:00Z")), Date.parse("2026-10-12T01:00:00Z"));
  // Exactly at the scheduled instant, the next occurrence is tomorrow.
  assert.equal(nextRunAt(bangkok, Date.parse("2026-10-12T01:00:00Z")), Date.parse("2026-10-13T01:00:00Z"));
  // Late evening local time rolls to the next local day.
  assert.equal(nextRunAt(bangkok, Date.parse("2026-10-12T16:30:00Z")), Date.parse("2026-10-13T01:00:00Z"));

  // Daylight saving: 09:00 New York is 13:00Z before 1 Nov 2026 and 14:00Z after.
  const newYork = { kind: "daily", time: "09:00", input: "x", timezone: "America/New_York" };
  assert.equal(nextRunAt(newYork, Date.parse("2026-10-30T12:00:00Z")), Date.parse("2026-10-30T13:00:00Z"));
  assert.equal(nextRunAt(newYork, Date.parse("2026-11-01T12:00:00Z")), Date.parse("2026-11-01T14:00:00Z"));
});

test("schedule parsing refuses unknown fields, bad zones, short intervals and empty input", async () => {
  const load = createModuleLoader({ stubs: { nanoid: { nanoid: () => "id" }, "./auth": { getPrincipal: async () => null } } });
  const { parseSchedule } = await load("app/workflow/server/schedule");
  const valid = { kind: "daily", time: "07:30", input: "report", timezone: "Asia/Bangkok" };
  assert.deepEqual(plain(parseSchedule(valid)), valid);
  for (const bad of [
    { ...valid, extra: 1 },
    { ...valid, timezone: "Mars/Olympus" },
    { ...valid, time: "7:30" },
    { ...valid, input: "  " },
    { kind: "interval", everyMinutes: 1, input: "x", timezone: "UTC" },
    { kind: "interval", everyMinutes: 7.5, input: "x", timezone: "UTC" },
    { kind: "weekly", input: "x", timezone: "UTC" },
  ]) {
    assert.throws(() => parseSchedule(bad), (error) => error.status === 400);
  }
});

test("webhook secrets are stored only as hashes, rotate atomically and can be disabled", async () => {
  const h = await harness();
  const created = await h.store.createWorkflow(owner, { name: "Hook" });
  assert.equal(await h.store.isWebhookEnabled(created.workflowId, owner), false);
  const first = await h.store.rotateWebhookSecret(created.workflowId, owner);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  const stored = [...h.redis.hashes.values()].flatMap((fields) => [...fields.values()]);
  assert.equal(stored.includes(first), false);
  assert.equal(await h.store.verifyWebhookSecret(created.workflowId, first), true);
  assert.equal(await h.store.verifyWebhookSecret(created.workflowId, first.replace(/.$/, first.endsWith("A") ? "B" : "A")), false);
  const second = await h.store.rotateWebhookSecret(created.workflowId, owner);
  assert.equal(await h.store.verifyWebhookSecret(created.workflowId, first), false);
  assert.equal(await h.store.verifyWebhookSecret(created.workflowId, second), true);
  await h.store.disableWebhook(created.workflowId, owner);
  assert.equal(await h.store.verifyWebhookSecret(created.workflowId, second), false);
  assert.equal(await h.store.verifyWebhookSecret("unknown-workflow", second), false);
});

test("webhook route starts a webhook-triggered run only with the right secret", async () => {
  const h = await harness();
  const created = await h.store.createWorkflow(owner, { name: "Hook" });
  const secret = await h.store.rotateWebhookSecret(created.workflowId, owner);
  const route = await h.load("app/api/hooks/[workflowId]/[secret]/route");
  const post = (pathSecret, body, headers = { "content-type": "text/plain" }) => route.POST(
    request(`/api/hooks/${created.workflowId}/${pathSecret}`, { method: "POST", body, headers }),
    { params: Promise.resolve({ workflowId: created.workflowId, secret: pathSecret }) }
  );
  assert.equal((await post("x".repeat(43), "hello")).status, 404);
  assert.equal((await post("short", "hello")).status, 404);
  assert.equal(h.runs.length, 0);
  assert.equal((await post(secret, "   ")).status, 400);
  const accepted = await post(secret, "New ticket: refund A-1");
  assert.equal(accepted.status, 202);
  const body = await accepted.json();
  assert.equal(body.runId, "run-started1");
  assert.equal(h.runs[0].trigger, "webhook");
  assert.equal(h.runs[0].input, "New ticket: refund A-1");
  assert.equal(h.leases[0].userId, "webhook");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.leases[0].released, true);
  assert.equal((await post(secret, "x".repeat(100 * 1024))).status, 413);
});

test("schedules are claimed exactly once per occurrence and orphaned entries are dropped", async () => {
  const h = await harness();
  const created = await h.store.createWorkflow(owner, { name: "Daily" });
  const saved = await h.store.setSchedule(created.workflowId, owner, { kind: "interval", everyMinutes: 15, input: "daily report", timezone: "UTC" });
  assert(saved.nextRunAt > Date.now());
  assert.deepEqual(plain(await h.store.claimDueSchedules(Date.now(), 5)), []);
  const later = saved.nextRunAt + 1_000;
  const first = await h.store.claimDueSchedules(later, 5);
  assert.equal(first.length, 1);
  assert.equal(first[0].schedule.input, "daily report");
  assert(first[0].nextRunAt > later);
  assert.deepEqual(plain(await h.store.claimDueSchedules(later, 5)), []);
  const { nextRunAt } = await h.store.getSchedule(created.workflowId, owner);
  assert.equal(nextRunAt, first[0].nextRunAt);

  await h.store.deleteSchedule(created.workflowId, owner);
  assert.equal(await h.store.getSchedule(created.workflowId, owner), null);
  // An index entry without its schedule is removed rather than retried forever.
  const schedulesKey = [...h.redis.zsets.keys()].find((key) => key.endsWith(":schedules"));
  h.redis.zsets.get(schedulesKey).set(created.workflowId, 1);
  assert.deepEqual(plain(await h.store.claimDueSchedules(Date.now(), 5)), []);
  assert.equal(h.redis.zsets.get(schedulesKey).has(created.workflowId), false);
});

test("cron route requires CRON_SECRET and starts due schedules as schedule-triggered runs", async () => {
  const disabled = await harness();
  const disabledRoute = await disabled.load("app/api/cron/route");
  assert.equal((await disabledRoute.GET(request("/api/cron"))).status, 503);

  const h = await harness({ env: { CRON_SECRET } });
  const route = await h.load("app/api/cron/route");
  const tick = (token) => route.GET(request("/api/cron", token ? { headers: { authorization: `Bearer ${token}` } } : {}));
  assert.equal((await tick()).status, 401);
  assert.equal((await tick(`${CRON_SECRET}x`)).status, 401);
  const created = await h.store.createWorkflow(owner, { name: "Scheduled" });
  await h.store.setSchedule(created.workflowId, owner, { kind: "interval", everyMinutes: 5, input: "sync orders", timezone: "UTC" });
  const schedulesKey = [...h.redis.zsets.keys()].find((key) => key.endsWith(":schedules"));
  h.redis.zsets.get(schedulesKey).set(created.workflowId, Date.now() - 1_000);
  const response = await tick(CRON_SECRET);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.started.map((item) => item.workflowId), [created.workflowId]);
  assert.equal(h.runs[0].trigger, "schedule");
  assert.equal(h.runs[0].input, "sync orders");
  assert.equal(h.leases[0].userId, "scheduler");
  // The same occurrence is not started again by an overlapping tick.
  assert.deepEqual((await (await tick(CRON_SECRET)).json()).started, []);
});

test("schedule and webhook settings routes are owner-only, same-origin and validated", async () => {
  const h = await harness();
  const created = await h.store.createWorkflow(owner, { name: "Settings" });
  const params = { params: Promise.resolve({ workflowId: created.workflowId }) };
  const schedule = await h.load("app/api/workflows/[workflowId]/schedule/route");
  const put = (body, headers = {}) => schedule.PUT(request(`/api/workflows/${created.workflowId}/schedule`, {
    method: "PUT", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "https://workflow.example", ...headers },
  }), params);
  const value = { kind: "daily", time: "08:00", input: "morning", timezone: "Asia/Bangkok" };
  assert.equal((await put({ schedule: value }, { origin: "https://attacker.example" })).status, 403);
  assert.equal((await put({ schedule: value }, { authorization: "Bearer run-only-token-0123456789abcdef" })).status, 403);
  assert.equal((await put({ schedule: { ...value, time: "25:00" } })).status, 400);
  const saved = await put({ schedule: value });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.deepEqual(savedBody.schedule, value);
  assert.equal(savedBody.schedulerConfigured, false);

  const webhook = await h.load("app/api/workflows/[workflowId]/webhook/route");
  const rotate = await webhook.POST(request(`/api/workflows/${created.workflowId}/webhook`, {
    method: "POST", headers: { origin: "https://workflow.example" },
  }), params);
  assert.equal(rotate.status, 200);
  const { secret } = await rotate.json();
  assert.equal(await h.store.verifyWebhookSecret(created.workflowId, secret), true);
  const status = await webhook.GET(request(`/api/workflows/${created.workflowId}/webhook`), params);
  assert.deepEqual(await status.json(), { enabled: true });
  assert.equal((await webhook.DELETE(request(`/api/workflows/${created.workflowId}/webhook`, {
    method: "DELETE", headers: { origin: "https://attacker.example" },
  }), params)).status, 403);
});

test("approval notices use the configured connection and each service's payload shape", async () => {
  const sent = [];
  const load = createModuleLoader({
    env: {
      NEXTAUTH_URL: "https://workflow.example",
      WORKFLOW_APPROVAL_NOTIFY: JSON.stringify({ connection: "alerts", path: "sendMessage", format: "telegram", chatId: "-100123" }),
    },
    stubs: { "./http": { runHttpRequest: async (options) => { sent.push(options); return { text: "{}", status: 200 }; } } },
  });
  const notify = await load("app/workflow/server/notify");
  const notice = { workflowId: "wf-notify-1", runId: "run-1", approvals: [{ label: "Refund", prompt: "Approve refund?", expiresAt: Date.parse("2026-10-13T00:00:00Z") }] };
  await notify.notifyApprovalWaiting(notice);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].connection, "alerts");
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].path, "sendMessage");
  const body = JSON.parse(sent[0].body);
  assert.equal(body.chat_id, "-100123");
  assert.match(body.text, /Approve refund\?/);
  assert.match(body.text, /https:\/\/workflow\.example\/w\/wf-notify-1/);
  assert.deepEqual(Object.keys(notify.approvalPayload({ format: "slack" }, notice)), ["text"]);
  assert.equal(typeof notify.approvalPayload({ format: "discord" }, notice).content, "string");
  assert.equal(notify.approvalPayload({ format: "json" }, notice).event, "approval.waiting");

  const failing = createModuleLoader({
    env: { WORKFLOW_APPROVAL_NOTIFY: JSON.stringify({ connection: "alerts", format: "slack" }) },
    stubs: { "./http": { runHttpRequest: async () => { throw new Error("down"); } } },
  });
  // Delivery failures never reach the run.
  await (await failing("app/workflow/server/notify")).notifyApprovalWaiting(notice);
});

test("webhook bodies map to Input text by content type", async () => {
  const load = createModuleLoader({ stubs: { "./auth": { getPrincipal: async () => null } } });
  const { webhookInput } = await load("app/workflow/server/webhook-input");
  const raw = '{"message":{"text":"refund A-1"},"amount":12500.50}';
  assert.equal(webhookInput(`  ${raw}\n`, "application/json"), raw);
  assert.equal(webhookInput('"just text"', "application/json"), "just text");
  assert.equal(webhookInput("42", "application/vnd.api+json"), "42");
  assert.equal(webhookInput("name=Somchai&tag=a&tag=b&note=%E0%B8%94%E0%B9%88%E0%B8%A7%E0%B8%99", "application/x-www-form-urlencoded"),
    '{"name":"Somchai","tag":["a","b"],"note":"ด่วน"}');
  assert.equal(JSON.parse(webhookInput("__proto__=x&a=1", "application/x-www-form-urlencoded")).__proto__, "x");
  assert.equal(webhookInput("hello\nworld", "text/plain"), "hello\nworld");
  assert.equal(webhookInput("hello", ""), "hello");
  assert.throws(() => webhookInput("{bad", "application/json"), (error) => error.status === 400);
  assert.throws(() => webhookInput("   ", "text/plain"), (error) => error.status === 400);
  assert.throws(() => webhookInput("<x/>", "application/xml"), (error) => error.status === 415);
});
