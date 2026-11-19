/**
 * Serialize rows to `$EDITOR` key/value text and parse it back; also renders
 * rows as a padded Markdown table for the clipboard.
 */
import type { TableColumn } from "@/inspector/types"
import { columnWidth, formatCell } from "@/table/use-table"
import { validateCellValue } from "@/editor/validate-cell"

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

/** One `column: value` line per field; shared by the editor file and clipboard. */
export const rowToKeyValueLines = (
  columns: ReadonlyArray<TableColumn>,
  row: Readonly<Record<string, unknown>>
): ReadonlyArray<string> =>
  columns.map(column => {
    const value = row[column.name]
    if (value === null || value === undefined) return `${column.name}: ${NULL_LITERAL}`
    const text = formatCell(value)
    /* An empty string would otherwise serialize as a bare `column:` line,
       which the parser rightly rejects as an empty value. */
    return `${column.name}: ${text === "" ? EMPTY_LITERAL : text}`
  })

export const serializeRowToKeyValue = (
  columns: ReadonlyArray<TableColumn>,
  row: Readonly<Record<string, unknown>>
): string => [...FORMAT_HEADER, "", rowToKeyValueLines(columns, row).join("\n\n"), ""].join("\n")

/** Characters that would break a Markdown table, escaped in place. */
const MARKDOWN_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\|/g, "\\|"],
  [/\t/g, "\\t"],
  [/\r/g, "\\r"],
  [/\n/g, "\\n"],
]

const markdownField = (value: unknown): string => {
  let text = formatCell(value)
  for (const [pattern, escape] of MARKDOWN_ESCAPES) text = text.replace(pattern, escape)
  return text
}

/** Rows as a padded Markdown table for the clipboard; `MAX_COL_WIDTH` is not
    applied so no value is truncated. */
export const serializeRowsToMarkdown = (
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): string => {
  const headers = columns.map(column => markdownField(column.name))
  const body = rows.map(row => columns.map(column => markdownField(row[column.name])))

  /* Per-column measure, matching the grid, including its minimum width. */
  const widths = columns.map((column, index) =>
    columnWidth(column.name, [headers[index]!, ...body.map(cells => cells[index]!)])
  )

  const line = (cells: ReadonlyArray<string>): string =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`
  const rule = `| ${widths.map(width => "-".repeat(width)).join(" | ")} |`

  return [line(headers), rule, ...body.map(line)].join("\n") + "\n"
}

/** Cell-editor semantics: numerics become numbers, empty nullable becomes NULL. */
export const parseFieldValue = (column: TableColumn, value: string): unknown => {
  const type = (column.type ?? "").toLowerCase()
  if (/int|bigint|smallint|numeric|decimal|real|float|double|serial|money|double_precision/.test(type)) {
    return Number(value)
  }
  if (value === "" && column.nullable) return null
  return value
}

/** Parse an edited file into UPDATE params: changed, non-PK columns only, all
    validated before returning so a bad file never touches the database. */
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
