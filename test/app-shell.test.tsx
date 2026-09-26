import { describe, expect, test } from "bun:test"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

const ESC = "ESCAPE"

interface FrameLine {
  readonly text: string
}
interface FrameSpanRow {
  readonly spans: ReadonlyArray<FrameLine>
}
interface CaptureSpans {
  readonly lines: ReadonlyArray<FrameSpanRow>
}

/** Last row that actually renders text (padding rows are whitespace-only spans). */
const lastTextRow = (frame: CaptureSpans): string =>
  frame.lines.map(line => line.spans.map(span => span.text).join("")).findLast(line => line.trim().length > 0) ?? ""

describe("App shell", () => {
  test("renders the status bar pinned to the bottom with NORMAL mode", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      const frame = setup.captureSpans()
      const rowText = lastTextRow(frame)
      expect(rowText).toContain("NORMAL")
      expect(rowText).toContain("dient") /* status bar carries the app brand */
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the status bar reflects the active screen's hints", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [":", ..."settings", "RETURN"])
      await setup.waitForFrame(f => f.includes("SETTINGS"))

      const frame = setup.captureSpans()
      /* The hint budget is 30 chars, so the leading settings bindings are
         what the bar actually shows. */
      expect(lastTextRow(frame)).toContain("a db")
      expect(lastTextRow(frame)).toContain("p project")
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("screen router", () => {
  test(":settings swaps the active screen, :explorer returns", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      expect(setup.captureCharFrame()).toContain("select a connection in the sidebar to start browsing")

      await pressKeys(setup, [":", ..."settings", "RETURN"])
      await setup.waitForFrame(f => f.includes("SETTINGS"))
      expect(setup.captureCharFrame()).toContain("SETTINGS")
      expect(setup.captureCharFrame()).toContain("projects / databases")

      await pressKeys(setup, [":", ..."explorer", "RETURN"])
      await setup.waitForFrame(f => f.includes("select a connection"))
      expect(setup.captureCharFrame()).toContain("select a connection in the sidebar to start browsing")
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("keyboard dispatch", () => {
  test("keys reach the settings form once it is the active screen", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [":", ..."settings", "RETURN"])
      await setup.waitForFrame(f => f.includes("SETTINGS"))

      /* `a` is only meaningful to the settings screen, proving dispatch targets it. */
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("new project:"))
      expect(setup.captureCharFrame()).toContain("new project:")

      await pressKeys(setup, [ESC])
      await setup.waitForFrame(f => !f.includes("new project:"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the help overlay toggles without crashing", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["?"])
      await setup.waitForFrame(f => f.includes("keybindings"))
      expect(setup.captureCharFrame()).toContain(":settings")
      await pressKeys(setup, [ESC])
      await setup.waitForFrame(f => !f.includes("keybindings"))
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("explorer flow", () => {
  test("browses a seeded sqlite table end to end", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* demo is pre-selected; expand it and connect the database */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("main"))
      await pressKeys(setup, ["j"])

      /* Enter on the connection: connect → list tables → load the first table */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
      expect(setup.captureCharFrame()).toContain("alice")

      const frame = setup.captureSpans()
      expect(lastTextRow(frame)).toContain("3 rows")
    } finally {
      setup.renderer.destroy()
    }
  })
})
