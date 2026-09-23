/**
 * Row ↔ TSV serialization for `$EDITOR`-based row editing. A row is presented
 * as a two-line, tab-separated table: a header line of column names and one
 * line of values. The user edits it in their editor of choice and the file is
 * parsed back into typed UPDATE parameters.
 *
 * Cells follow RFC-4180-style quoting limited to what matters here: a cell
 * containing a tab, newline, or double quote is wrapped in double quotes with
 * embedded quotes doubled. An *unquoted empty* cell means NULL; `""` is an
 * empty string. Values are written the way the table displays them
 * (`formatCell`), so the diff against the original row compares like with
 * like.
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

const quoteCell = (value: string): string =>
  value === "" || /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

export const serializeRowToTsv = (
  columns: ReadonlyArray<TableColumn>,
  row: Readonly<Record<string, unknown>>
): string => {
  /* Build header and value strings first, then compute widths for alignment. */
  const headers = columns.map(column => quoteCell(column.name))
  const cells = columns.map(column => {
    const value = row[column.name]
    if (value === null || value === undefined) return ""
    return quoteCell(formatCell(value))
  })
  /* Pad each column to the widest of header/value + 2 gutter so the file
     looks clean and grid-like when opened in $EDITOR. */
  const widths = columns.map((_, index) =>
    Math.max(headers[index]!.length, cells[index]!.length) + 2
  )
  const padded = (arr: string[]) =>
    arr.map((cell, index) => cell.padEnd(widths[index]!)).join("\t")
  return `${padded([...headers])}\n${padded([...cells])}\n`
}

/** Parse one TSV line into cells; `null` means an unquoted empty cell (NULL).
 *  Trailing whitespace on unquoted cells is stripped so the column-aligned
 *  padding from `serializeRowToTsv` does not pollute values. */
export const parseTsvCells = (line: string): ReadonlyArray<string | null> => {
  const cells: Array<string | null> = []
  let index = 0
  let current = ""
  let quoted = false
  while (index < line.length) {
    const ch = line[index]
    if (ch === '"') {
      quoted = true
      index += 1
      while (index < line.length) {
        if (line[index] === '"') {
          if (line[index + 1] === '"') {
            current += '"'
            index += 2
          } else {
            index += 1
            break
          }
        } else {
          current += line[index]
          index += 1
        }
      }
      /* Skip post-quote padding: any spaces between the closing "
         and the next tab are column padding, not value content. */
      while (index < line.length && line[index] === " ") index += 1
    } else if (ch === "\t") {
      /* Trim trailing whitespace from unquoted cells — it is alignment
         padding, not meaningful value content. Quoted cells stay as-is. */
      const trimmed = quoted ? current : current.trimEnd()
      cells.push(trimmed === "" && !quoted ? null : trimmed)
      current = ""
      quoted = false
      index += 1
    } else {
      current += ch
      index += 1
    }
  }
  const trimmed = quoted ? current : current.trimEnd()
  cells.push(trimmed === "" && !quoted ? null : trimmed)
  return cells
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
 * Parse an edited TSV file back into UPDATE parameters. The primary key is
 * never written (it keys the UPDATE); only columns whose cell differs from the
 * original row are included, and each is validated before being parsed.
 */
export const parseRowTsv = (
  content: string,
  columns: ReadonlyArray<TableColumn>,
  primaryKey: ReadonlyArray<string>,
  row: Readonly<Record<string, unknown>>
): RowParseResult => {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  if (lines.length < 2) {
    return { ok: false, error: "the editor file needs a header row and one data row" }
  }
  const header = parseTsvCells(lines[0]!)
  const values = parseTsvCells(lines[1]!)
  const updates: RowValueUpdate[] = []
  for (const column of columns) {
    if (primaryKey.includes(column.name)) continue
    const index = header.indexOf(column.name)
    if (index < 0 || index >= values.length) continue
    const edited = values[index]
    const original = row[column.name]
    const originalText = original === null || original === undefined ? null : formatCell(original)
    if (edited === null) {
      if (originalText === null) continue
    } else if (originalText !== null && edited === originalText) {
      continue
    }
    const value = edited ?? ""
    const validation = validateCellValue(column, value)
    if (validation) return { ok: false, error: validation }
    updates.push({ column: column.name, param: parseFieldValue(column, value) })
  }
  return { ok: true, updates }
}