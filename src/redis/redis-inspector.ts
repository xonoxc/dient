/**
 * Redis inspection layer. It turns raw Redis commands into the small typed
 * pages the explorer draws. No React or UI code lives here.
 *
 * Safety choices:
 *   - Keys are discovered with SCAN, never KEYS.
 *   - Every page is bounded by a caller-supplied count.
 *   - Strings are read with GETRANGE so a multi-megabyte value cannot stall the
 *     TUI; the page reports that it was truncated.
 *   - Only read commands are issued from this module.
 */
import { Context, Effect, Layer } from "effect"
import type { ActiveConnection, ColumnInfo } from "@/drivers/types"
import { QueryError } from "@/drivers/types"
import { RedisDriver, type RedisDriverService } from "@/drivers/redis"
import type {
  RedisKeyInfo,
  RedisKeyRow,
  RedisKeysPage,
  RedisKeysRequest,
  RedisPage,
  RedisPageRequest,
  RedisStreamEntry,
} from "@/redis/types"

const ENGINE = "redis" as const

/** How many bytes of a string view are fetched at once. */
export const MAX_VALUE_BYTES = 64_000

export interface RedisInspectorService {
  readonly listKeys: (conn: ActiveConnection, request: RedisKeysRequest) => Effect.Effect<RedisKeysPage, QueryError>
  readonly describeKey: (conn: ActiveConnection, key: string) => Effect.Effect<RedisKeyInfo, QueryError>
  readonly loadValue: (
    conn: ActiveConnection,
    key: string,
    request: RedisPageRequest
  ) => Effect.Effect<RedisPage, QueryError>
}

export class RedisInspector extends Context.Tag("RedisInspector")<RedisInspector, RedisInspectorService>() {}

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""))
const number = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}
const flatPairs = (value: unknown): ReadonlyArray<readonly [string, string]> => {
  if (!Array.isArray(value)) return []
  const pairs: Array<readonly [string, string]> = []
  for (let index = 0; index + 1 < value.length; index += 2) {
    pairs.push([text(value[index]), text(value[index + 1])])
  }
  return pairs
}
const arrayOf = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

const queryError = (message: string, cause?: unknown): QueryError => new QueryError({ engine: ENGINE, message, cause })

const columns = (...names: ReadonlyArray<string>): ReadonlyArray<ColumnInfo> => names.map(name => ({ name }))

const lengthCommand = (type: string, key: string): readonly [string, ReadonlyArray<string>] | null => {
  switch (type) {
    case "string":
      return ["STRLEN", [key]]
    case "hash":
      return ["HLEN", [key]]
    case "list":
      return ["LLEN", [key]]
    case "set":
      return ["SCARD", [key]]
    case "zset":
      return ["ZCARD", [key]]
    case "stream":
      return ["XLEN", [key]]
    default:
      return null
  }
}

export const makeRedisInspector = (driver: RedisDriverService): RedisInspectorService => {
  const command = (conn: ActiveConnection, name: string, args: ReadonlyArray<string | number> = []) =>
    driver.command(conn, name, args)

  const optional = <A>(effect: Effect.Effect<A, QueryError>): Effect.Effect<A | null> =>
    effect.pipe(Effect.orElseSucceed(() => null))

  const describeKey = (conn: ActiveConnection, key: string): Effect.Effect<RedisKeyInfo, QueryError> =>
    Effect.gen(function* () {
      const type = text(yield* command(conn, "TYPE", [key]))
      const ttl = number(yield* command(conn, "TTL", [key]), -1)
      const size = yield* optional(command(conn, "MEMORY", ["USAGE", key]).pipe(Effect.map(value => number(value))))
      const encoding = yield* optional(
        command(conn, "OBJECT", ["ENCODING", key]).pipe(Effect.map(value => text(value)))
      )
      const lengthSpec = lengthCommand(type, key)
      const length = lengthSpec
        ? yield* optional(command(conn, lengthSpec[0], lengthSpec[1]).pipe(Effect.map(value => number(value))))
        : null
      return { key, type, ttl, size, encoding, length }
    })

  const listKeys = (conn: ActiveConnection, request: RedisKeysRequest): Effect.Effect<RedisKeysPage, QueryError> =>
    Effect.gen(function* () {
      const token = request.token ?? "0"
      const args = [token, "COUNT", String(Math.max(1, request.count))]
      if (request.match && request.match.trim()) args.push("MATCH", request.match.trim())

      const scanned = yield* command(conn, "SCAN", args)
      const [next, rawKeys] = Array.isArray(scanned) ? scanned : ["0", []]
      const keys = [...new Set(arrayOf(rawKeys).map(text).filter(Boolean))]

      /* TYPE and TTL are per key; run a bounded fan-out so a page of a few
         hundred keys stays responsive without unbounded command spam. */
      const rows = yield* Effect.all(
        keys.map(key =>
          Effect.gen(function* () {
            const type = text(yield* command(conn, "TYPE", [key]))
            if (type === "none") return null
            const ttl = number(yield* command(conn, "TTL", [key]), -1)
            return { key, type, ttl } satisfies RedisKeyRow
          })
        ),
        { concurrency: 16 }
      )

      const total = yield* command(conn, "DBSIZE", []).pipe(
        Effect.map(value => number(value)),
        Effect.orElseSucceed(() => 0)
      )
      const nextToken = text(next) === "0" ? null : text(next)
      return {
        rows: rows.filter((row): row is RedisKeyRow => row !== null),
        total,
        nextToken,
      }
    })

  const stringPage = (conn: ActiveConnection, info: RedisKeyInfo): Effect.Effect<RedisPage, QueryError> =>
    Effect.gen(function* () {
      const value = yield* command(conn, "GETRANGE", [info.key, "0", String(MAX_VALUE_BYTES - 1)])
      const body = text(value)
      const truncated = (info.length ?? 0) > MAX_VALUE_BYTES
      return {
        info,
        columns: columns("value"),
        rows: [{ value: body }],
        total: 1,
        nextToken: null,
        text: body,
        note: truncated
          ? `showing first ${MAX_VALUE_BYTES.toLocaleString()} bytes of ${info.length?.toLocaleString()}`
          : undefined,
      }
    })

  const hashPage = (
    conn: ActiveConnection,
    info: RedisKeyInfo,
    request: RedisPageRequest
  ): Effect.Effect<RedisPage, QueryError> =>
    Effect.gen(function* () {
      const token = request.token ?? "0"
      const scanned = yield* command(conn, "HSCAN", [info.key, token, "COUNT", String(Math.max(1, request.count))])
      const [next, flat] = Array.isArray(scanned) ? scanned : ["0", []]
      const rows = flatPairs(flat).map(([field, value]) => ({ field, value }))
      return {
        info,
        columns: columns("field", "value"),
        rows,
        total: info.length ?? rows.length,
        nextToken: text(next) === "0" ? null : text(next),
      }
    })

  const setPage = (
    conn: ActiveConnection,
    info: RedisKeyInfo,
    request: RedisPageRequest
  ): Effect.Effect<RedisPage, QueryError> =>
    Effect.gen(function* () {
      const token = request.token ?? "0"
      const scanned = yield* command(conn, "SSCAN", [info.key, token, "COUNT", String(Math.max(1, request.count))])
      const [next, members] = Array.isArray(scanned) ? scanned : ["0", []]
      const rows = arrayOf(members).map(member => ({ member: text(member) }))
      return {
        info,
        columns: columns("member"),
        rows,
        total: info.length ?? rows.length,
        nextToken: text(next) === "0" ? null : text(next),
      }
    })

  const listPage = (
    conn: ActiveConnection,
    info: RedisKeyInfo,
    request: RedisPageRequest
  ): Effect.Effect<RedisPage, QueryError> =>
    Effect.gen(function* () {
      const offset = number(request.token ?? "0")
      const count = Math.max(1, request.count)
      const values = arrayOf(yield* command(conn, "LRANGE", [info.key, String(offset), String(offset + count - 1)]))
      const rows = values.map((value, index) => ({ index: offset + index, value: text(value) }))
      const nextOffset = offset + rows.length
      const knownTotal = info.length
      return {
        info,
        columns: columns("index", "value"),
        rows,
        total: knownTotal ?? rows.length,
        nextToken:
          knownTotal !== null
            ? nextOffset < knownTotal
              ? String(nextOffset)
              : null
            : rows.length >= count
              ? String(nextOffset)
              : null,
      }
    })

  const zsetPage = (
    conn: ActiveConnection,
    info: RedisKeyInfo,
    request: RedisPageRequest
  ): Effect.Effect<RedisPage, QueryError> =>
    Effect.gen(function* () {
      const offset = number(request.token ?? "0")
      const count = Math.max(1, request.count)
      const flat = arrayOf(
        yield* command(conn, "ZRANGE", [info.key, String(offset), String(offset + count - 1), "WITHSCORES"])
      )
      /* Bun's client returns WITHSCORES as `[member, score]` pairs; a plain
         RESP client would return a flat array. Accept both shapes. */
      const pairs: ReadonlyArray<readonly [string, string]> =
        flat.length > 0 && Array.isArray(flat[0])
          ? flat.flatMap(raw => (Array.isArray(raw) && raw.length >= 2 ? [[text(raw[0]), text(raw[1])] as const] : []))
          : (() => {
              const result: Array<readonly [string, string]> = []
              for (let index = 0; index + 1 < flat.length; index += 2) {
                result.push([text(flat[index]), text(flat[index + 1])] as const)
              }
              return result
            })()
      const rows: Array<Record<string, unknown>> = pairs.map(([member, score], index) => ({
        rank: offset + index + 1,
        score,
        member,
      }))
      const nextOffset = offset + rows.length
      const knownTotal = info.length
      return {
        info,
        columns: columns("rank", "score", "member"),
        rows,
        total: knownTotal ?? rows.length,
        nextToken:
          knownTotal !== null
            ? nextOffset < knownTotal
              ? String(nextOffset)
              : null
            : rows.length >= count
              ? String(nextOffset)
              : null,
      }
    })

  const streamPage = (
    conn: ActiveConnection,
    info: RedisKeyInfo,
    request: RedisPageRequest
  ): Effect.Effect<RedisPage, QueryError> =>
    Effect.gen(function* () {
      const start = request.token ? `(${request.token}` : "-"
      const count = Math.max(1, request.count)
      /* Ask for one extra entry: XRANGE cannot tell us "this is the last page"
         from an exactly-full page, and a phantom next page is worse than one
         extra parsed entry. */
      const rawEntries = arrayOf(yield* command(conn, "XRANGE", [info.key, start, "+", "COUNT", String(count + 1)]))
      const hasMore = rawEntries.length > count
      const visible = rawEntries.slice(0, count)
      const entries: Array<RedisStreamEntry> = []
      const rows: Array<Record<string, unknown>> = []
      for (const raw of visible) {
        if (!Array.isArray(raw) || raw.length < 2) continue
        const id = text(raw[0])
        const fields = flatPairs(raw[1])
        entries.push({ id, fields })
        rows.push({ id, fields: fields.map(([field, value]) => `${field}=${value}`).join(" · ") })
      }
      const lastId = hasMore ? (entries[entries.length - 1]?.id ?? null) : null
      return {
        info,
        columns: columns("id", "fields"),
        rows,
        total: info.length ?? rows.length,
        nextToken: lastId,
        entries,
      }
    })

  const jsonPage = (conn: ActiveConnection, info: RedisKeyInfo): Effect.Effect<RedisPage, QueryError> =>
    command(conn, "JSON.GET", [info.key]).pipe(
      Effect.map(value => {
        const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "null")
        /* RedisJSON returns compact JSON; indent it so the wrapped-text panel
           reads like a document instead of one endless line. */
        const body = (() => {
          try {
            return JSON.stringify(JSON.parse(raw), null, 2)
          } catch {
            return raw
          }
        })()
        const truncated = body.length > MAX_VALUE_BYTES
        const display = truncated ? body.slice(0, MAX_VALUE_BYTES) : body
        return {
          info,
          columns: columns("json"),
          rows: [{ json: display }],
          total: 1,
          nextToken: null,
          text: display,
          note: truncated
            ? `showing first ${MAX_VALUE_BYTES.toLocaleString()} characters of ${body.length.toLocaleString()}`
            : undefined,
        }
      }),
      Effect.mapError(cause =>
        cause instanceof QueryError
          ? queryError(`could not read RedisJSON key ${info.key}: ${cause.message}`, cause)
          : cause
      )
    )

  const loadValue = (
    conn: ActiveConnection,
    key: string,
    request: RedisPageRequest
  ): Effect.Effect<RedisPage, QueryError> =>
    Effect.gen(function* () {
      const info = yield* describeKey(conn, key)
      switch (info.type) {
        case "string":
          return yield* stringPage(conn, info)
        case "hash":
          return yield* hashPage(conn, info, request)
        case "list":
          return yield* listPage(conn, info, request)
        case "set":
          return yield* setPage(conn, info, request)
        case "zset":
          return yield* zsetPage(conn, info, request)
        case "stream":
          return yield* streamPage(conn, info, request)
        case "ReJSON-RL":
        case "json":
          return yield* jsonPage(conn, info)
        case "none":
          return yield* Effect.fail(queryError(`key ${key} no longer exists`))
        default:
          return {
            info,
            columns: columns("type", "encoding", "size"),
            rows: [{ type: info.type, encoding: info.encoding ?? "—", size: info.size ?? "—" }],
            total: 1,
            nextToken: null,
            note: `no dedicated view for Redis type "${info.type}"`,
          }
      }
    })

  return { listKeys, describeKey, loadValue }
}

export namespace RedisInspector {
  export const layer: Layer.Layer<RedisInspector, never, RedisDriver> = Layer.effect(
    RedisInspector,
    Effect.gen(function* () {
      const driver = yield* RedisDriver
      return makeRedisInspector(driver)
    })
  )
}
