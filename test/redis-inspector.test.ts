/**
 * Redis inspector parsing and write-planning tests. The driver is faked: these
 * tests pin the mapping from raw Redis replies (including Bun's nested
 * `ZRANGE WITHSCORES` shape) to the pages the explorer draws, and the exact
 * command sequence each edit emits, without requiring a server.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ActiveConnection } from "@/drivers/types"
import type { RedisDriverService } from "@/drivers/redis"
import { makeRedisInspector, MAX_EDIT_BYTES } from "@/redis/redis-inspector"
import type { RedisKeyInfo } from "@/redis/types"

const conn = { id: "redis-test", engine: "redis" } as unknown as ActiveConnection

type Handler = (command: string, args: ReadonlyArray<string | number>) => unknown

const inspectorFor = (handler: Handler) => {
  const driver: RedisDriverService = {
    connect: () => Effect.die("connect is not used by these tests"),
    disconnect: () => Effect.void,
    isConnected: () => Effect.succeed(true),
    command: (_conn, command, args = []) =>
      Effect.try({
        try: () => handler(command, args),
        catch: cause => ({ _tag: "QueryError", message: String(cause) }) as never,
      }),
  }
  return makeRedisInspector(driver)
}

describe("RedisInspector", () => {
  test("SCAN pages keys and pairs each with its type and TTL", async () => {
    const inspector = inspectorFor((command, args) => {
      if (command === "SCAN") return ["7", ["greeting", "user:1"]]
      if (command === "DBSIZE") return 12
      if (command === "TYPE") return args[0] === "greeting" ? "string" : "hash"
      if (command === "TTL") return args[0] === "greeting" ? 60 : -1
      throw new Error(`unexpected ${command}`)
    })

    const page = await Effect.runPromise(inspector.listKeys(conn, { token: null, count: 50 }))
    expect(page.total).toBe(12)
    expect(page.nextToken).toBe("7")
    expect(page.rows).toEqual([
      { key: "greeting", type: "string", ttl: 60 },
      { key: "user:1", type: "hash", ttl: -1 },
    ])
  })

  test("a string page reads a bounded value and reports truncation", async () => {
    const inspector = inspectorFor((command, args) => {
      if (command === "TYPE") return "string"
      if (command === "TTL") return -1
      if (command === "MEMORY") return 70_000
      if (command === "OBJECT") return "raw"
      if (command === "STRLEN") return 70_000
      if (command === "GETRANGE") return "a".repeat(64_000)
      throw new Error(`unexpected ${command} ${args.join(" ")}`)
    })

    const page = await Effect.runPromise(inspector.loadValue(conn, "big", { token: null, count: 20 }))
    expect(page.info.type).toBe("string")
    expect(page.info.encoding).toBe("raw")
    expect(page.text?.length).toBe(64_000)
    expect(page.note).toContain("64,000")
    expect(page.columns.map(column => column.name)).toEqual(["value"])
  })

  test("a hash page flattens HSCAN reply pairs", async () => {
    const inspector = inspectorFor(command => {
      if (command === "TYPE") return "hash"
      if (command === "TTL") return -1
      if (command === "MEMORY") return 64
      if (command === "OBJECT") return "listpack"
      if (command === "HLEN") return 2
      if (command === "HSCAN") return ["0", ["name", "alice", "age", "30"]]
      throw new Error(`unexpected ${command}`)
    })

    const page = await Effect.runPromise(inspector.loadValue(conn, "user:1", { token: null, count: 20 }))
    expect(page.rows).toEqual([
      { field: "name", value: "alice" },
      { field: "age", value: "30" },
    ])
    expect(page.nextToken).toBeNull()
  })

  test("a sorted-set page understands Bun's [member, score] reply pairs", async () => {
    const inspector = inspectorFor(command => {
      if (command === "TYPE") return "zset"
      if (command === "TTL") return -1
      if (command === "MEMORY") return 64
      if (command === "OBJECT") return "listpack"
      if (command === "ZCARD") return 2
      if (command === "ZRANGE")
        return [
          ["bob", 50],
          ["alice", 100],
        ]
      throw new Error(`unexpected ${command}`)
    })

    const page = await Effect.runPromise(inspector.loadValue(conn, "board", { token: null, count: 20 }))
    expect(page.rows).toEqual([
      { rank: 1, score: "50", member: "bob" },
      { rank: 2, score: "100", member: "alice" },
    ])
    expect(page.nextToken).toBeNull()
  })

  test("a stream page parses entries and uses an exclusive ID token", async () => {
    const inspector = inspectorFor((command, args) => {
      if (command === "TYPE") return "stream"
      if (command === "TTL") return -1
      if (command === "MEMORY") return 100
      if (command === "OBJECT") return "stream"
      if (command === "XLEN") return 2
      if (command === "XRANGE") {
        expect(args[0]).toBe("events")
        expect(args[3]).toBe("COUNT")
        expect(args[4]).toBe("2") // one more than requested, to detect a next page
        return [
          ["1-0", ["type", "login"]],
          ["2-0", ["type", "logout"]],
        ]
      }
      throw new Error(`unexpected ${command}`)
    })

    const page = await Effect.runPromise(inspector.loadValue(conn, "events", { token: null, count: 1 }))
    expect(page.entries?.map(entry => entry.id)).toEqual(["1-0"])
    expect(page.nextToken).toBe("1-0")
    expect(page.rows[0]?.fields).toBe("type=login")
  })

  test("a RedisJSON page pretty-prints the document", async () => {
    const inspector = inspectorFor((command, args) => {
      if (command === "TYPE") return "ReJSON-RL"
      if (command === "TTL") return -1
      if (command === "MEMORY") return 20
      if (command === "OBJECT") return "raw"
      if (command === "JSON.GET") {
        /* RedisJSON commands are a single dotted command name, not a `JSON`
           command with a `GET` subcommand. */
        expect(args).toEqual(["doc"])
        return '{"user":"alice","active":true}'
      }
      throw new Error(`unexpected ${command}`)
    })

    const page = await Effect.runPromise(inspector.loadValue(conn, "doc", { token: null, count: 20 }))
    expect(page.text).toBe('{\n  "user": "alice",\n  "active": true\n}')
  })

  test("a missing key is a typed query error", async () => {
    const inspector = inspectorFor(command => {
      if (command === "TYPE") return "none"
      if (command === "TTL") return -2
      throw new Error(`unexpected ${command}`)
    })

    const exit = await Effect.runPromiseExit(inspector.loadValue(conn, "gone", { token: null, count: 20 }))
    expect(exit._tag).toBe("Failure")
  })

  test("reads the whole string for editing and refuses an over-limit value", async () => {
    const commands: Array<string> = []
    const inspector = inspectorFor(command => {
      commands.push(command)
      if (command === "GET") return "whole value\nwith lines"
      throw new Error(`unexpected ${command}`)
    })
    const info: RedisKeyInfo = {
      key: "greeting",
      type: "string",
      ttl: -1,
      size: 20,
      encoding: "raw",
      length: 20,
    }
    expect(await Effect.runPromise(inspector.readValueText(conn, info))).toBe("whole value\nwith lines")
    expect(commands).toEqual(["GET"])

    const tooBig = { ...info, length: MAX_EDIT_BYTES + 1 }
    const exit = await Effect.runPromiseExit(inspector.readValueText(conn, tooBig))
    expect(exit._tag).toBe("Failure")
  })

  test("reads JSON verbatim so large integers survive an edit round trip", async () => {
    const inspector = inspectorFor(command => {
      if (command === "JSON.GET") return '{"id":9007199254740993}'
      throw new Error(`unexpected ${command}`)
    })
    const info: RedisKeyInfo = {
      key: "doc",
      type: "ReJSON-RL",
      ttl: -1,
      size: null,
      encoding: null,
      length: null,
    }
    expect(await Effect.runPromise(inspector.readValueText(conn, info))).toBe('{"id":9007199254740993}')
  })

  test("string writes preserve TTL and JSON writes validate first", async () => {
    const commands: Array<readonly [string, ReadonlyArray<string | number>]> = []
    const inspector = inspectorFor((command, args) => {
      commands.push([command, args])
      return 1
    })
    const stringInfo: RedisKeyInfo = {
      key: "greeting",
      type: "string",
      ttl: 60,
      size: 5,
      encoding: "raw",
      length: 5,
    }
    const jsonInfo: RedisKeyInfo = { ...stringInfo, key: "doc", type: "ReJSON-RL" }

    await Effect.runPromise(inspector.updateText(conn, stringInfo, "hello"))
    expect(commands).toEqual([["SET", ["greeting", "hello", "KEEPTTL"]]])

    commands.length = 0
    await Effect.runPromise(inspector.updateText(conn, jsonInfo, '{"user":"alice"}'))
    expect(commands[0]).toEqual(["JSON.SET", ["doc", "$", '{"user":"alice"}']])

    const exit = await Effect.runPromiseExit(inspector.updateText(conn, jsonInfo, "{"))
    expect(exit._tag).toBe("Failure")
    expect(commands).toHaveLength(1)
  })

  test("collection updates rename/remove the identifying field before writing", async () => {
    const commands: Array<readonly [string, ReadonlyArray<string | number>]> = []
    const inspector = inspectorFor((command, args) => {
      commands.push([command, args])
      return 1
    })
    const base = {
      ttl: -1,
      size: 1,
      encoding: "listpack",
      length: 1,
    } as const

    await Effect.runPromise(
      inspector.updateRow(conn, { ...base, key: "user:1", type: "hash" }, { field: "name", value: "alice" }, [
        { column: "field", param: "display_name" },
      ])
    )
    expect(commands).toEqual([
      ["HDEL", ["user:1", "name"]],
      ["HSET", ["user:1", "display_name", "alice"]],
    ])

    commands.length = 0
    await Effect.runPromise(
      inspector.updateRow(conn, { ...base, key: "jobs", type: "list" }, { index: 0, value: "one" }, [
        { column: "value", param: "uno" },
      ])
    )
    expect(commands).toEqual([["LSET", ["jobs", 0, "uno"]]])

    commands.length = 0
    await Effect.runPromise(
      inspector.updateRow(conn, { ...base, key: "tags", type: "set" }, { member: "red" }, [
        { column: "member", param: "crimson" },
      ])
    )
    expect(commands).toEqual([
      ["SREM", ["tags", "red"]],
      ["SADD", ["tags", "crimson"]],
    ])

    commands.length = 0
    await Effect.runPromise(
      inspector.updateRow(conn, { ...base, key: "board", type: "zset" }, { rank: 1, score: "10", member: "alice" }, [
        { column: "score", param: "25" },
      ])
    )
    expect(commands).toEqual([["ZADD", ["board", "25", "alice"]]])
  })

  test("rename uses RENAMENX and reports a collision", async () => {
    const commands: Array<string> = []
    const inspector = inspectorFor((command, args) => {
      commands.push(`${command} ${args.join(" ")}`)
      return 1
    })
    await Effect.runPromise(inspector.renameKey(conn, "old", "new"))
    expect(commands).toEqual(["RENAMENX old new"])

    const collision = inspectorFor(() => 0)
    const exit = await Effect.runPromiseExit(collision.renameKey(conn, "old", "taken"))
    expect(exit._tag).toBe("Failure")
  })
})
