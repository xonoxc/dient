/**
 * Redis explorer tests. Uses a real Redis container to prove the UI path:
 * connect from the sidebar, land in the KEYS table, drill into a key, see the
 * type-aware view, and Escape back to the keyspace. Editing runs through real
 * `$EDITOR` substitutes: a key rename in the keyspace, a string value, and a
 * hash row with a field rename.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GenericContainer, type StartedTestContainer } from "testcontainers"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp, waitForFrameDriven } from "@test/support/render-ui"
import { freshConfigFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

let container: StartedTestContainer | undefined

const TMP_ROOT = mkdtempSync(join(tmpdir(), "dient-redis-edit-test-"))
const installEditor = (name: string, body: string): string => {
  const file = join(TMP_ROOT, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

let previousEditor: string | undefined
let previousValue: string | undefined
const setEditor = (program: string, value: string): void => {
  previousEditor = process.env.EDITOR
  previousValue = process.env.DIENT_EDIT_VALUE
  process.env.EDITOR = program
  process.env.DIENT_EDIT_VALUE = value
}

afterEach(() => {
  if (previousEditor === undefined) delete process.env.EDITOR
  else process.env.EDITOR = previousEditor
  if (previousValue === undefined) delete process.env.DIENT_EDIT_VALUE
  else process.env.DIENT_EDIT_VALUE = previousValue
})

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

  test("renames a key and edits a string through $EDITOR", async () => {
    const client = new Bun.RedisClient(`redis://${container!.getHost()}:${container!.getMappedPort(6379)}/0`)
    await client.connect()
    await client.send("FLUSHALL", [])
    await client.send("SET", ["greeting", "hello redis"])
    client.close()

    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "redis-edit",
      database: "cache",
      engine: "redis",
      host: container!.getHost(),
      port: container!.getMappedPort(6379),
      defaultDatabase: "0",
    })
    setEditor(installEditor("write.sh", `printf '%s\\n' "$DIENT_EDIT_VALUE" > "$1"`), "welcome")

    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ redis-edit") && f.includes("○ cache"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("KEYS") && f.includes("greeting"))

      await pressKeys(setup, ["2"])
      await pressKeys(setup, ["i"])
      await waitForFrameDriven(setup, f => f.includes("renamed") && f.includes("welcome"))

      const renamed = new Bun.RedisClient(`redis://${container!.getHost()}:${container!.getMappedPort(6379)}/0`)
      await renamed.connect()
      expect(await renamed.send("GET", ["greeting"])).toBeNull()
      expect(await renamed.send("GET", ["welcome"])).toBe("hello redis")
      renamed.close()

      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("hello redis") && f.includes("welcome"))

      process.env.DIENT_EDIT_VALUE = "edited value"
      await pressKeys(setup, ["i"])
      await waitForFrameDriven(setup, f => f.includes("saved welcome") && f.includes("edited value"))

      const edited = new Bun.RedisClient(`redis://${container!.getHost()}:${container!.getMappedPort(6379)}/0`)
      await edited.connect()
      expect(await edited.send("GET", ["welcome"])).toBe("edited value")
      edited.close()
    } finally {
      setup.renderer.destroy()
    }
  }, 30_000)

  test("edits a hash field through the row editor", async () => {
    const client = new Bun.RedisClient(`redis://${container!.getHost()}:${container!.getMappedPort(6379)}/0`)
    await client.connect()
    await client.send("FLUSHALL", [])
    await client.send("HSET", ["user:1", "name", "alice"])
    client.close()

    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "redis-hash-edit",
      database: "cache",
      engine: "redis",
      host: container!.getHost(),
      port: container!.getMappedPort(6379),
      defaultDatabase: "0",
    })
    setEditor(installEditor("hash.sh", `cat > "$1" <<'DIENTEOF'\nfield: display_name\nvalue: Alice\nDIENTEOF`), "")

    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ redis-hash-edit") && f.includes("○ cache"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("KEYS") && f.includes("user:1"))

      await pressKeys(setup, ["2"])
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("name") && f.includes("alice"))
      await pressKeys(setup, ["i"])
      await waitForFrameDriven(
        setup,
        f => f.includes("display_name") && f.includes("Alice") && f.includes("saved user:1")
      )

      const edited = new Bun.RedisClient(`redis://${container!.getHost()}:${container!.getMappedPort(6379)}/0`)
      await edited.connect()
      expect(await edited.send("HGET", ["user:1", "display_name"])).toBe("Alice")
      expect(await edited.send("HGET", ["user:1", "name"])).toBeNull()
      edited.close()
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
