import assert from "node:assert/strict";
import test from "node:test";
import * as csvParse from "csv-parse/sync";
import { createModuleLoader } from "./load-module.mjs";

async function harness() {
  const load = createModuleLoader({ stubs: {
    nanoid: { nanoid: () => "unused" },
    "csv-parse/sync": csvParse,
  } });
  const { convertCsv } = await load("app/workflow/server/csv");
  const { ExecutionError } = await load("app/workflow/server/execution-policy");
  return {
    convert: (input, options = {}, reserve) => convertCsv({ label: "CSV", delimiter: ",", headers: true, ...options }, input, reserve),
    ExecutionError,
  };
}

const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const encode = (rows, delimiter = ",", newline = "\n") => rows.map((row) => row.map(quote).join(delimiter)).join(newline);

function output(result, expected, columnCount) {
  assert.deepEqual(JSON.parse(result.text), expected);
  assert.equal(result.rowCount, expected.length);
  assert.equal(result.columnCount, columnCount);
}

test("preserves Unicode headers, leading zeros, whitespace and formula-like strings without coercion", async () => {
  const h = await harness();
  output(h.convert("รหัส, ชื่อ ,formula,boolean,date\n0012, สมชาย ,=SUM(A1:A2),true,2026-09-22"), [
    { รหัส: "0012", " ชื่อ ": " สมชาย ", formula: "=SUM(A1:A2)", boolean: "true", date: "2026-09-22" },
  ], 5);
});

test("parses every delimiter, BOM, multiline quoted fields and doubled quotes with CRLF/LF/CR records", async () => {
  const h = await harness();
  for (const [delimiter, newline] of [[",", "\r\n"], [";", "\n"], ["\t", "\r"]]) {
    const rows = [["id", "ข้อความ"], ["0007", `left${delimiter}right\r\nnext\nline\rfinal "quote"`], ["0008", ""]];
    output(h.convert("\ufeff" + encode(rows, delimiter, newline), { delimiter }), [
      { id: "0007", ข้อความ: rows[1][1] }, { id: "0008", ข้อความ: "" },
    ], 2);
  }
});

test("headerless records retain their first row and empty or whitespace cells", async () => {
  const h = await harness();
  output(h.convert('\n001,ไทย\r\n, \r\n"",\n', { headers: false }), [
    ["001", "ไทย"], ["", " "], ["", ""],
  ], 2);
  output(h.convert('\n\r\n\r""\n \n', { headers: false }), [[""], [" "]], 1);
});

test("empty documents ignore only genuinely empty lines and header-only documents retain width", async () => {
  const h = await harness();
  for (const input of ["", "\ufeff", "\ufeff\r\n\n\r"]) {
    for (const headers of [true, false]) output(h.convert(input, { headers }), [], 0);
  }
  output(h.convert("\nรหัส,name\r\n\r\n"), [], 2);
  assert.throws(() => h.convert(" \n"), h.ExecutionError);
});

test("rejects malformed quoting and inconsistent widths without leaking sensitive cells", async () => {
  const h = await harness();
  for (const input of [
    'a,b\nsecret"value,x',
    'a,b\n"secret"suffix,x',
    'a,b\n"secret,x',
    'a,b\nsecret',
    'a,b\nsecret,x,extra',
  ]) {
    assert.throws(() => h.convert(input), (error) => {
      assert.ok(error instanceof h.ExecutionError);
      assert.match(error.message, /line \d+/);
      assert.doesNotMatch(error.message, /secret|suffix|extra/);
      return true;
    });
  }
  assert.throws(() => h.convert("a,b\nx", { headers: false }), h.ExecutionError);
});

test("rejects blank, duplicate, reserved and oversized headers without normalizing safe names", async () => {
  const h = await harness();
  for (const headers of [[""], [" \t"], ["x", "x"], ["__proto__"], ["constructor"], ["prototype"], ["h".repeat(129)]]) {
    assert.throws(() => h.convert(encode([headers, headers.map(() => "v")])), h.ExecutionError);
  }
  const longHeader = "ก".repeat(128);
  output(h.convert(encode([[longHeader, "x", " x", "toString"], ["v", "a", "b", "c"]])), [
    { [longHeader]: "v", x: "a", " x": "b", toString: "c" },
  ], 4);
});

test("enforces the data-row bound without counting the header or empty lines", async () => {
  const h = await harness();
  const rows = Array.from({ length: 500 }, (_, index) => [String(index)]);
  output(h.convert("id\n\n" + encode(rows)), rows.map(([id]) => ({ id })), 1);
  output(h.convert(encode(rows), { headers: false }), rows, 1);
  for (const headers of [true, false]) {
    assert.throws(() => h.convert((headers ? "id\n" : "") + encode([...rows, ["overflow"]]), { headers }), h.ExecutionError);
  }
});

test("bounds columns before accepting oversized rows in either mode", async () => {
  const h = await harness();
  const names = Array.from({ length: 64 }, (_, index) => `c${index}`);
  const values = names.map((_, index) => String(index));
  output(h.convert(encode([names, values])), [Object.fromEntries(names.map((name, index) => [name, values[index]]))], 64);
  output(h.convert(encode([values]), { headers: false }), [values], 64);
  assert.throws(() => h.convert(encode([[...names, "extra"]])), h.ExecutionError);
  assert.throws(() => h.convert(",".repeat(32000), { headers: false }), h.ExecutionError);
});

test("field and input limits count UTF-16 units, not UTF-8 bytes, and reject rather than truncate", async () => {
  const h = await harness();
  for (const field of ["ก".repeat(8000), "\u{1D11E}".repeat(4000)]) {
    output(h.convert(encode([["value"], [field]])), [{ value: field }], 1);
    assert.throws(() => h.convert(encode([["value"], [field + "x"]])), h.ExecutionError);
  }
  output(h.convert("\n".repeat(32000)), [], 0);
  assert.throws(() => h.convert("\n".repeat(32001)), h.ExecutionError);
});

test("accepts exact serialized output limit and rejects the next unit before reservation", async () => {
  const h = await harness();
  const row = ["x".repeat(8000), "x".repeat(8000), "x".repeat(8000), "x".repeat(7985)];
  const result = h.convert(row.join(","), { headers: false });
  output(result, [row], 4);
  assert.equal(result.text.length, 32000);
  let reserved = false;
  row[3] += "x";
  assert.throws(() => h.convert(row.join(","), { headers: false }, () => { reserved = true; }), h.ExecutionError);
  assert.equal(reserved, false);
});

test("bounds repeated-header and JSON-escape amplification while records arrive", async () => {
  const h = await harness();
  let reserved = false;
  for (const input of [
    "h".repeat(128) + "\n" + "x\n".repeat(250),
    encode([["value"], ["\u0001".repeat(6000)]]),
  ]) {
    assert.ok(input.length < 32000);
    assert.throws(() => h.convert(input, {}, () => { reserved = true; }), h.ExecutionError);
  }
  assert.equal(reserved, false);
});

test("reserves exact JSON and persisted-string sizes while preserving Unicode and literal escapes", async () => {
  const h = await harness();
  const header = 'ชื่อ"\\\u2c00';
  const value = '000 \t\n\r\b\f\u0001"\\\u{1D11E} literal\\ud800 \u2c00';
  for (const headers of [true, false]) {
    let reservation;
    const rows = headers ? [[header], [value]] : [[value]];
    const result = h.convert(encode(rows), { headers }, (textSize, serializedSize) => {
      reservation = [textSize, serializedSize];
    });
    output(result, headers ? [{ [header]: value }] : [[value]], 1);
    assert.deepEqual(reservation, [result.text.length, JSON.stringify(result.text).length]);
  }
  const empty = h.convert("", {}, (textSize, serializedSize) => {
    assert.deepEqual([textSize, serializedSize], [2, 4]);
  });
  assert.equal(empty.text, "[]");
  const denied = new Error("reservation denied");
  assert.throws(() => h.convert("h\nx", {}, () => { throw denied; }), (error) => error === denied);
});

test("rejects NUL and ill-formed Unicode instead of silently changing input text", async () => {
  const h = await harness();
  let reserved = false;
  for (const input of [
    'a\n"secret"\u0000suffix',
    "a\nsecret\u0000value",
    "a\nsecret\ud800value",
    "a\nsecret\udfffvalue",
    "\ud800\nsecret",
  ]) {
    assert.throws(() => h.convert(input, {}, () => { reserved = true; }), (error) => {
      assert.ok(error instanceof h.ExecutionError);
      assert.doesNotMatch(error.message, /secret|suffix/);
      return true;
    });
  }
  assert.equal(reserved, false);
});
