import assert from "node:assert/strict";
import test from "node:test";
import { createModuleLoader } from "./load-module.mjs";

async function harness(globals = {}) {
  const load = createModuleLoader({ stubs: { nanoid: { nanoid: () => "unused" } }, globals });
  const { calculateTable, validateTableConfig } = await load("app/workflow/server/table");
  const { ExecutionError } = await load("app/workflow/server/execution-policy");
  return { calculateTable, validateTableConfig, ExecutionError };
}

const sum = (column = "amount", name = "total") => ({ id: name, operation: "sum", column, name });
const count = (name = "count") => ({ id: name, operation: "count", column: "", name });
const filter = (column, operator, value, id = column) => ({ id, column, operator, value });
const config = (options = {}) => ({ label: "Table", filters: [], groupBy: "", aggregates: [sum(), count()], ...options });

function calculate(h, rows, options = {}, reserve) {
  return h.calculateTable(config(options), JSON.stringify(rows), reserve);
}

function output(result, expected, inputRows, matchedRows) {
  assert.deepEqual(JSON.parse(result.text), expected);
  assert.deepEqual([result.inputRows, result.matchedRows, result.outputRows], [inputRows, matchedRows, expected.length]);
}

test("sums money exactly, including cancellation, exponent notation and canonical zero", async () => {
  const h = await harness();
  output(calculate(h, ["0.1", "0.2", "999999999999999999999999.99", "-999999999999999999999999.99", "+.005e2", "-0.8000", "-0"].map((amount) => ({ amount }))),
    [{ total: "0", count: 7 }], 7, 7);
  output(calculate(h, [{ amount: "0.10" }, { amount: "0.20" }]), [{ total: "0.3", count: 2 }], 2, 2);
  output(calculate(h, [{ amount: "-1.25" }, { amount: "2.5e-1" }]), [{ total: "-1", count: 2 }], 2, 2);
  output(calculate(h, [{ amount: 0.1 }, { amount: 0.2 }]), [{ total: "0.3", count: 2 }], 2, 2);
});

test("groups literal Unicode, spaces and dotted columns with typed keys and first-seen order", async () => {
  const h = await harness();
  const key = " ภูมิภาค.id ";
  const rows = [
    { [key]: "1", "ยอด.ขาย": "0.1" }, { [key]: 1, "ยอด.ขาย": "2" },
    { [key]: "1", "ยอด.ขาย": "0.2" }, { [key]: null, "ยอด.ขาย": "3" },
    { [key]: true, "ยอด.ขาย": "4" }, { [key]: "true", "ยอด.ขาย": "5" },
  ];
  output(calculate(h, rows, { groupBy: key, aggregates: [sum("ยอด.ขาย", "ยอดรวม"), count("จำนวน")] }), [
    { [key]: "1", ยอดรวม: "0.3", จำนวน: 2 }, { [key]: 1, ยอดรวม: "2", จำนวน: 1 },
    { [key]: null, ยอดรวม: "3", จำนวน: 1 }, { [key]: true, ยอดรวม: "4", จำนวน: 1 },
    { [key]: "true", ยอดรวม: "5", จำนวน: 1 },
  ], 6, 6);
});

test("AND filters use literal case-sensitive strings and preserve filtered row types and order", async () => {
  const h = await harness();
  const rows = [
    { code: "001", note: "{{input}} Yes ", flag: true, amount: 2, empty: null },
    { code: "002", note: "{{input}} Yes ", flag: false, amount: 3, empty: null },
    { code: "003", note: "{{input}} yes ", flag: true, amount: 4, empty: null },
    { code: "004", note: "{{input}} Yes ", flag: true, amount: 5, empty: null },
  ];
  const filters = [filter("note", "contains", "{{input}} Yes "), filter("flag", "eq", "true"), filter("amount", "ne", "5")];
  output(calculate(h, rows, { filters, aggregates: [] }), [rows[0]], 4, 1);
  output(calculate(h, rows, { filters: [filter("note", "eq", "{{input}} Yes")], aggregates: [] }), [], 4, 0);
  output(calculate(h, rows, { filters: [filter("empty", "contains", "null")], aggregates: [count()] }), [{ count: 4 }], 4, 4);
});

test("numeric filters distinguish values below floating-point precision for all comparison operators", async () => {
  const h = await harness();
  const rows = [{ amount: "9007199254740992.01" }, { amount: "9007199254740992.02" }, { amount: "9007199254740992.03" }];
  for (const [operator, expected] of [["gt", [rows[2]]], ["gte", rows.slice(1)], ["lt", [rows[0]]], ["lte", rows.slice(0, 2)]]) {
    output(calculate(h, rows, { filters: [filter("amount", operator, rows[1].amount)], aggregates: [] }), expected, 3, expected.length);
  }
});

test("sums reject selected nonnumeric cells but do not evaluate excluded sum cells", async () => {
  const h = await harness();
  const filters = [filter("selected", "eq", "true")];
  for (const amount of ["", " ", "1\n", null, true, "1,000", "$12", "0x10", "NaN", "Infinity", "private-cell"]) {
    const rows = [{ selected: false, amount }, { selected: true, amount: "1.25" }];
    output(calculate(h, rows, { filters }), [{ total: "1.25", count: 1 }], 2, 1);
    rows[0].selected = true;
    assert.throws(() => calculate(h, rows, { filters }), (error) => {
      assert.ok(error instanceof h.ExecutionError);
      assert.doesNotMatch(error.message, /private-cell|\$12|0x10/);
      return true;
    });
  }
  assert.throws(() => calculate(h, [{ amount: "bad" }], { filters: [filter("amount", "gt", "0")], aggregates: [] }), h.ExecutionError);
});

test("validates all rows and configured columns before filtering can hide invalid input", async () => {
  const h = await harness();
  for (const row of [
    { keep: false }, { keep: false, amount: "2", nested: [] }, { keep: false, amount: "2", nested: {} },
    { keep: false, amount: "2", unsafe: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => calculate(h, [row], { filters: [filter("keep", "eq", "true")] }), h.ExecutionError);
  }
  for (const options of [
    { filters: [filter("missing", "eq", "yes")], aggregates: [] },
    { groupBy: "missing", aggregates: [count()] },
  ]) assert.throws(() => calculate(h, [{ amount: "1" }], options), h.ExecutionError);
  for (const input of ["{}", "[[]]", "[null]", "[1]", '[{"amount":1e999}]', '[{"__proto__":"hidden"}]', "private malformed JSON"]) {
    assert.throws(() => h.calculateTable(config({ aggregates: [] }), input), (error) => {
      assert.ok(error instanceof h.ExecutionError);
      assert.doesNotMatch(error.message, /hidden|private malformed/);
      return true;
    });
  }
});

test("empty matches return zero ungrouped metrics, no groups, or no filtered rows", async () => {
  const h = await harness();
  for (const rows of [[], [{ amount: "invalid but excluded", group: "a", keep: false }]]) {
    const filters = [filter("keep", "eq", "true")];
    output(calculate(h, rows, { filters }), [{ total: "0", count: 0 }], rows.length, 0);
    output(calculate(h, rows, { filters, groupBy: "group" }), [], rows.length, 0);
    output(calculate(h, rows, { filters, aggregates: [] }), [], rows.length, 0);
  }
});

test("direct calls reject alias collisions, reserved names and invalid or oversized configuration", async () => {
  const h = await harness();
  const variants = [
    { aggregates: [sum(), count("total")] },
    { aggregates: [sum(), { ...count(), id: "total" }] },
    { groupBy: "amount", aggregates: [sum("amount", "amount")] },
    { groupBy: "amount", aggregates: [] },
    { aggregates: [sum("amount", " ")] },
    { aggregates: [sum("amount", "prototype")] },
    { aggregates: [sum("constructor")] },
    { aggregates: [{ ...count(), column: "amount" }] },
    { aggregates: [{ ...sum(), operation: "average" }] },
    { aggregates: Array.from({ length: 9 }, (_, i) => count(`n${i}`)) },
    { filters: Array.from({ length: 9 }, (_, i) => filter("amount", "eq", "1", `f${i}`)) },
    { filters: [filter("amount", "eq", "1"), filter("amount", "ne", "2")] },
    { filters: [filter("__proto__", "eq", "1")] },
    { filters: [filter("amount", "execute", "1")] },
    { filters: [filter("amount", "gt", "1\n")] },
    { filters: [filter("amount", "gt", "1e101")] },
    { filters: [filter("amount", "eq", "x".repeat(8001))] },
  ];
  for (const options of variants) assert.throws(() => calculate(h, [], options), h.ExecutionError);
  output(calculate(h, [{ amount: "2" }], { aggregates: [sum("amount", "toString"), count(" with spaces ")] }),
    [{ toString: "2", " with spaces ": 1 }], 1, 1);
});

test("decimal digit and exponent bounds reject oversized work without losing allowed precision", async () => {
  const h = await harness();
  for (const amount of ["9".repeat(101), "1e101", "1e-101", "1e99999999999999999999"]) {
    assert.throws(() => calculate(h, [{ amount }]), h.ExecutionError);
  }
  const largest = "9".repeat(100);
  output(calculate(h, [{ amount: largest }, { amount: "1" }]), [{ total: "1" + "0".repeat(100), count: 2 }], 2, 2);
  output(calculate(h, [{ amount: "1e-100" }]), [{ total: "0." + "0".repeat(99) + "1", count: 1 }], 1, 1);
  output(calculate(h, [{ amount: "1e100" }]), [{ total: "1" + "0".repeat(100), count: 1 }], 1, 1);
});

test("row, column, header, cell and input bounds reject rather than silently truncate", async () => {
  const h = await harness();
  const options = { aggregates: [] };
  const rows = Array.from({ length: 500 }, (_, id) => ({ id }));
  output(calculate(h, rows, options), rows, 500, 500);
  assert.throws(() => calculate(h, [...rows, { id: 500 }], options), h.ExecutionError);
  const row = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`c${i}`, null]));
  output(calculate(h, [row], options), [row], 1, 1);
  assert.throws(() => calculate(h, [{ ...row, extra: null }], options), h.ExecutionError);
  const wide = { ["ก".repeat(128)]: "x".repeat(8000) };
  output(calculate(h, [wide], options), [wide], 1, 1);
  assert.throws(() => calculate(h, [{ ["ก".repeat(129)]: "x" }], options), h.ExecutionError);
  assert.throws(() => calculate(h, [{ value: "x".repeat(8001) }], options), h.ExecutionError);
  assert.equal(h.calculateTable(config(options), "[]" + " ".repeat(31998)).text, "[]");
  assert.throws(() => h.calculateTable(config(options), "[]" + " ".repeat(31999)), h.ExecutionError);
});

test("output amplification is rejected before reservation and JSON serialization", async () => {
  let serialized = 0;
  const h = await harness({ JSON: { parse: JSON.parse, stringify: (...args) => { serialized++; return JSON.stringify(...args); } } });
  const rows = Array.from({ length: 300 }, (_, group) => ({ group }));
  let reserved = false;
  assert.throws(() => calculate(h, rows, { groupBy: "group", aggregates: [{ ...count("n".repeat(128)), id: "count" }] }, () => { reserved = true; }), h.ExecutionError);
  assert.equal(reserved, false);
  assert.equal(serialized, 0);
});

test("accepts the exact output boundary and rejects the next unit without truncation", async () => {
  const h = await harness();
  const rows = Array.from({ length: 250 }, (_, group) => ({ group }));
  rows.at(-1).group = "";
  const options = { groupBy: "group", aggregates: [{ ...count("n".repeat(100)), id: "count" }] };
  const baseline = calculate(h, rows, options);
  rows.at(-1).group = "x".repeat(32000 - baseline.text.length);
  const result = calculate(h, rows, options);
  assert.equal(result.text.length, 32000);
  assert.equal(JSON.parse(result.text).at(-1).group, rows.at(-1).group);
  rows.at(-1).group += "x";
  assert.throws(() => calculate(h, rows, options), h.ExecutionError);
});

test("reservation measures exact escaped trace size and may deny output before serialization", async () => {
  let serialized = 0;
  const h = await harness({ JSON: { parse: JSON.parse, stringify: (...args) => { serialized++; return JSON.stringify(...args); } } });
  const rows = [{ 'ชื่อ"\\': '\t\n\r\u0001"\\\ud800 ไทย' }];
  let reservation;
  const result = calculate(h, rows, { aggregates: [] }, (...sizes) => { reservation = sizes; assert.equal(serialized, 0); });
  output(result, rows, 1, 1);
  assert.deepEqual(reservation, [result.text.length, JSON.stringify(result.text).length]);
  assert.equal(serialized, 1);
  const denied = new Error("denied");
  assert.throws(() => calculate(h, [], {}, () => { throw denied; }), (error) => error === denied);
  assert.equal(serialized, 1);
});
