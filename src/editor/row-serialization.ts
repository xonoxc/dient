/**
 * Row ↔ `$EDITOR` file serialization. A row is presented as one `column: value`
 * pair per line, generated from the actual table schema, plus a short comment
 * header explaining the format:
 *
 *   # Edit values using: column: value
 *   # Use NULL explicitly for SQL NULL.
 *   # Missing columns are left unchanged.
 *   id: 3
 *   user_id: 2
 *   quantity: 3
 *
 * Semantics:
 *   - `column: value` updates that column to the parsed value.
 *   - `column: NULL` (case-sensitive) sets it to SQL `NULL`.
 *   - `""` (exactly two double quotes) sets the empty string.
 *   - A missing column is left unchanged.
 *   - `column:` with nothing after the colon is a validation error.
 *   - Unknown columns and lines without a `:` are validation errors.
 *   - Only the *first* `:` splits, so values containing `:` stay intact.
 *   - `#` comment lines and blank lines are ignored.
 *
 * The primary key is written (for orientation) but never updated — it keys the
 * UPDATE. Only columns whose value differs from the original row are reported,
 * and each is validated against its column type before being parsed.
 */
import type { TableColumn } from "@/inspector/types"
import { formatCell } from "@/table/use-table"
import { validateCellValue } from "@/editor/use-cell-editor"

export interface RowValueUpdate {
  readonly column: string
  readonly param: unknown
}

export type RowParseResult =
  | { readonly ok: true; readonly updates: ReadonlyArray<RowValueUpdate> }
  | { readonly ok: false; readonly error: string }

const COMMENT = "#"
const NULL_LITERAL = "NULL"
const EMPTY_LITERAL = '""'

const FORMAT_HEADER: ReadonlyArray<string> = [
  "# Edit values using: column: value",
  "# Use NULL explicitly for SQL NULL.",
  "# Missing columns are left unchanged.",
]

/** Serialize a row as schema-ordered `column: value` lines with a comment header. */
export const serializeRowToKeyValue = (
  columns: ReadonlyArray<TableColumn>,
  row: Readonly<Record<string, unknown>>
): string => {
  const lines = columns.map(column => {
    const value = row[column.name]
    if (value === null || value === undefined) return `${column.name}: ${NULL_LITERAL}`
    const text = formatCell(value)
    /* An empty string would otherwise serialize as a bare `column:` line,
       which the parser rightly rejects as an empty value. */
    return `${column.name}: ${text === "" ? EMPTY_LITERAL : text}`
  })
  return [...FORMAT_HEADER, ...lines].join("\n") + "\n"
}

/** Parse a field's edited text into a query parameter (cell-editor semantics):
    numerics become numbers, an empty draft on a nullable column becomes NULL,
    everything else stays a string. */
export const parseFieldValue = (column: TableColumn, value: string): unknown => {
  const type = (column.type ?? "").toLowerCase()
  if (/int|bigint|smallint|numeric|decimal|real|float|double|serial|money|double_precision/.test(type)) {
    return Number(value)
  }
  if (value === "" && column.nullable) return null
  return value
}

/**
 * Parse an edited `$EDITOR` file back into UPDATE parameters. The primary key
 * is never written (it keys the UPDATE); only columns whose value differs from
 * the original row are included, and each is validated before being parsed.
 * Any malformed line (no `:`, empty value, unknown column, type mismatch) fails
 * parsing with a line-numbered error and no updates — the database is never
 * touched on a bad file.
 */
export const parseRowKeyValue = (
  content: string,
  columns: ReadonlyArray<TableColumn>,
  primaryKey: ReadonlyArray<string>,
  row: Readonly<Record<string, unknown>>
): RowParseResult => {
  const byName = new Map(columns.map(column => [column.name, column]))
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const pending = new Map<string, RowValueUpdate>()

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const line = lines[index]!.trim()
    if (line === "" || line.startsWith(COMMENT)) continue

    const colon = line.indexOf(":")
    if (colon < 0) {
      return { ok: false, error: `line ${lineNo}: expected "column: value"` }
    }

    const key = line.slice(0, colon).trim()
    const rawValue = line.slice(colon + 1).trim()
    if (rawValue === "") {
      return { ok: false, error: `line ${lineNo}: empty value for column "${key}"` }
    }
    if (key === "") {
      return { ok: false, error: `line ${lineNo}: missing column name` }
    }

    const column = byName.get(key)
    if (!column) {
      return { ok: false, error: `line ${lineNo}: unknown column "${key}"` }
    }
    /* The primary key never changes; it only keys the UPDATE. */
    if (primaryKey.includes(key)) continue

    const original = row[column.name]
    const originalText = original === null || original === undefined ? null : formatCell(original)

    if (rawValue === NULL_LITERAL) {
      if (column.nullable === false) {
        return { ok: false, error: `line ${lineNo}: column "${key}" cannot be NULL` }
      }
      if (originalText !== null) pending.set(key, { column: key, param: null })
      continue
    }

    if (rawValue === EMPTY_LITERAL) {
      if (originalText !== "") pending.set(key, { column: key, param: "" })
      continue
    }

    if (originalText !== null && rawValue === originalText) continue

    const validation = validateCellValue(column, rawValue)
    if (validation) return { ok: false, error: `line ${lineNo}: ${validation}` }
    pending.set(key, { column: key, param: parseFieldValue(column, rawValue) })
  }

  return { ok: true, updates: [...pending.values()] }
}