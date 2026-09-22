import {
  CONDITION_OPERATORS,
  MAX_CSV_FIELD_CHARS,
  MAX_CSV_HEADER_CHARS,
  MAX_TABLE_AGGREGATES,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_DECIMAL_DIGITS,
  MAX_TABLE_FILTERS,
  MAX_TABLE_ROWS,
  type TableNodeData,
} from "../shared";
import { traceEscapes } from "./data-nodes";
import {
  ExecutionError, MAX_IDENTIFIER_CHARS, MAX_LABEL_CHARS, MAX_NODE_TEXT_CHARS, checkLimit, jsonSize,
} from "./execution-policy";

const RESERVED_KEYS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };
const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const ZERO = BigInt(0);
const TEN = BigInt(10);
type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
type Decimal = { coefficient: bigint; scale: number };

function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionError("Table configuration and rows must contain objects.");
  }
}

function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string") throw new ExecutionError("Table configuration requires text fields.");
  checkLimit(value.length, max, "Table text");
}

function name(value: unknown, max = MAX_CSV_HEADER_CHARS): asserts value is string {
  text(value, max);
  if (!value.trim() || Object.hasOwn(RESERVED_KEYS, value)) {
    throw new ExecutionError("Table names must be nonblank and not reserved keys.");
  }
}

function decimal(value: unknown): Decimal {
  const source = typeof value === "number" ? String(value) : value;
  const match = typeof source === "string" ? DECIMAL.exec(source) : null;
  if (!match || match[0] !== source) throw new ExecutionError("Table numeric operations require plain decimal values without blanks or formatting.");
  const fraction = match[3] ?? match[4] ?? "";
  const digits = (match[2] ?? "") + fraction;
  const exponent = Number(match[5] ?? 0);
  if (digits.length > MAX_TABLE_DECIMAL_DIGITS || !Number.isInteger(exponent) || Math.abs(exponent) > MAX_TABLE_DECIMAL_DIGITS) {
    throw new ExecutionError(`Table decimals allow at most ${MAX_TABLE_DECIMAL_DIGITS} coefficient digits and an exponent magnitude of ${MAX_TABLE_DECIMAL_DIGITS}.`);
  }
  const magnitude = BigInt(digits);
  let coefficient = match[1] === "-" ? -magnitude : magnitude;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function aligned(value: Decimal, scale: number): bigint {
  return value.coefficient * TEN ** BigInt(scale - value.scale);
}

function decimalText(value: Decimal): string {
  if (value.coefficient === ZERO) return "0";
  const negative = value.coefficient < ZERO;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, "0");
  const unsigned = value.scale === 0 ? digits
    : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, "");
  return (negative ? "-" : "") + unsigned;
}

export function validateTableConfig(data: unknown): asserts data is TableNodeData {
  record(data);
  text(data.label, MAX_LABEL_CHARS);
  if (data.activation !== undefined && data.activation !== "any" && data.activation !== "all") {
    throw new ExecutionError("Table activation must be 'any' or 'all'.");
  }
  if (!Array.isArray(data.filters) || data.filters.length > MAX_TABLE_FILTERS) {
    throw new ExecutionError(`Table allows at most ${MAX_TABLE_FILTERS} filters.`);
  }
  if (!Array.isArray(data.aggregates) || data.aggregates.length > MAX_TABLE_AGGREGATES) {
    throw new ExecutionError(`Table allows at most ${MAX_TABLE_AGGREGATES} aggregates.`);
  }
  text(data.groupBy, MAX_CSV_HEADER_CHARS);
  if (data.groupBy !== "") {
    name(data.groupBy);
    if (data.aggregates.length === 0) throw new ExecutionError("Table grouping requires at least one aggregate.");
  }
  const filterIds = new Set<string>();
  for (const filter of data.filters) {
    record(filter);
    name(filter.id, MAX_IDENTIFIER_CHARS);
    if (filterIds.has(filter.id)) throw new ExecutionError("Table filter IDs must be unique.");
    filterIds.add(filter.id);
    name(filter.column);
    if (!CONDITION_OPERATORS.some(({ id }) => id === filter.operator)) {
      throw new ExecutionError("Table contains an unsupported filter operator.");
    }
    text(filter.value, MAX_CSV_FIELD_CHARS);
    if (filter.operator === "gt" || filter.operator === "gte" || filter.operator === "lt" || filter.operator === "lte") decimal(filter.value);
  }
  const aggregateIds = new Set<string>();
  const names = new Set<string>();
  for (const aggregate of data.aggregates) {
    record(aggregate);
    name(aggregate.id, MAX_IDENTIFIER_CHARS);
    name(aggregate.name);
    if (aggregateIds.has(aggregate.id) || names.has(aggregate.name) || aggregate.name === data.groupBy) {
      throw new ExecutionError("Table aggregate IDs and names must be unique, and names must not replace the grouping column.");
    }
    aggregateIds.add(aggregate.id);
    names.add(aggregate.name);
    if (aggregate.operation === "sum") name(aggregate.column);
    else if (aggregate.operation !== "count" || aggregate.column !== "") {
      throw new ExecutionError("Table supports Sum over a column or Count over all matching rows.");
    }
  }
}

export function calculateTable(
  data: TableNodeData,
  input: string,
  reserveOutput?: (textSize: number, serializedSize: number) => void
): { text: string; inputRows: number; matchedRows: number; outputRows: number } {
  validateTableConfig(data);
  if (typeof input !== "string") throw new ExecutionError("Table input must be JSON text.");
  checkLimit(input.length, MAX_NODE_TEXT_CHARS, "Table input");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ExecutionError("Table input must be a JSON array of flat objects. Use CSV with headers enabled.");
  }
  if (!Array.isArray(parsed)) throw new ExecutionError("Table input must be a JSON array of flat objects. Use CSV with headers enabled.");
  checkLimit(parsed.length, MAX_TABLE_ROWS, "Table rows");
  const columns = new Set(data.filters.map((filter) => filter.column));
  if (data.groupBy) columns.add(data.groupBy);
  for (const aggregate of data.aggregates) if (aggregate.operation === "sum") columns.add(aggregate.column);
  // Validate every row before filtering: an excluded row cannot hide a bad shape or missing column.
  for (const row of parsed) {
    record(row);
    const keys = Object.keys(row);
    checkLimit(keys.length, MAX_TABLE_COLUMNS, "Table columns");
    for (const key of keys) {
      name(key);
      const value = row[key];
      if (typeof value === "string") checkLimit(value.length, MAX_CSV_FIELD_CHARS, "Table cell");
      else if (typeof value === "number") {
        if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
          throw new ExecutionError("Table numeric cells must be finite and within the safe range; use decimal strings for exact source precision.");
        }
      } else if (value !== null && typeof value !== "boolean") {
        throw new ExecutionError("Table cells must be strings, numbers, booleans or null, not nested objects or arrays.");
      }
    }
    for (const column of columns) {
      if (!Object.hasOwn(row, column)) throw new ExecutionError("A configured Table column is missing from an input row.");
    }
  }
  const rows = parsed as Row[];
  const filters = data.filters.map((filter) => ({
    ...filter,
    numeric: filter.operator === "gt" || filter.operator === "gte" || filter.operator === "lt" || filter.operator === "lte"
      ? decimal(filter.value) : undefined,
  }));
  const matched = rows.filter((row) => filters.every((filter) => {
    const value = row[filter.column];
    if (!filter.numeric) {
      const cell = String(value);
      if (filter.operator === "eq") return cell === filter.value;
      if (filter.operator === "ne") return cell !== filter.value;
      return cell.includes(filter.value);
    }
    const left = decimal(value);
    const scale = Math.max(left.scale, filter.numeric.scale);
    const difference = aligned(left, scale) - aligned(filter.numeric, scale);
    switch (filter.operator) {
      case "gt": return difference > ZERO;
      case "gte": return difference >= ZERO;
      case "lt": return difference < ZERO;
      default: return difference <= ZERO;
    }
  }));
  let output = matched;
  if (data.aggregates.length > 0) {
    type Group = { key: Cell; count: number; sums: Decimal[] };
    const groups = new Map<Cell, Group>();
    const createGroup = (key: Cell): Group => ({ key, count: 0, sums: data.aggregates.map(() => ({ coefficient: ZERO, scale: 0 })) });
    // Map keeps both primitive types and first-seen order. An ungrouped empty set still has zero metrics.
    if (!data.groupBy) groups.set(null, createGroup(null));
    for (const row of matched) {
      const key = data.groupBy ? row[data.groupBy] : null;
      let group = groups.get(key);
      if (!group) {
        group = createGroup(key);
        groups.set(key, group);
      }
      group.count++;
      for (let index = 0; index < data.aggregates.length; index++) {
        const aggregate = data.aggregates[index];
        if (aggregate.operation !== "sum") continue;
        const value = decimal(row[aggregate.column]);
        const sum = group.sums[index];
        const scale = Math.max(sum.scale, value.scale);
        // Input bounds cap aligned coefficients at 400 digits; 500 additions add at most three more.
        sum.coefficient = aligned(sum, scale) + aligned(value, scale);
        sum.scale = scale;
      }
    }
    output = Array.from(groups.values(), (group) => {
      const row: Row = Object.create(null);
      if (data.groupBy) row[data.groupBy] = group.key;
      for (let index = 0; index < data.aggregates.length; index++) {
        const aggregate = data.aggregates[index];
        row[aggregate.name] = aggregate.operation === "count" ? group.count : decimalText(group.sums[index]);
      }
      return row;
    });
  }
  const textSize = jsonSize(output, MAX_NODE_TEXT_CHARS, "Table output");
  reserveOutput?.(textSize, textSize + 2 + traceEscapes(output));
  return { text: JSON.stringify(output), inputRows: rows.length, matchedRows: matched.length, outputRows: output.length };
}
