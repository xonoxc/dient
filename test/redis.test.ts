/**
 * End-to-end Redis coverage: a real Redis container through the app's real
 * config store, ConnectionManager, RedisDriver, and RedisInspector. This is
 * where Bun's actual reply shapes (notably ZRANGE WITHSCORES and XRANGE) meet
 * the code that maps them into explorer pages, and where the write commands
 * (SET KEEPTTL, HDEL/HSET, LSET, SREM/SADD, ZADD/ZREM, RENAMENX) run against a
 * real server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GenericContainer, type StartedTestContainer } from "testcontainers"
import { freshConfigFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

let container: StartedTestContainer | undefined

beforeAll(async () => {
  container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start()
}, 120_000)

afterAll(async () => {
  await container?.stop()
}, 120_000)

const redisHost = () => container!.getHost()
const redisPort = () => container!.getMappedPort(6379)

describe("Redis connection", () => {
  test("manager, driver, and inspector browse every core type", async () => {
    const client = new Bun.RedisClient(`redis://${redisHost()}:${redisPort()}/0`)
    await client.connect()
    await client.send("FLUSHALL", [])
    await client.send("SET", ["greeting", "hello redis"])
    await client.send("HSET", ["user:1", "name", "alice", "age", "30"])
    await client.send("RPUSH", ["jobs", "one", "two"])
    await client.send("SADD", ["tags", "red", "blue"])
    await client.send("ZADD", ["leaderboard", "50", "bob", "100", "alice"])
    await client.send("XADD", ["events", "*", "type", "login", "user", "alice"])
    await client.send("XADD", ["events", "*", "type", "logout", "user", "alice"])
    client.close()

    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "redis-demo",
      database: "cache",
      engine: "redis",
      host: redisHost(),
      port: redisPort(),
      defaultDatabase: "0",
    })

    const conn = await Effect.runPromise(services.services.connectionManager.connect(seeded.connection.id))
    try {
      const keys = await Effect.runPromise(services.services.redisInspector.listKeys(conn, { token: null, count: 200 }))
      expect(keys.total).toBe(6)
      expect(new Set(keys.rows.map(row => row.key))).toEqual(
        new Set(["greeting", "user:1", "jobs", "tags", "leaderboard", "events"])
      )
      const types = Object.fromEntries(keys.rows.map(row => [row.key, row.type]))
      expect(types).toEqual({
        greeting: "string",
        "user:1": "hash",
        jobs: "list",
        tags: "set",
        leaderboard: "zset",
        events: "stream",
      })

      const string = await Effect.runPromise(
        services.services.redisInspector.loadValue(conn, "greeting", { token: null, count: 200 })
      )
      expect(string.text).toBe("hello redis")

      const hash = await Effect.runPromise(
        services.services.redisInspector.loadValue(conn, "user:1", { token: null, count: 200 })
      )
      expect(hash.rows).toEqual([
        { field: "name", value: "alice" },
        { field: "age", value: "30" },
      ])

      const list = await Effect.runPromise(
        services.services.redisInspector.loadValue(conn, "jobs", { token: null, count: 200 })
      )
      expect(list.rows).toEqual([
        { index: 0, value: "one" },
        { index: 1, value: "two" },
      ])
      expect(list.nextToken).toBeNull()

      const set = await Effect.runPromise(
        services.services.redisInspector.loadValue(conn, "tags", { token: null, count: 200 })
      )
      expect(new Set(set.rows.map(row => row.member))).toEqual(new Set(["red", "blue"]))
      expect(set.nextToken).toBeNull()

      const zset = await Effect.runPromise(
        services.services.redisInspector.loadValue(conn, "leaderboard", { token: null, count: 200 })
      )
      expect(zset.rows).toEqual([
        { rank: 1, score: "50", member: "bob" },
        { rank: 2, score: "100", member: "alice" },
      ])
      expect(zset.nextToken).toBeNull()

      const stream = await Effect.runPromise(
        services.services.redisInspector.loadValue(conn, "events", { token: null, count: 200 })
      )
      expect(stream.entries?.map(entry => entry.fields[0]?.[1])).toEqual(["login", "logout"])
      expect(stream.nextToken).toBeNull()

      const query = await Effect.runPromiseExit(
        services.services.connectionManager.query(seeded.connection.id, "SELECT 1")
      )
      expect(query._tag).toBe("Failure")
    } finally {
      await Effect.runPromise(services.services.connectionManager.disconnect(seeded.connection.id))
    }

    const connected = await Effect.runPromise(services.services.connectionManager.isConnected(seeded.connection.id))
    expect(connected).toBe(false)
  }, 30_000)

  test("edits strings, collection rows, and key names without losing TTL", async () => {
    const client = new Bun.RedisClient(`redis://${redisHost()}:${redisPort()}/0`)
    await client.connect()
    await client.send("FLUSHALL", [])
    await client.send("SET", ["greeting", "hello redis", "EX", "60"])
    await client.send("HSET", ["user:1", "name", "alice"])
    await client.send("RPUSH", ["jobs", "one"])
    await client.send("SADD", ["tags", "red"])
    await client.send("ZADD", ["board", "10", "alice"])

    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "redis-edit",
      database: "cache",
      engine: "redis",
      host: redisHost(),
      port: redisPort(),
      defaultDatabase: "0",
    })
    const conn = await Effect.runPromise(services.services.connectionManager.connect(seeded.connection.id))
    try {
      const inspector = services.services.redisInspector

      const greeting = await Effect.runPromise(inspector.describeKey(conn, "greeting"))
      expect(await Effect.runPromise(inspector.readValueText(conn, greeting))).toBe("hello redis")
      await Effect.runPromise(inspector.updateText(conn, greeting, "edited value"))
      await Effect.runPromise(inspector.renameKey(conn, "greeting", "welcome"))

      const welcome = await Effect.runPromise(inspector.describeKey(conn, "welcome"))
      expect(welcome.type).toBe("string")
      expect(welcome.ttl).toBeGreaterThan(0)
      const string = await Effect.runPromise(inspector.loadValue(conn, "welcome", { token: null, count: 200 }))
      expect(string.text).toBe("edited value")

      const hashInfo = await Effect.runPromise(inspector.describeKey(conn, "user:1"))
      await Effect.runPromise(
        inspector.updateRow(conn, hashInfo, { field: "name", value: "alice" }, [
          { column: "field", param: "display_name" },
          { column: "value", param: "Alice" },
        ])
      )
      const hash = await Effect.runPromise(inspector.loadValue(conn, "user:1", { token: null, count: 200 }))
      expect(hash.rows).toEqual([{ field: "display_name", value: "Alice" }])

      const listInfo = await Effect.runPromise(inspector.describeKey(conn, "jobs"))
      await Effect.runPromise(
        inspector.updateRow(conn, listInfo, { index: 0, value: "one" }, [{ column: "value", param: "uno" }])
      )
      const list = await Effect.runPromise(inspector.loadValue(conn, "jobs", { token: null, count: 200 }))
      expect(list.rows).toEqual([{ index: 0, value: "uno" }])

      const setInfo = await Effect.runPromise(inspector.describeKey(conn, "tags"))
      await Effect.runPromise(
        inspector.updateRow(conn, setInfo, { member: "red" }, [{ column: "member", param: "crimson" }])
      )
      const set = await Effect.runPromise(inspector.loadValue(conn, "tags", { token: null, count: 200 }))
      expect(set.rows).toEqual([{ member: "crimson" }])

      const zsetInfo = await Effect.runPromise(inspector.describeKey(conn, "board"))
      await Effect.runPromise(
        inspector.updateRow(conn, zsetInfo, { rank: 1, score: "10", member: "alice" }, [
          { column: "score", param: "99" },
          { column: "member", param: "bob" },
        ])
      )
      const zset = await Effect.runPromise(inspector.loadValue(conn, "board", { token: null, count: 200 }))
      expect(zset.rows).toEqual([{ rank: 1, score: "99", member: "bob" }])

      const renamed = await Effect.runPromiseExit(inspector.loadValue(conn, "greeting", { token: null, count: 200 }))
      expect(renamed._tag).toBe("Failure")
    } finally {
      client.close()
      await Effect.runPromise(services.services.connectionManager.disconnect(seeded.connection.id))
    }
  }, 30_000)
})
