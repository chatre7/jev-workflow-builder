import { CsvError, parse } from "csv-parse/sync";
import {
  MAX_CSV_COLUMNS,
  MAX_CSV_FIELD_CHARS,
  MAX_CSV_HEADER_CHARS,
  MAX_CSV_ROWS,
  type CsvNodeData,
} from "../shared";
import { traceEscapes } from "./data-nodes";
import { ExecutionError, MAX_NODE_TEXT_CHARS, checkLimit, jsonSize } from "./execution-policy";

const RESERVED_HEADERS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };

export function convertCsv(
  data: CsvNodeData,
  input: string,
  reserveOutput?: (textSize: number, serializedSize: number) => void
): { text: string; rowCount: number; columnCount: number; columnNames: string[]; records: (string[] | Record<string, string>)[] } {
  checkLimit(input.length, MAX_NODE_TEXT_CHARS, "CSV input");
  if (input.includes("\0") || !input.isWellFormed()) {
    throw new ExecutionError("CSV input must be well-formed Unicode text without NUL characters.");
  }
  let headers: string[] | undefined;
  let columnCount = 0;
  let rowCount = 0;
  let textSize = 2;
  let escapingSize = 0;
  const records: (string[] | Record<string, string>)[] = [];
  try {
    parse(input, {
      bom: true,
      delimiter: data.delimiter,
      record_delimiter: ["\r\n", "\n", "\r"],
      skip_empty_lines: true,
      // UTF-8 uses at most three bytes per UTF-16 input unit.
      max_record_size: MAX_NODE_TEXT_CHARS * 3,
      cast(value, context) {
        if (context.index >= MAX_CSV_COLUMNS) {
          throw new ExecutionError(`CSV must have at most ${MAX_CSV_COLUMNS} columns (line ${context.lines}).`);
        }
        const isHeader = data.headers && headers === undefined;
        checkLimit(value.length, isHeader ? MAX_CSV_HEADER_CHARS : MAX_CSV_FIELD_CHARS,
          `CSV ${isHeader ? "header" : "field"} at line ${context.lines}`);
        return value;
      },
      on_record(row: string[], context) {
        if (columnCount === 0) columnCount = row.length;
        if (data.headers && headers === undefined) {
          const seen = new Set<string>();
          for (const name of row) {
            if (!name.trim() || Object.hasOwn(RESERVED_HEADERS, name) || seen.has(name)) {
              throw new ExecutionError(`CSV headers must be nonblank, unique and not reserved (line ${context.lines}).`);
            }
            seen.add(name);
          }
          headers = row;
          return null;
        }
        if (rowCount >= MAX_CSV_ROWS) {
          throw new ExecutionError(`CSV must have at most ${MAX_CSV_ROWS} data rows (line ${context.lines}).`);
        }
        let record: string[] | Record<string, string> = row;
        if (headers) {
          const object: Record<string, string> = Object.create(null);
          for (let i = 0; i < headers.length; i++) object[headers[i]] = row[i];
          record = object;
        }
        // Reject repeated-header/escaping amplification before retaining this row.
        textSize += (rowCount > 0 ? 1 : 0) + jsonSize(record, MAX_NODE_TEXT_CHARS, "CSV output");
        checkLimit(textSize, MAX_NODE_TEXT_CHARS, "CSV output");
        escapingSize += traceEscapes(record);
        rowCount++;
        records.push(record);
        return null;
      },
    });
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    // Library errors can contain entire raw fields/records; never expose them.
    if (error instanceof CsvError) {
      const line = typeof error.lines === "number" && Number.isSafeInteger(error.lines) && error.lines > 0
        ? ` at line ${error.lines}` : "";
      const reason = error.code === "CSV_RECORD_INCONSISTENT_FIELDS_LENGTH"
        ? "inconsistent column count" : "invalid quoting or record";
      throw new ExecutionError(`CSV has ${reason}${line}.`);
    }
    throw new ExecutionError("CSV could not be parsed.");
  }
  reserveOutput?.(textSize, textSize + 2 + escapingSize);
  return { text: JSON.stringify(records), rowCount, columnCount, columnNames: headers ?? [], records };
}
