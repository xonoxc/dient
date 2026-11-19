import type { ColumnInfo } from "@/drivers/types"

export interface RedisKeyRow {
  readonly key: string
  readonly type: string
  /** Seconds; -1 means no expiry. */
  readonly ttl: number
}

export interface RedisKeyInfo {
  readonly key: string
  readonly type: string
  /** Seconds; -1 means no expiry, -2 means the key disappeared. */
  readonly ttl: number
  readonly size: number | null
  readonly encoding: string | null
  /** STRLEN, HLEN, LLEN, SCARD, ZCARD or XLEN, depending on type. */
  readonly length: number | null
}

export interface RedisStreamEntry {
  readonly id: string
  readonly fields: ReadonlyArray<readonly [string, string]>
}

/** One page of a value; strings and streams also carry their custom shape. */
export interface RedisPage {
  readonly info: RedisKeyInfo
  readonly columns: ReadonlyArray<ColumnInfo>
  readonly rows: ReadonlyArray<Record<string, unknown>>
  readonly total: number
  /** Opaque to the UI: SCAN cursors, list/zset offsets, or stream IDs. */
  readonly nextToken: string | null
  readonly text?: string
  readonly note?: string
  readonly entries?: ReadonlyArray<RedisStreamEntry>
}

export interface RedisKeysPage {
  readonly rows: ReadonlyArray<RedisKeyRow>
  readonly total: number
  readonly nextToken: string | null
}

/** Redis values are strings, so edits never produce numbers or NULL. */
export interface RedisRowUpdate {
  readonly column: string
  readonly param: string
}

export interface RedisPageRequest {
  readonly token: string | null
  readonly count: number
}

export interface RedisKeysRequest {
  readonly token: string | null
  readonly count: number
  /** Redis glob pattern passed to SCAN's MATCH. */
  readonly match?: string
}

/** Collection values use name/value pairs so one editor form covers every type. */
export type RedisKeyDraft =
  | {
      readonly key: string
      readonly type: "string"
      readonly value: string
      readonly ttl: number
    }
  | {
      readonly key: string
      readonly type: "hash"
      readonly entries: ReadonlyArray<readonly [string, string]>
      readonly ttl: number
    }
  | {
      readonly key: string
      readonly type: "list" | "set"
      readonly entries: ReadonlyArray<string>
      readonly ttl: number
    }
  | {
      readonly key: string
      readonly type: "zset"
      readonly entries: ReadonlyArray<readonly [string, string]>
      readonly ttl: number
    }
