/**
 * In-memory stand-in for the Upstash REST client, covering the commands the
 * workflow store uses. Values are strings, like the real client with
 * automaticDeserialization disabled (HMGET answers an array, HGETALL a flat
 * field/value array). The store's Lua scripts are recognised
 * by their distinctive text and reimplemented here.
 */
export function createFakeRedis() {
  const hashes = new Map();
  const zsets = new Map();
  const calls = [];

  const hash = (key) => {
    let value = hashes.get(key);
    if (!value) {
      value = new Map();
      hashes.set(key, value);
    }
    return value;
  };
  const zset = (key) => {
    let value = zsets.get(key);
    if (!value) {
      value = new Map();
      zsets.set(key, value);
    }
    return value;
  };
  const sorted = (key) => [...(zsets.get(key) ?? new Map()).entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([member]) => member);

  const commands = {
    async hset(key, fields) {
      const target = hash(key);
      for (const [field, value] of Object.entries(fields)) target.set(field, String(value));
      return Object.keys(fields).length;
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },
    // Raw REST shapes, as the client returns them with automaticDeserialization off.
    async hmget(key, ...fields) {
      const source = hashes.get(key);
      return fields.map((field) => source?.get(field) ?? null);
    },
    async hgetall(key) {
      const source = hashes.get(key);
      return source ? [...source.entries()].flat() : [];
    },
    async del(...keys) {
      let count = 0;
      for (const key of keys) {
        if (hashes.delete(key)) count++;
        if (zsets.delete(key)) count++;
      }
      return count;
    },
    async exists(key) {
      return hashes.has(key) || zsets.has(key) ? 1 : 0;
    },
    async zadd(key, { score, member }) {
      zset(key).set(member, score);
      return 1;
    },
    async zrem(key, ...members) {
      const target = zsets.get(key);
      let count = 0;
      for (const member of members) if (target?.delete(member)) count++;
      return count;
    },
    async zrange(key, start, stop, options = {}) {
      let members = sorted(key);
      if (options.rev) members = members.reverse();
      const end = stop < 0 ? members.length + stop + 1 : stop + 1;
      return members.slice(start, end);
    },
    async zcard(key) {
      return zsets.get(key)?.size ?? 0;
    },
    async eval(script, keys, args) {
      if (script.includes("'version'") && script.includes("ZADD")) {
        // SAVE_GRAPH_SCRIPT
        const [workflowKey, indexKey] = keys;
        const [expected, graph, updatedAt, workflowId] = args;
        if (!hashes.has(workflowKey)) return [-1, 0];
        const version = Number(hashes.get(workflowKey).get("version") ?? "0");
        if (version !== Number(expected)) return [0, version];
        await commands.hset(workflowKey, { graph, version: String(version + 1), updatedAt: String(updatedAt) });
        await commands.zadd(indexKey, { score: Number(updatedAt), member: workflowId });
        return [1, version + 1];
      }
      if (script.includes("evicted")) {
        // CREATE_RUN_SCRIPT
        const [runsKey] = keys;
        const [startedAt, runId, keep] = args;
        await commands.zadd(runsKey, { score: Number(startedAt), member: runId });
        const members = sorted(runsKey);
        const evicted = members.slice(0, Math.max(0, members.length - Number(keep)));
        if (evicted.length > 0) await commands.zrem(runsKey, ...evicted);
        return evicted;
      }
      if (script.includes("'running' then return 0")) {
        // DELETE_RUN_SCRIPT
        const [runKey, runsKey] = keys;
        if (hashes.get(runKey)?.get("status") === "running") return 0;
        await commands.del(runKey);
        await commands.zrem(runsKey, args[0]);
        return 1;
      }
      throw new Error("Unsupported script in fake Redis.");
    },
  };

  const record = (name) => async (...args) => {
    calls.push(name);
    return commands[name](...args);
  };

  class Redis {
    constructor() {
      for (const name of Object.keys(commands)) this[name] = record(name);
    }
    pipeline() {
      const queued = [];
      const pipeline = {};
      for (const name of Object.keys(commands)) {
        pipeline[name] = (...args) => {
          queued.push(() => record(name)(...args));
          return pipeline;
        };
      }
      pipeline.exec = async () => {
        const results = [];
        for (const run of queued) results.push(await run());
        return results;
      };
      return pipeline;
    }
  }

  return { Redis, hashes, zsets, calls };
}
