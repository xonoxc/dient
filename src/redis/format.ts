/** Human-readable Redis metadata. Kept out of the inspector so the data layer
 * can return raw seconds/bytes and the UI decides how to phrase them. */
import type { RedisKeyInfo } from "@/redis/types"

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
  const parts = [info.type, redisLengthLabel(info), formatBytes(info.size), `ttl ${formatTtl(info.ttl)}`]
  if (info.encoding) parts.push(info.encoding)
  return parts.join(" · ")
}
