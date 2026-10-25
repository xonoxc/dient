/**
 * Redis collection rows ↔ `$EDITOR` text. Redis has no column types or NULL,
 * so this intentionally does not reuse the SQL row parser: every value is a
 * string, and `field`, `member` and `score` are all editable. Primary-key-like
 * columns (`index` for lists, `rank` for sorted sets) are shown for orientation
 * and rejected if changed, because they identify the row being written.
 *
 * Values are escaped one level (`\n`, `\r`, `\\`, `\"`) so a hash value
 * containing a newline stays one editable line instead of becoming an
 * unrelated field, and a literal `""` is distinct from the empty string.
 */
import type { TableColumn } from "@/inspector/types"
import { formatCell } from "@/table/use-table"
import { isRedisScore } from "@/redis/format"
import type { RedisRowUpdate } from "@/redis/types"

export interface RedisRowShape {
  readonly columns: ReadonlyArray<TableColumn>
  readonly primaryKey: ReadonlyArray<string>
}

export type RedisRowParseResult =
  | { readonly ok: true; readonly updates: ReadonlyArray<RedisRowUpdate> }
  | { readonly ok: false; readonly error: string }

const COMMENT = "#"
const EMPTY_LITERAL = '""'

const HEADER: ReadonlyArray<string> = [
  "# Edit values using: column: value",
  "# Missing columns are left unchanged.",
  '# Use "" for an empty value and \\" for a quote.',
  "# Use \\n for newlines and \\\\ for a backslash.",
  "# index/rank are fixed; edit value/score/member instead.",
]

const stringColumn = (name: string): TableColumn => ({ name, type: "string", nullable: false })

/** The editable shape of a Redis collection, or null for types with no table
 *  editor (string/JSON use the text editor, streams are append-only). */
export const redisRowShape = (type: string): RedisRowShape | null => {
  switch (type) {
    case "hash":
      return { columns: [stringColumn("field"), stringColumn("value")], primaryKey: [] }
    case "list":
      return {
        columns: [{ name: "index", type: "integer", nullable: false }, stringColumn("value")],
        primaryKey: ["index"],
      }
    case "set":
      return { columns: [stringColumn("member")], primaryKey: [] }
    case "zset":
      return {
        columns: [
          { name: "rank", type: "integer", nullable: false },
          { name: "score", type: "numeric", nullable: false },
          stringColumn("member"),
        ],
        primaryKey: ["rank"],
      }
    default:
      return null
  }
}

const escapeValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")

const unescapeValue = (value: string): string =>
  value.replace(/\\(\\|n|r|")/g, (_match, escape: string) =>
    escape === "n" ? "\n" : escape === "r" ? "\r" : escape === '"' ? '"' : "\\"
  )

const lineFor = (column: TableColumn, row: Readonly<Record<string, unknown>>): string => {
  const text = formatCell(row[column.name])
  return `${column.name}: ${text === "" ? EMPTY_LITERAL : escapeValue(text)}`
}

/** Render a collection row with a short format header, one field per block. */
export const serializeRedisRow = (
  columns: ReadonlyArray<TableColumn>,
  row: Readonly<Record<string, unknown>>
): string => [...HEADER, "", columns.map(column => lineFor(column, row)).join("\n\n"), ""].join("\n")

/** Parse the edited row back into the changed fields, or explain the first
 *  malformed line. No command is sent unless every line is valid. */
export const parseRedisRow = (
  content: string,
  columns: ReadonlyArray<TableColumn>,
  primaryKey: ReadonlyArray<string>,
  row: Readonly<Record<string, unknown>>
): RedisRowParseResult => {
  const byName = new Map(columns.map(column => [column.name, column]))
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const pending = new Map<string, RedisRowUpdate>()

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith(COMMENT)) continue

    const colon = line.indexOf(":")
    if (colon < 0) {
      return { ok: false, error: `line ${lineNo}: expected "column: value"` }
    }

    const key = line.slice(0, colon).trim()
    let rawValue = line.slice(colon + 1)
    /* The serializer places exactly one space after the colon. Remove that
       delimiter, not every space, so leading/trailing value spaces survive. */
    if (rawValue.startsWith(" ")) rawValue = rawValue.slice(1)
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

    const value = rawValue === EMPTY_LITERAL ? "" : unescapeValue(rawValue)
    const original = row[column.name]
    const originalText = formatCell(original)

    if (primaryKey.includes(key)) {
      if (value !== originalText) {
        return { ok: false, error: `line ${lineNo}: column "${key}" cannot be changed` }
      }
      continue
    }

    if (value === originalText) continue

    if (column.type === "numeric" && !isRedisScore(value)) {
      return { ok: false, error: `line ${lineNo}: \"${key}\" expects a number` }
    }
    pending.set(key, { column: key, param: value })
  }

  return { ok: true, updates: [...pending.values()] }
}
