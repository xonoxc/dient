import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { formatRedisReply, parseRedisCommand } from "@/redis/command"

describe("parseRedisCommand", () => {
  test("splits a command and uppercases the command name", () => {
    const parsed = parseRedisCommand("get greeting")
    expect(Result.isSuccess(parsed)).toBe(true)
    if (Result.isSuccess(parsed)) {
      expect(parsed.success).toEqual({ name: "GET", args: ["greeting"], display: "get greeting" })
    }
  })

  test("keeps quoted spaces and JSON as one argument", () => {
    const parsed = parseRedisCommand(`SET greeting "hello world" '{"user":"alice"}'`)
    expect(Result.isSuccess(parsed)).toBe(true)
    if (Result.isSuccess(parsed)) {
      expect(parsed.success.args).toEqual(["greeting", "hello world", '{"user":"alice"}'])
    }
  })

  test("supports escaped quotes and backslashes", () => {
    const parsed = parseRedisCommand(`SET greeting "hello \\"world\\" \\\\ ok"`)
    expect(Result.isSuccess(parsed)).toBe(true)
    if (Result.isSuccess(parsed)) {
      expect(parsed.success.args).toEqual(["greeting", 'hello "world" \\ ok'])
    }
  })

  test("rejects empty and unterminated input", () => {
    for (const input of ["", "   ", `SET "unfinished`, "SET trailing\\"]) {
      expect(Result.isFailure(parseRedisCommand(input))).toBe(true)
    }
  })
})

describe("formatRedisReply", () => {
  test("renders nil, empty strings, scalars, and nested replies", () => {
    expect(formatRedisReply(null)).toBe("(nil)")
    expect(formatRedisReply("")).toBe("(empty string)")
    expect(formatRedisReply(7)).toBe("7")
    expect(formatRedisReply(["name", "alice"])).toBe('[\n  "name",\n  "alice"\n]')
  })
})
