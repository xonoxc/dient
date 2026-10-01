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
      /* Hints get a third of the strip and are taken whole from the front, so
         the leading settings bindings are what the bar actually shows. */
      expect(lastTextRow(frame)).toContain("a db")
      expect(lastTextRow(frame)).toContain("p paste URI")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the status bar fits the real terminal width, not a fixed 80", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "sample",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    /* On a wide terminal the bar used to chop its own text ("sample · sqli",
       "V sele") against an 80-column budget while a void sat between the two
       halves — the overflow the fixed cap caused. */
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />, {
      width: 160,
      height: 26,
    })
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("sample"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
      /* `l` moves focus to the grid, which is the hint list that used to be
         cut mid-word. */
      await pressKeys(setup, ["l"])

      const row = lastTextRow(setup.captureSpans())
      /* The location reads whole, and hints are taken whole or not at all. */
      expect(row).toContain("sample · sqlite")
      expect(row).toContain("V select rows")
      expect(row).toContain("users 3 rows")
      /* The fetch time is the right-end counterpart to the mode badge. */
      expect(row).toMatch(/<1ms|\d+(\.\d+)?ms|\d+(\.\d+)?s $/)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a bare sidebar still shows the fetch time from connecting", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "sample",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    /* Connecting is itself a round trip, so the badge must not be reserved for
       the page load — it read as a missing feature on the sidebar. */
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />, {
      width: 120,
      height: 26,
    })
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("▸ users"))

      expect(lastTextRow(setup.captureSpans())).toMatch(/<1ms|\d+(\.\d+)?ms|\d+(\.\d+)?s $/)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the bar keeps one column of padding at both edges", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "sample",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    /* The page supplies `paddingX={1}` and the badge carries its own padding;
       double-counting the left side pushed the right-hand zones past the edge
       and clipped the trailing gap. */
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />, {
      width: 120,
      height: 26,
    })
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("sample"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("USERS"))
      await pressKeys(setup, ["l"])

      const row = lastTextRow(setup.captureSpans())
      /* Symmetric outer columns: the row opens with the page's padding plus the
         badge's own, and leaves room at the right rather than running flush. */
      expect(row.startsWith("  NORMAL ")).toBe(true)
      expect(row.length).toBeLessThanOrEqual(120)
      expect(row.endsWith(" ")).toBe(true)
      expect(row.trimEnd().length).toBeLessThan(120)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the fetch-time badge is dropped before the row figure, never the reverse", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "sample",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    /* A narrow strip has to give something up. The row figure is what the user
       came for; hints are shed whole, and the location ellipsizes. */
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />, {
      width: 60,
      height: 26,
    })
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("NORMAL"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("USERS"))
      await pressKeys(setup, ["l"])

      const row = lastTextRow(setup.captureSpans())
      expect(row.length).toBeLessThanOrEqual(60)
      expect(row).toContain("users 3 rows")
      /* Hints appear whole or not at all — the old bar printed "V sele". */
      expect(row).toContain("s settings")
      expect(row).not.toMatch(/s set(?!tings)/)
      expect(row).not.toContain("V sele")
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
      expect(setup.captureCharFrame()).toContain("Projects and database connections")

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
