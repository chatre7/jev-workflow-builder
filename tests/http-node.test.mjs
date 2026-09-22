import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createModuleLoader } from "./load-module.mjs";

const publicAddress = { address: "93.184.216.34", family: 4 };
const defaultConfig = { service: { baseUrl: "https://api.example/api/", methods: ["GET", "POST"] } };

async function harness({ config = defaultConfig, lookup, familyErrors = {}, onRequest, globals = {} } = {}) {
  const requests = [];
  const resolutions = [];
  const resolvers = [];
  const opened = Promise.withResolvers();
  const load = createModuleLoader({
    env: config === undefined ? {} : { WORKFLOW_HTTP_CONNECTIONS: typeof config === "string" ? config : JSON.stringify(config) },
    globals,
    stubs: {
      nanoid: { nanoid: () => "unused" },
      "node:dns/promises": { Resolver: class {
        constructor(options) {
          assert.equal(options.tries, 1);
          this.cancelled = false;
          this.cancellation = Promise.withResolvers();
          resolvers.push(this);
        }
        async records(hostname, family) {
          if (familyErrors[family]) throw Object.assign(new Error("private DNS failure detail"), { code: familyErrors[family] });
          if (!this.snapshot) {
            resolutions.push(hostname);
            this.snapshot = Promise.resolve().then(() => lookup ? lookup(hostname) : [publicAddress]);
          }
          const records = await Promise.race([this.snapshot, this.cancellation.promise]);
          return records.filter((entry) => entry.family === family).map((entry) => entry.address);
        }
        resolve4(hostname) { return this.records(hostname, 4); }
        resolve6(hostname) { return this.records(hostname, 6); }
        cancel() {
          this.cancelled = true;
          this.cancellation.reject(Object.assign(new Error("cancelled"), { code: "ECANCELLED" }));
        }
      } },
      "node:https": { request: (options, callback) => {
        const outgoing = new EventEmitter();
        outgoing.destroyed = false;
        outgoing.destroy = () => { outgoing.destroyed = true; outgoing.emit("close"); };
        const call = { options, outgoing, body: undefined, response: undefined };
        call.respond = ({ status = 200, headers = {}, chunks = [Buffer.from("actual endpoint text")], finish = true } = {}) => {
          const response = new PassThrough();
          response.statusCode = status;
          response.headers = headers;
          response.complete = false;
          call.response = response;
          callback(response);
          for (const chunk of chunks) {
            if (response.destroyed) break;
            response.write(chunk);
          }
          if (finish && !response.destroyed) {
            response.complete = true;
            response.end();
          }
          return response;
        };
        outgoing.end = (body) => {
          call.body = body;
          queueMicrotask(() => {
            if (onRequest) onRequest(call);
            else call.respond();
            opened.resolve(call);
          });
        };
        requests.push(call);
        return outgoing;
      } },
    },
  });
  const { runHttpRequest } = await load("app/workflow/server/http.ts");
  const { ExecutionError } = await load("app/workflow/server/execution-policy.ts");
  return {
    requests, resolutions, resolvers, opened: opened.promise, ExecutionError,
    run: (overrides = {}) => runHttpRequest({ connection: "service", method: "GET", path: "items", body: "", signal: new AbortController().signal, ...overrides }),
  };
}

async function rejectsSafely(h, promise, forbidden = []) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof h.ExecutionError);
    for (const value of forbidden) assert.equal(error.message.includes(value), false);
    return true;
  });
}

function fakeClock() {
  let now = 1_000;
  const timers = new Map();
  const globals = {
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => { const id = {}; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  return {
    globals,
    advance: (milliseconds) => {
      now += milliseconds;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
    pending: () => timers.size,
  };
}

test("HTTPS request pins the vetted DNS address and retains hostname certificate verification", async () => {
  const addresses = [];
  let lookups = 0;
  const h = await harness({
    lookup: async () => ++lookups === 1 ? [publicAddress, { address: "2606:4700:4700::1111", family: 6 }] : [{ address: "127.0.0.1", family: 4 }],
    onRequest: (call) => {
      call.options.lookup("api.example", {}, (error, address, family) => {
        assert.equal(error, null);
        addresses.push({ address, family });
      });
      call.options.lookup("api.example", { all: true }, (error, entries) => {
        assert.equal(error, null);
        addresses.push(...entries);
      });
      assert.equal(call.options.hostname, "api.example");
      assert.equal(call.options.servername, "api.example");
      assert.equal(call.options.rejectUnauthorized, true);
      assert.equal(call.options.agent, false);
      assert.equal(call.options.family, 4);
      call.respond({ status: 201, chunks: [Buffer.from("retrieved data")] });
    },
  });
  const result = await h.run();
  assert.equal(result.text, "retrieved data");
  assert.equal(result.status, 201);
  assert.deepEqual(addresses.map(({ address, family }) => ({ address, family })), [publicAddress, publicAddress]);
  assert.equal(lookups, 1);
});

test("JSON POST preserves UTF-8 bytes and scopes both relative and root-relative paths", async () => {
  const body = JSON.stringify({ query: "ภาษาไทย", enabled: true });
  const h = await harness();
  await h.run({ method: "POST", path: "items?take=2", body });
  assert.equal(h.requests[0].options.path, "/api/items?take=2");
  assert.equal(h.requests[0].body, body);
  assert.equal(h.requests[0].options.headers["content-type"], "application/json");
  assert.equal(h.requests[0].options.headers["content-length"], String(Buffer.byteLength(body)));
  await h.run({ path: "/api/items" });
  assert.equal(h.requests[1].options.path, "/api/items");
  assert.equal(h.requests[1].body, undefined);
});

test("origin changes, path escapes and URL parser ambiguities fail before DNS or transport", async () => {
  const h = await harness();
  for (const path of [
    "https://evil.example/", "http://127.0.0.1/", "//evil.example/api/", "//user:password@evil.example/",
    "\\\\evil.example\\", "https:evil.example", "../admin", "./items", "/admin", "/api-evil/items",
    "/api/../admin", "%2e%2e/admin", "%252e%252e/admin", "items%2f..%2fadmin", "items%5c..%5cadmin",
    "items/..;/admin", "items#fragment", "items%3f/../admin", "items%00", "items%0d%0aHost:evil",
    " items", "items\t", "items%ff", "items%", "/api" + "x".repeat(4_096),
  ]) await rejectsSafely(h, h.run({ path }), ["password"]);
  assert.equal(h.resolutions.length, 0);
  assert.equal(h.requests.length, 0);
});

test("request method, alias, JSON and size limits reject before any I/O", async () => {
  const h = await harness();
  for (const overrides of [
    { connection: "missing" }, { connection: "__proto__" }, { connection: "a".repeat(65) },
    { method: "PUT" }, { body: '{"not":"allowed on GET"}' }, { method: "POST", body: "not JSON" },
    { method: "POST", body: '"' + "x".repeat(32_000) + '"' },
  ]) await rejectsSafely(h, h.run(overrides));
  assert.equal(h.resolutions.length, 0);
  assert.equal(h.requests.length, 0);
  const getOnly = await harness({ config: { service: { baseUrl: "https://api.example/" } } });
  await rejectsSafely(getOnly, getOnly.run({ method: "POST", body: "{}" }));
  assert.equal(getOnly.requests.length, 0);
});

test("configuration is strict and never exposes invalid configuration contents", async () => {
  const secret = "server-only-credential-12345";
  const configurations = [
    "", "{invalid", null, [], { service: null }, { service: { baseUrl: "http://api.example/" } },
    { service: { baseUrl: `https://user:${secret}@api.example/` } },
    { service: { baseUrl: "https://@api.example/" } },
    { service: { baseUrl: "https://api.example/api/../admin/" } },
    { service: { baseUrl: "https://api.example/api/%2e%2e/admin/" } },
    { service: { baseUrl: "https://api.example/api/?" } },
    { service: { baseUrl: "https://api.example/", methods: null } },
    { service: { baseUrl: "https://api.example/", methods: ["GET", "GET"] } },
    { service: { baseUrl: "https://api.example/", methods: ["DELETE"] } },
    { service: { baseUrl: "https://api.example/", headers: null } },
    { service: { baseUrl: "https://api.example/", headers: { Authorization: secret, authorization: secret } } },
    { service: { baseUrl: "https://api.example/", headers: { Authorization: `${secret}\r\nHost: localhost` } } },
    { service: { baseUrl: "https://api.example/", headers: { Authorization: [secret] } } },
    { service: { baseUrl: "https://api.example/", headers: { "Bad Header": secret } } },
    { service: { baseUrl: "https://api.example/", headers: { "x-api-key": "x".repeat(8_193) } } },
    { service: { baseUrl: "https://api.example/", unexpected: secret } },
  ];
  for (const config of configurations) {
    const h = await harness({ config });
    await rejectsSafely(h, h.run(), [secret, "localhost"]);
    assert.equal(h.resolutions.length, 0);
    assert.equal(h.requests.length, 0);
  }
});

test("configured headers cannot override routing, framing, proxies or transport policy", async () => {
  for (const name of ["Host", "Connection", "Proxy-Authorization", "Proxy-Connection", "Content-Length", "Content-Type", "Transfer-Encoding", "Expect", "Upgrade", "TE", "Trailer", "Accept-Encoding", "Forwarded", "X-Forwarded-Host", "X-Original-URL", "X-HTTP-Method-Override"]) {
    const h = await harness({ config: { service: { baseUrl: "https://api.example/", headers: { [name]: "forbidden-value" } } } });
    await rejectsSafely(h, h.run(), ["forbidden-value"]);
    assert.equal(h.requests.length, 0);
  }
});

test("all non-public IPv4/IPv6 results are rejected, including mixed public/private DNS", async () => {
  for (const address of [
    "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.1.1", "192.0.0.8", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "255.255.255.255", "168.63.129.16", "::", "::1", "fc00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "2001:db8::1", "3fff::1",
  ]) {
    const h = await harness({ lookup: async () => [publicAddress, { address, family: isIP(address) }] });
    await rejectsSafely(h, h.run());
    assert.equal(h.requests.length, 0, address);
  }
  for (const addresses of [[], [{ address: "127.0.0.1", family: 6 }], Array.from({ length: 65 }, () => publicAddress)]) {
    const h = await harness({ lookup: async () => addresses });
    await rejectsSafely(h, h.run());
    assert.equal(h.requests.length, 0);
  }
});

test("an absent address family is allowed but a failed DNS family never falls back to unchecked results", async () => {
  const absent = await harness({ familyErrors: { 6: "ENODATA" } });
  assert.equal((await absent.run()).text, "actual endpoint text");
  const failed = await harness({ familyErrors: { 6: "ESERVFAIL" } });
  await rejectsSafely(failed, failed.run(), ["private DNS failure detail"]);
  assert.equal(failed.requests.length, 0);
  assert.equal(failed.resolvers[0].cancelled, true);
});

test("literal private IP aliases cannot bypass DNS filtering through URL normalization", async () => {
  for (const host of ["127.0.0.1", "2130706433", "0x7f000001", "0177.0.0.1", "[::1]", "[::ffff:127.0.0.1]"]) {
    const h = await harness({ config: { service: { baseUrl: `https://${host}/` } } });
    await rejectsSafely(h, h.run());
    assert.equal(h.resolutions.length, 0);
    assert.equal(h.requests.length, 0);
  }
});

test("public IPv6 is pinned without a second resolution", async () => {
  const expected = "2606:4700:4700::1111";
  const h = await harness({ lookup: async () => [{ address: expected, family: 6 }], onRequest: (call) => {
    call.options.lookup("api.example", {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, expected);
      assert.equal(family, 6);
    });
    assert.equal(call.options.family, 6);
    call.respond();
  } });
  assert.equal((await h.run()).text, "actual endpoint text");
  assert.equal(h.resolutions.length, 1);
});

test("redirects and unsuccessful statuses destroy transport without returning body or headers", async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 500]) {
    const h = await harness({ onRequest: (call) => call.respond({ status, headers: { location: "https://127.0.0.1/internal-secret" }, chunks: [Buffer.from("private error body")] }) });
    await rejectsSafely(h, h.run(), ["internal-secret", "private error body", "127.0.0.1"]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].outgoing.destroyed, true);
    assert.equal(h.requests[0].response.destroyed, true);
  }
});

test("DNS, TLS and premature body errors are sanitized and never retried", async () => {
  const secret = "low-level-exception-with-credential";
  const dns = await harness({ lookup: async () => { throw new Error(secret); } });
  await rejectsSafely(dns, dns.run(), [secret]);
  assert.equal(dns.requests.length, 0);
  const tls = await harness({ onRequest: (call) => call.outgoing.emit("error", new Error(secret)) });
  await rejectsSafely(tls, tls.run(), [secret]);
  assert.equal(tls.requests.length, 1);
  assert.equal(tls.requests[0].outgoing.destroyed, true);
  const truncated = await harness({ onRequest: (call) => {
    const response = call.respond({ chunks: [Buffer.from("partial secret")], finish: false });
    response.destroy(new Error(secret));
  } });
  await rejectsSafely(truncated, truncated.run(), [secret, "partial secret"]);
  assert.equal(truncated.requests[0].outgoing.destroyed, true);
});

test("UTF-8 characters split across chunks are returned intact but invalid or incomplete UTF-8 fails", async () => {
  const expected = "ภาษาไทย ☀ 𝄞";
  const h = await harness({ onRequest: (call) => call.respond({ chunks: [...Buffer.from(expected)].map((byte) => Buffer.from([byte])) }) });
  assert.equal((await h.run()).text, expected);
  for (const chunk of [Buffer.from([0xff]), Buffer.from([0xc3]), Buffer.from([0xc0, 0x80])]) {
    const invalid = await harness({ onRequest: (call) => call.respond({ chunks: [chunk] }) });
    await rejectsSafely(invalid, invalid.run());
    assert.equal(invalid.requests[0].outgoing.destroyed, true);
  }
});

test("response byte and character ceilings abort streams even without Content-Length", async () => {
  const atLimit = await harness({ onRequest: (call) => call.respond({ chunks: [Buffer.from("ก".repeat(32_000))] }) });
  assert.equal((await atLimit.run()).text, "ก".repeat(32_000));
  for (const response of [
    { chunks: [Buffer.alloc(128 * 1_024 + 1, 65)] },
    { chunks: [Buffer.from("a".repeat(16_000)), Buffer.from("b".repeat(16_001))] },
    { headers: { "content-length": String(128 * 1_024 + 1) }, chunks: [] },
    { headers: { "content-encoding": "gzip" }, chunks: [] },
  ]) {
    const h = await harness({ onRequest: (call) => call.respond({ ...response, finish: false }) });
    await rejectsSafely(h, h.run());
    assert.equal(h.requests[0].response.destroyed, true);
    assert.equal(h.requests[0].outgoing.destroyed, true);
  }
});

test("parent cancellation stops DNS scheduling, pending requests and streaming response bodies", async () => {
  const dnsGate = Promise.withResolvers();
  const controller = new AbortController();
  const dns = await harness({ lookup: () => dnsGate.promise });
  const pendingDns = dns.run({ signal: controller.signal });
  controller.abort(new Error("private abort reason"));
  await rejectsSafely(dns, pendingDns, ["private abort reason"]);
  assert.equal(dns.resolvers[0].cancelled, true);
  dnsGate.resolve([publicAddress]);
  await Promise.resolve();
  assert.equal(dns.requests.length, 0);
  for (const withResponse of [false, true]) {
    const parent = new AbortController();
    const h = await harness({ onRequest: (call) => { if (withResponse) call.respond({ chunks: [Buffer.from("partial")], finish: false }); } });
    const pending = h.run({ signal: parent.signal });
    const call = await h.opened;
    parent.abort(new Error("private abort reason"));
    await rejectsSafely(h, pending, ["private abort reason", "partial"]);
    assert.equal(call.outgoing.destroyed, true);
    if (withResponse) assert.equal(call.response.destroyed, true);
  }
  const aborted = new AbortController();
  aborted.abort();
  const h = await harness();
  await rejectsSafely(h, h.run({ signal: aborted.signal }));
  assert.equal(h.resolutions.length, 0);
});

test("one absolute 15 second deadline covers DNS and response body, not an idle timeout", async () => {
  const clock = fakeClock();
  const dnsGate = Promise.withResolvers();
  const h = await harness({ globals: clock.globals, lookup: () => dnsGate.promise, onRequest: (call) => call.respond({ chunks: [Buffer.from("partial")], finish: false }) });
  const pending = h.run();
  clock.advance(14_000);
  dnsGate.resolve([publicAddress]);
  const call = await h.opened;
  clock.advance(999);
  call.response.write(Buffer.from("still active"));
  assert.equal(call.outgoing.destroyed, false);
  clock.advance(1);
  await rejectsSafely(h, pending, ["partial", "still active"]);
  assert.equal(call.outgoing.destroyed, true);
  assert.equal(call.response.destroyed, true);
  assert.equal(clock.pending(), 0);
});

test("deadline also releases a permanently pending DNS lookup and never starts late transport", async () => {
  const clock = fakeClock();
  const gate = Promise.withResolvers();
  const h = await harness({ globals: clock.globals, lookup: () => gate.promise });
  const pending = h.run();
  clock.advance(15_000);
  await rejectsSafely(h, pending);
  assert.equal(h.resolvers[0].cancelled, true);
  gate.resolve([publicAddress]);
  await Promise.resolve();
  assert.equal(h.requests.length, 0);
  assert.equal(clock.pending(), 0);
});

test("configured credentials stay request-only and reflected credentials never enter results or errors", async () => {
  const secret = 'private-token/+123456789';
  const config = { service: { baseUrl: "https://api.example/", headers: { Authorization: `Bearer ${secret}`, "X-API-Key": "second-private-value" } } };
  const safe = await harness({ config });
  const result = await safe.run();
  assert.deepEqual(Object.keys(result).sort(), ["status", "text"]);
  assert.equal(safe.requests[0].options.headers.authorization, `Bearer ${secret}`);
  assert.equal(JSON.stringify(result).includes(secret), false);
  for (const text of [
    `{"Authorization":"Bearer ${secret}"}`, secret, "second-private-value",
    encodeURIComponent(secret), Buffer.from(secret).toString("base64"),
    encodeURIComponent(secret).replace(/%[\dA-F]{2}/g, (encoded) => encoded.toLowerCase()),
    Buffer.from(secret).toString("base64url"),
    '"' + [...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("") + '"',
  ]) {
    const h = await harness({ config, onRequest: (call) => call.respond({ chunks: [Buffer.from(text)] }) });
    await rejectsSafely(h, h.run(), [secret, "second-private-value"]);
  }
  for (const headers of [
    { Authorization: `Basic ${Buffer.from(`user:${secret}`).toString("base64")}` },
    { Cookie: `session=${secret}; other=public-value` },
    { "X-API-Key": ` ${secret} ` },
  ]) {
    const h = await harness({ config: { service: { baseUrl: "https://api.example/", headers } }, onRequest: (call) => call.respond({ chunks: [Buffer.from(secret)] }) });
    await rejectsSafely(h, h.run(), [secret]);
  }
});
