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
import { Either } from "effect"
import { parseJson } from "@/effect/json"
import { formatCell } from "@/table/use-table"
import { isRedisScore } from "@/redis/format"
import type { RedisKeyDraft, RedisRowUpdate } from "@/redis/types"

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

/** Template shown when `a` creates a key. It deliberately uses a string key:
 *  the other shapes are one edit away and the parser's error messages explain
 *  the accepted `entries` form. */
export const REDIS_KEY_TEMPLATE = `{
  "key": "new:key",
  "type": "string",
  "value": "hello",
  "ttl": -1
}
`

export type RedisKeyDraftParseResult =
  { readonly ok: true; readonly draft: RedisKeyDraft } | { readonly ok: false; readonly error: string }

const scalar = (value: unknown): string | null => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return null
}

const parseTtl = (value: unknown): number | string => {
  const ttl = typeof value === "number" ? value : Number(value ?? -1)
  if (!Number.isInteger(ttl) || ttl < -1) {
    return "ttl must be an integer: -1 for no expiry, or a positive number of seconds"
  }
  if (ttl === 0) return "ttl 0 would delete the key immediately; use -1 or a positive number"
  return ttl
}

/** Parse the `$EDITOR` form used by `a` (new key). */
export const parseRedisKeyDraft = (content: string): RedisKeyDraftParseResult => {
  const parsed = parseJson(content)
  if (Either.isLeft(parsed)) {
    return { ok: false, error: `invalid JSON: ${String(parsed.left)}` }
  }
  const value = parsed.right
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "expected a JSON object" }
  }
  const record = value as Record<string, unknown>
  const key = typeof record.key === "string" ? record.key.trim() : ""
  if (key === "") return { ok: false, error: "key is required" }
  const ttl = parseTtl(record.ttl ?? -1)
  if (typeof ttl === "string") return { ok: false, error: ttl }
  const type = record.type
  if (type !== "string" && type !== "hash" && type !== "list" && type !== "set" && type !== "zset") {
    return { ok: false, error: "type must be string, hash, list, set, or zset" }
  }

  if (type === "string") {
    if (typeof record.value !== "string") return { ok: false, error: "string keys need a string `value`" }
    return { ok: true, draft: { key, type, value: record.value, ttl } }
  }

  const entries = record.entries
  if (type === "hash") {
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
      return { ok: false, error: "hash keys need an `entries` object of field: value pairs" }
    }
    const pairs: Array<readonly [string, string]> = []
    for (const [field, raw] of Object.entries(entries as Record<string, unknown>)) {
      const entry = scalar(raw)
      if (entry === null) return { ok: false, error: `hash field "${field}" must be a string or number` }
      pairs.push([field, entry])
    }
    if (pairs.length === 0) return { ok: false, error: "hash keys need at least one field" }
    return { ok: true, draft: { key, type, entries: pairs, ttl } }
  }

  if (type === "list" || type === "set") {
    if (!Array.isArray(entries)) {
      return { ok: false, error: `${type} keys need an \`entries\` array` }
    }
    const values: Array<string> = []
    for (const raw of entries) {
      const entry = scalar(raw)
      if (entry === null) return { ok: false, error: `${type} entries must be strings or numbers` }
      values.push(entry)
    }
    if (values.length === 0) return { ok: false, error: `${type} keys need at least one entry` }
    return { ok: true, draft: { key, type, entries: values, ttl } }
  }

  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    return { ok: false, error: "zset keys need an `entries` object of member: score pairs" }
  }
  const scored: Array<readonly [string, string]> = []
  for (const [member, raw] of Object.entries(entries as Record<string, unknown>)) {
    const score = scalar(raw)
    if (score === null || !isRedisScore(score)) {
      return { ok: false, error: `zset member "${member}" needs a numeric score` }
    }
    scored.push([member, score])
  }
  if (scored.length === 0) return { ok: false, error: "zset keys need at least one member" }
  return { ok: true, draft: { key, type, entries: scored, ttl } }
}

/** Parse the one-line TTL editor. `-1`/`persist`/`none` clears the expiry. */
export const parseRedisTtl = (
  content: string
): { readonly ok: true; readonly ttl: number } | { readonly ok: false; readonly error: string } => {
  const text = content.trim().toLowerCase()
  if (text === "-1" || text === "persist" || text === "none" || text === "no expiry") {
    return { ok: true, ttl: -1 }
  }
  const ttl = Number(text)
  if (!Number.isInteger(ttl) || ttl <= 0) {
    return { ok: false, error: "ttl must be a positive number of seconds, or -1 to persist the key" }
  }
  return { ok: true, ttl }
}
