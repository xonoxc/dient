/** Human-readable Redis metadata; the data layer returns raw seconds/bytes. */
import type { RedisKeyInfo } from "@/redis/types"

/** Module types use protocol names (`ReJSON-RL`); the UI wants `json`. */
export const redisTypeLabel = (type: string): string => (type === "ReJSON-RL" || type === "json" ? "json" : type)

/** Redis's `strtod` accepts signs, `.5`/`1.`, exponents and `inf`, unlike the
 *  narrower SQL numeric rule. */
export const isRedisScore = (value: string): boolean =>
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || /^[+-]?inf$/i.test(value)

export const redisTypeSymbol = (type: string): string => {
  switch (type) {
    case "string":
      return '"'
    case "hash":
      return "#"
    case "list":
      return "≡"
    case "set":
      return "∈"
    case "zset":
      return "↕"
    case "stream":
      return "»"
    case "ReJSON-RL":
    case "json":
      return "{}"
    default:
      return "?"
  }
}

/** Semantic token, not an RGBA, so the view resolves it against the palette. */
export type RedisTypeTone = "success" | "info" | "warning" | "error" | "accent" | "accentMuted" | "textMuted"

export const redisTypeTone = (type: string): RedisTypeTone => {
  switch (type) {
    case "string":
      return "success"
    case "hash":
      return "info"
    case "list":
      return "warning"
    case "set":
      return "accent"
    case "zset":
      return "accentMuted"
    case "stream":
      return "error"
    case "ReJSON-RL":
    case "json":
      return "accent"
    default:
      return "textMuted"
  }
}

export const formatTtl = (seconds: number): string => {
  if (seconds === -1) return "no expiry"
  if (seconds < 0) return "—"
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

export const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return "—"
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export const redisLengthLabel = (info: RedisKeyInfo): string => {
  if (info.length === null) return "—"
  switch (info.type) {
    case "string":
      return `${info.length.toLocaleString()} bytes`
    case "hash":
      return `${info.length.toLocaleString()} fields`
    case "list":
      return `${info.length.toLocaleString()} items`
    case "set":
      return `${info.length.toLocaleString()} members`
    case "zset":
      return `${info.length.toLocaleString()} members`
    case "stream":
      return `${info.length.toLocaleString()} entries`
    default:
      return info.length.toLocaleString()
  }
}

export const redisKeyDetail = (info: RedisKeyInfo): string => {
  const parts = [
    redisTypeLabel(info.type),
    redisLengthLabel(info),
    formatBytes(info.size),
    `ttl ${formatTtl(info.ttl)}`,
  ]
  if (info.encoding) parts.push(info.encoding)
  return parts.join(" · ")
}
