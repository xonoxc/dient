import { describe, expect, test } from "bun:test"
import { parseRedisRow, redisRowShape, serializeRedisRow } from "@/redis/editing"

describe("Redis row editing", () => {
  test("round-trips hash fields, including newlines and backslashes", () => {
    const shape = redisRowShape("hash")!
    const row = { field: "notes", value: "line one\nline\\two: value" }
    const text = serializeRedisRow(shape.columns, row)
    expect(text).toContain("value: line one\\nline\\\\two: value")

    const parsed = parseRedisRow(
      text.replace("line one\\nline\\\\two: value", "line one\\nline\\\\two: changed"),
      shape.columns,
      shape.primaryKey,
      row
    )
    expect(parsed).toEqual({ ok: true, updates: [{ column: "value", param: "line one\nline\\two: changed" }] })
  })

  test("renames a hash field and edits its value in one parse", () => {
    const shape = redisRowShape("hash")!
    const row = { field: "name", value: "alice" }
    const text = serializeRedisRow(shape.columns, row)
      .replace("field: name", "field: display_name")
      .replace("value: alice", "value: Alice")
    expect(parseRedisRow(text, shape.columns, shape.primaryKey, row)).toEqual({
      ok: true,
      updates: [
        { column: "field", param: "display_name" },
        { column: "value", param: "Alice" },
      ],
    })
  })

  test("distinguishes an empty value from literal quote characters", () => {
    const shape = redisRowShape("set")!
    const empty = { member: "" }
    const quotes = { member: '""' }
    expect(serializeRedisRow(shape.columns, empty)).toContain('member: ""')
    expect(serializeRedisRow(shape.columns, quotes)).toContain('member: \\"\\"')
    expect(parseRedisRow(serializeRedisRow(shape.columns, empty), shape.columns, shape.primaryKey, empty)).toEqual({
      ok: true,
      updates: [],
    })
    expect(parseRedisRow(serializeRedisRow(shape.columns, quotes), shape.columns, shape.primaryKey, quotes)).toEqual({
      ok: true,
      updates: [],
    })
  })

  test("supports empty strings without treating them as missing values", () => {
    const shape = redisRowShape("set")!
    const row = { member: "old" }
    const text = serializeRedisRow(shape.columns, row).replace("member: old", 'member: ""')
    expect(parseRedisRow(text, shape.columns, shape.primaryKey, row)).toEqual({
      ok: true,
      updates: [{ column: "member", param: "" }],
    })
  })

  test("refuses to change a fixed list index", () => {
    const shape = redisRowShape("list")!
    const row = { index: 0, value: "one" }
    const text = serializeRedisRow(shape.columns, row).replace("index: 0", "index: 1")
    const parsed = parseRedisRow(text, shape.columns, shape.primaryKey, row)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain("cannot be changed")
  })

  test("validates sorted-set scores before returning updates", () => {
    const shape = redisRowShape("zset")!
    const row = { rank: 1, score: "10", member: "alice" }
    const text = serializeRedisRow(shape.columns, row).replace("score: 10", "score: high")
    const parsed = parseRedisRow(text, shape.columns, shape.primaryKey, row)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain("expects a number")
  })
})
