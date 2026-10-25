import type { ColumnInfo } from "@/drivers/types"

/** A row in the keyspace browser. */
export interface RedisKeyRow {
  readonly key: string
  readonly type: string
  /** Seconds; -1 means no expiry. */
  readonly ttl: number
}

/** Metadata for one key, shown in the table strip and used to choose a view. */
export interface RedisKeyInfo {
  readonly key: string
  readonly type: string
  /** Seconds; -1 means no expiry, -2 means the key disappeared. */
  readonly ttl: number
  readonly size: number | null
  readonly encoding: string | null
  /** Type-appropriate length: STRLEN, HLEN, LLEN, SCARD, ZCARD, XLEN. */
  readonly length: number | null
}

export interface RedisStreamEntry {
  readonly id: string
  readonly fields: ReadonlyArray<readonly [string, string]>
}

/**
 * One page of a Redis value. Table-like structures fill `columns`/`rows`;
 * strings and streams also carry the richer shape their custom renderer uses.
 */
export interface RedisPage {
  readonly info: RedisKeyInfo
  readonly columns: ReadonlyArray<ColumnInfo>
  readonly rows: ReadonlyArray<Record<string, unknown>>
  readonly total: number
  /**
   * Token for the next page, or null on the last page. Tokens are opaque to the
   * UI: SCAN cursors for keys/hash/set, offsets for list/zset, and stream IDs.
   */
  readonly nextToken: string | null
  /** Full/truncated text for string and RedisJSON views. */
  readonly text?: string
  /** A short explanation when a value was deliberately truncated. */
  readonly note?: string
  /** Parsed entries for the stream timeline. */
  readonly entries?: ReadonlyArray<RedisStreamEntry>
}

export interface RedisKeysPage {
  readonly rows: ReadonlyArray<RedisKeyRow>
  readonly total: number
  readonly nextToken: string | null
}

/** One changed field in a Redis collection row. Redis values are strings, so
 *  the editor never produces numbers or NULL. */
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
  /** Optional Redis glob pattern, used by SCAN's MATCH argument. */
  readonly match?: string
}
