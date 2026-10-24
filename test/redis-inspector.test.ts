/**
 * Redis inspector parsing tests. The driver is faked: these tests pin the
 * mapping from raw Redis replies (including Bun's nested `ZRANGE WITHSCORES`
 * shape) to the pages the explorer draws, without requiring a server.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ActiveConnection } from "@/drivers/types"
import type { RedisDriverService } from "@/drivers/redis"
import { makeRedisInspector } from "@/redis/redis-inspector"

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
})
