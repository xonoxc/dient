/**
 * Redis explorer smoke test. Uses a real Redis container to prove the UI path:
 * connect from the sidebar, land in the KEYS table, drill into a string key,
 * see the wrapped value panel, and Escape back to the keyspace.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GenericContainer, type StartedTestContainer } from "testcontainers"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

let container: StartedTestContainer | undefined

beforeAll(async () => {
  container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start()
}, 120_000)

afterAll(async () => {
  await container?.stop()
}, 120_000)

describe("redis explorer", () => {
  test("opens the keyspace, drills into a string, and Esc returns", async () => {
    const client = new Bun.RedisClient(`redis://${container!.getHost()}:${container!.getMappedPort(6379)}/0`)
    await client.connect()
    await client.send("FLUSHALL", [])
    await client.send("SET", ["greeting", "hello redis"])
    client.close()

    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "redis-demo",
      database: "cache",
      engine: "redis",
      host: container!.getHost(),
      port: container!.getMappedPort(6379),
      defaultDatabase: "0",
    })

    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ redis-demo") && f.includes("○ cache"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("KEYS") && f.includes("greeting"))

      /* Key types are a colored symbol + name, not a background block. */
      const typeBadge = setup
        .captureSpans()
        .lines.flatMap(line => line.spans)
        .find(span => span.text === '" string')
      expect(typeBadge?.fg.toInts()).toEqual(makeTheme("dark").colors.success.toInts())

      await pressKeys(setup, ["2"])
      await pressKeys(setup, ["RETURN"])
      const keyFrame = await setup.waitForFrame(f => f.includes("hello redis") && f.includes("greeting"))
      expect(keyFrame).toContain("string")
      expect(keyFrame).toContain("j/k scroll")

      await pressKeys(setup, ["ESCAPE"])
      const keysFrame = await setup.waitForFrame(f => f.includes("KEYS") && f.includes("greeting"))
      expect(keysFrame).not.toContain("hello redis")
    } finally {
      setup.renderer.destroy()
    }
  }, 30_000)

  test("renders a stream as timestamped entry cards", async () => {
    const client = new Bun.RedisClient(`redis://${container!.getHost()}:${container!.getMappedPort(6379)}/0`)
    await client.connect()
    await client.send("FLUSHALL", [])
    await client.send("XADD", ["events", "*", "type", "login", "user", "alice"])
    await client.send("XADD", ["events", "*", "type", "logout", "user", "alice"])
    client.close()

    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "redis-stream",
      database: "cache",
      engine: "redis",
      host: container!.getHost(),
      port: container!.getMappedPort(6379),
      defaultDatabase: "0",
    })

    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ redis-stream") && f.includes("○ cache"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("KEYS") && f.includes("events"))

      await pressKeys(setup, ["2"])
      await pressKeys(setup, ["RETURN"])
      const frame = await setup.waitForFrame(f => f.includes("events") && f.includes("login") && f.includes("logout"))
      expect(frame).toContain("stream")
      expect(frame).toContain("type")
      expect(frame).toContain("alice")
    } finally {
      setup.renderer.destroy()
    }
  }, 30_000)
})
