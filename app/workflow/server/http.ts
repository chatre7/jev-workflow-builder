import "server-only";

import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ExecutionError, MAX_NODE_TEXT_CHARS, abortable, checkAbort } from "./execution-policy";

const TIMEOUT_MS = 15_000;
const MAX_URL_BYTES = 4_096;
const MAX_BODY_BYTES = 128 * 1_024;
const MAX_RESPONSE_BYTES = 128 * 1_024;
const MAX_CONFIG_CHARS = 65_536;
const ALIAS = /^[a-z][a-z0-9_-]{0,63}$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const RESERVED_HEADERS: Record<string, true> = {
  host: true, connection: true, "content-length": true, "content-type": true,
  "transfer-encoding": true, upgrade: true, expect: true, te: true, trailer: true,
  "keep-alive": true, "accept-encoding": true, forwarded: true, via: true,
  "x-real-ip": true, "x-original-url": true, "x-rewrite-url": true,
  "x-http-method-override": true, "x-method-override": true, "x-http-method": true,
  "http2-settings": true,
};
const PUBLIC_HEADERS: Record<string, true> = { accept: true, "accept-language": true, "user-agent": true };
const JSON_ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

type Connection = {
  base: URL;
  methods: ("GET" | "POST")[];
  headers: Record<string, string>;
};
type Address = { address: string; family: number };

export type HttpRequestOptions = {
  connection: string;
  method: "GET" | "POST";
  path: string;
  body: string;
  signal: AbortSignal;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidConfig(): never {
  throw new ExecutionError("HTTP connection configuration is invalid. Contact the server administrator.");
}

// Reject ambiguous encodings before WHATWG URL normalization can erase traversal.
// Double encoding and encoded separators are intentionally not supported in paths.
function validatePath(path: string): void {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch {
    throw new ExecutionError("HTTP path contains an invalid encoding.");
  }
  if (/%(?:25|2f|5c)/i.test(path) || /[\\?#;\s\u0000-\u001f\u007f]/u.test(decoded)
    || decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ExecutionError("HTTP path contains an unsafe path segment.");
  }
}

function parseBase(value: unknown): URL {
  if (typeof value !== "string" || value.length > MAX_URL_BYTES
    || /[\\?#\s\u0000-\u001f\u007f]/u.test(value) || !/^https:\/\//i.test(value)) invalidConfig();
  const pathStart = value.indexOf("/", "https://".length);
  if (value.slice("https://".length, pathStart === -1 ? undefined : pathStart).includes("@")) invalidConfig();
  try {
    if (pathStart !== -1) validatePath(value.slice(pathStart));
    const base = new URL(value);
    if (base.protocol !== "https:" || !base.hostname || base.username || base.password || base.search || base.hash) invalidConfig();
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return base;
  } catch { return invalidConfig(); }
}

function connectionConfig(alias: string): Connection {
  const raw = process.env.WORKFLOW_HTTP_CONNECTIONS;
  if (!raw) throw new ExecutionError("HTTP connections are not configured on this server.");
  if (raw.length > MAX_CONFIG_CHARS) invalidConfig();
  let config: unknown;
  try { config = JSON.parse(raw); } catch { invalidConfig(); }
  if (!object(config) || Object.keys(config).length > 32) invalidConfig();
  let selected: Connection | undefined;
  for (const [name, value] of Object.entries(config)) {
    if (!ALIAS.test(name) || !object(value)
      || Object.keys(value).some((key) => !["baseUrl", "methods", "headers"].includes(key))) invalidConfig();
    const base = parseBase(value.baseUrl);
    const methods = value.methods === undefined ? ["GET"] : value.methods;
    if (!Array.isArray(methods) || !methods.length || methods.length > 2
      || methods.some((method) => method !== "GET" && method !== "POST")
      || new Set(methods).size !== methods.length) invalidConfig();
    const source = value.headers === undefined ? {} : value.headers;
    if (!object(source) || Object.keys(source).length > 32) invalidConfig();
    const headers: Record<string, string> = Object.create(null);
    let headerChars = 0;
    for (const [key, header] of Object.entries(source)) {
      const normalized = key.toLowerCase();
      if (!HEADER_NAME.test(key) || key.length > 128 || Object.hasOwn(RESERVED_HEADERS, normalized)
        || normalized.startsWith("proxy-") || normalized.startsWith("x-forwarded-")
        || Object.hasOwn(headers, normalized) || typeof header !== "string"
        || header.length > 8_192 || /[^\x20-\x7e]/.test(header)) invalidConfig();
      headerChars += key.length + header.length;
      if (headerChars > 16_384) invalidConfig();
      headers[normalized] = header;
    }
    if (name === alias) selected = { base, methods, headers };
  }
  if (!selected) throw new ExecutionError("The selected HTTP connection is not configured on this server.");
  return selected;
}

function requestUrl(base: URL, path: string): URL {
  if (typeof path !== "string" || path.length > MAX_URL_BYTES
    || /[\\#\s\u0000-\u001f\u007f]/u.test(path) || path.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new ExecutionError("HTTP path must be a relative path without a fragment.");
  }
  validatePath(path.split("?", 1)[0]);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
    || url.username || url.password || url.hash || Buffer.byteLength(url.href) > MAX_URL_BYTES) {
    throw new ExecutionError("HTTP path must stay within the configured connection base path and URL limit.");
  }
  return url;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c, d] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168
        || (b === 88 && c === 99) || (b === 31 && c === 196)
        || (b === 52 && c === 193) || (b === 175 && c === 48)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)
      || (a === 168 && b === 63 && c === 129 && d === 16));
  }
  if (family !== 6 || address.includes("%") || address.includes(".")) return false;
  const [left, right] = address.split("::");
  const leading = left ? left.split(":") : [];
  const trailing = right ? right.split(":") : [];
  const parts = right === undefined ? leading
    : [...leading, ...Array(8 - leading.length - trailing.length).fill("0"), ...trailing];
  const [a, b, c] = parts.map((part) => parseInt(part, 16));
  // Only global unicast, excluding special-purpose, documentation and IPv4 tunnels.
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
    && a !== 0x2002 && !(a === 0x3fff && b < 0x1000)
    && !(a === 0x2620 && b === 0x004f && c === 0x8000);
}

async function resolvePublicAddress(hostname: string, signal: AbortSignal): Promise<Address> {
  checkAbort(signal);
  const family = isIP(hostname);
  let addresses: Address[];
  if (family) addresses = [{ address: hostname, family }];
  else {
    // One resolution phase, one query per family, no retry. A per-call resolver
    // can cancel DNS I/O; OS getaddrinfo/lookup cannot be cancelled.
    const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    const cancel = () => resolver.cancel();
    const missingFamily = (error: unknown): string[] => {
      if (object(error) && (error.code === "ENODATA" || error.code === "ENOTFOUND")) return [];
      throw error;
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const [ipv4, ipv6] = await abortable(Promise.all([
        resolver.resolve4(hostname).catch(missingFamily),
        resolver.resolve6(hostname).catch(missingFamily),
      ]), signal);
      if (ipv4.length + ipv6.length > 64) throw new ExecutionError("HTTP connection returned too many DNS addresses.");
      addresses = [
        ...ipv4.map((address) => ({ address, family: 4 })),
        ...ipv6.map((address) => ({ address, family: 6 })),
      ];
    } finally {
      signal.removeEventListener("abort", cancel);
      resolver.cancel();
    }
  }
  checkAbort(signal);
  if (!addresses.length
    || addresses.some((entry) => isIP(entry.address) !== entry.family || !isPublicAddress(entry.address))) {
    throw new ExecutionError("HTTP connection must resolve only to public internet addresses.");
  }
  return addresses[0];
}

function secretValues(headers: Record<string, string>): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (Object.hasOwn(PUBLIC_HEADERS, name) || !value.trim()) continue;
    secrets.add(value);
    secrets.add(value.trim());
    const authorization = /^(Bearer|Basic)\s+(.+)$/i.exec(value.trim());
    if (authorization) {
      secrets.add(authorization[2].trim());
      if (authorization[1].toLowerCase() === "basic") {
        const decoded = Buffer.from(authorization[2], "base64").toString("utf8");
        if (decoded) secrets.add(decoded);
        const password = decoded.slice(decoded.indexOf(":") + 1);
        if (password) secrets.add(password);
      }
    }
    if (name === "cookie") {
      for (const cookie of value.split(";")) {
        const index = cookie.indexOf("=");
        if (index !== -1 && cookie.slice(index + 1).trim()) secrets.add(cookie.slice(index + 1).trim());
      }
    }
  }
  return [...secrets];
}

function rejectSecretReflection(text: string, secrets: string[]): void {
  if (!secrets.length) return;
  const unescaped = text.replace(/\\u([\da-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\([\\/"bfnrt])/g, (_, escape: string) => JSON_ESCAPES[escape] ?? escape);
  const decoded = unescaped.replace(/(?:%[\da-f]{2})+/gi, (encoded) => {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  });
  for (const secret of secrets) {
    if (text.includes(secret) || unescaped.includes(secret) || decoded.includes(secret)
      || text.includes(Buffer.from(secret).toString("base64"))
      || text.includes(Buffer.from(secret).toString("base64url"))) {
      throw new ExecutionError("HTTP response contains a configured credential and cannot be recorded.");
    }
  }
}

function transport(url: URL, options: HttpRequestOptions, headers: Record<string, string>, address: Address,
  signal: AbortSignal, expiresAt: number): Promise<{ text: string; status: number }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ text: string; status: number }>();
  let outgoing: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  let settled = false;
  const fail = (error: ExecutionError) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", cancel);
    incoming?.destroy();
    outgoing?.destroy();
    reject(error);
  };
  const cancel = () => fail(signal.reason as ExecutionError);
  const checkDeadline = () => {
    if (Date.now() >= expiresAt) fail(new ExecutionError("HTTP request exceeded its 15 second deadline."));
    return settled;
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) { cancel(); return promise; }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  try {
    outgoing = request({
      protocol: "https:", hostname, port: url.port || 443,
      path: url.pathname + url.search, method: options.method, headers,
      agent: false, family: address.family,
      servername: isIP(hostname) ? "" : hostname, rejectUnauthorized: true,
      maxHeaderSize: 16_384,
      // No transport DNS lookup: TLS still verifies the configured hostname.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      incoming = response;
      response.on("error", () => fail(new ExecutionError("HTTP response could not be read.")));
      if (settled || checkDeadline()) { response.destroy(); return; }
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        fail(new ExecutionError(status >= 300 && status < 400
          ? "HTTP redirects are not allowed." : "HTTP endpoint returned an unsuccessful status."));
        return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        fail(new ExecutionError("HTTP endpoint returned an unsupported content encoding."));
        return;
      }
      const length = response.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
        fail(new ExecutionError("HTTP response exceeds the response byte limit."));
        return;
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let text = "";
      const append = (part: string) => {
        if (text.length + part.length > MAX_NODE_TEXT_CHARS) {
          fail(new ExecutionError("HTTP response exceeds the 32,000 character limit."));
        } else text += part;
      };
      response.on("data", (chunk: Buffer) => {
        if (settled || checkDeadline()) return;
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          fail(new ExecutionError("HTTP response exceeds the response byte limit."));
          return;
        }
        try { append(decoder.decode(chunk, { stream: true })); } catch {
          fail(new ExecutionError("HTTP response is not valid UTF-8 text."));
        }
      });
      response.once("aborted", () => fail(new ExecutionError("HTTP response ended before completion.")));
      response.once("close", () => {
        if (!settled) fail(new ExecutionError("HTTP response ended before completion."));
      });
      response.once("end", () => {
        if (settled || checkDeadline()) return;
        if (!response.complete) { fail(new ExecutionError("HTTP response ended before completion.")); return; }
        try { append(decoder.decode()); } catch {
          fail(new ExecutionError("HTTP response is not valid UTF-8 text."));
        }
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        resolve({ text, status });
      });
    });
    outgoing.once("error", () => fail(new ExecutionError("HTTP request failed. Check the connection and endpoint availability.")));
    outgoing.once("close", () => {
      if (!incoming && !settled) fail(new ExecutionError("HTTP request ended before a response was received."));
    });
    outgoing.end(options.body.trim() ? options.body : undefined);
  } catch {
    fail(new ExecutionError("HTTP request failed. Check the connection and endpoint availability."));
  }
  return promise;
}

export async function runHttpRequest(options: HttpRequestOptions): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new ExecutionError("HTTP request was cancelled."));
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const expiresAt = Date.now() + TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new ExecutionError("HTTP request exceeded its 15 second deadline.")), TIMEOUT_MS);
  try {
    checkAbort(controller.signal);
    if (typeof options.connection !== "string" || !ALIAS.test(options.connection)) {
      throw new ExecutionError("Select a valid configured HTTP connection alias.");
    }
    const connection = connectionConfig(options.connection);
    if ((options.method !== "GET" && options.method !== "POST") || !connection.methods.includes(options.method)) {
      throw new ExecutionError("HTTP method is not enabled for this connection.");
    }
    const url = requestUrl(connection.base, options.path);
    if (typeof options.body !== "string" || options.body.length > MAX_NODE_TEXT_CHARS || Buffer.byteLength(options.body) > MAX_BODY_BYTES) {
      throw new ExecutionError("HTTP request body exceeds the request size limit.");
    }
    const hasBody = Boolean(options.body.trim());
    if (options.method === "GET" && hasBody) throw new ExecutionError("HTTP GET requests cannot contain a body.");
    if (hasBody) {
      try { JSON.parse(options.body); } catch { throw new ExecutionError("HTTP POST body must be valid JSON."); }
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const address = await resolvePublicAddress(hostname, controller.signal);
    checkAbort(controller.signal);
    if (Date.now() >= expiresAt) throw new ExecutionError("HTTP request exceeded its 15 second deadline.");
    const headers = { ...connection.headers, "accept-encoding": "identity" };
    if (hasBody) Object.assign(headers, { "content-type": "application/json", "content-length": String(Buffer.byteLength(options.body)) });
    const result = await transport(url, options, headers, address, controller.signal, expiresAt);
    checkAbort(controller.signal);
    rejectSecretReflection(result.text, secretValues(connection.headers));
    if (Date.now() >= expiresAt) throw new ExecutionError("HTTP request exceeded its 15 second deadline.");
    return result;
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("HTTP request failed. Check the connection and endpoint availability.");
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}
