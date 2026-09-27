/**
 * The thin horizontal scroll indicator under the data table.
 *
 * The bar is drawn from the scrollbox's own geometry, so these cover both the
 * arithmetic (pure) and what actually reaches the screen.
 */
import { describe, expect, test } from "bun:test"
import App from "@/app"
import { makeTheme } from "@/theme"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, resolveTestServices, seedProject } from "@test/support/services-fixture"
import { thumbGeometry } from "@/table/horizontal-scroll-indicator"

const RULE = "─"
const BLOCK = "█"

/** The indicator polls the scrollbox, so give it a tick to draw. */
const settle = () => new Promise(resolve => setTimeout(resolve, 250))

describe("thumbGeometry", () => {
  test("a table that fits gets no bar at all", () => {
    expect(thumbGeometry({ content: 40, viewport: 60, left: 0 })).toBeNull()
    expect(thumbGeometry({ content: 60, viewport: 60, left: 0 })).toBeNull()
  })

  test("a degenerate viewport is not a crash", () => {
    expect(thumbGeometry({ content: 100, viewport: 0, left: 0 })).toBeNull()
    expect(thumbGeometry({ content: 0, viewport: 0, left: 0 })).toBeNull()
  })

  test("the thumb is the on-screen fraction of the content", () => {
    /* Half the content visible: a thumb half the track, pinned to the start. */
    expect(thumbGeometry({ content: 120, viewport: 60, left: 0 })).toEqual({ offset: 0, width: 30 })
    /* Scrolled to the end: same size, at the end of the travel. */
    expect(thumbGeometry({ content: 120, viewport: 60, left: 60 })).toEqual({ offset: 30, width: 30 })
  })

  test("the thumb stays at least one cell wide", () => {
    const result = thumbGeometry({ content: 100_000, viewport: 40, left: 0 })
    expect(result?.width).toBe(1)
  })

  test("offset stays inside the track at both extremes", () => {
    for (const content of [61, 100, 999, 123_456]) {
      for (const viewport of [10, 40, 80]) {
        /* Only overflowing pairs have a bar at all. */
        if (content <= viewport) {
          expect(thumbGeometry({ content, viewport, left: 0 })).toBeNull()
          continue
        }
        const atStart = thumbGeometry({ content, viewport, left: 0 })
        const atEnd = thumbGeometry({ content, viewport, left: content - viewport })
        expect(atStart?.offset).toBe(0)
        expect((atEnd?.offset ?? 0) + (atEnd?.width ?? 0)).toBeLessThanOrEqual(viewport)
      }
    }
  })
})

/** A table wide enough that the columns cannot fit the pane. */
function wideOrdersFile(): string {
  const columns = Array.from({ length: 8 }, (_, i) => `column_number_${i}_with_a_long_name TEXT`)
  const path = join(mkdtempSync(join(tmpdir(), "dient-scroll-")), "wide.db")
  const db = new SqliteDatabase(path)
  db.run(`CREATE TABLE orders (id INTEGER PRIMARY KEY, ${columns.join(", ")})`)
  db.run(
    `INSERT INTO orders (id, ${columns.map(c => c.split(" ")[0]!).join(", ")}) VALUES (1, ${columns
      .map((_, i) => `'value number ${i}'`)
      .join(", ")})`
  )
  db.close()
  return path
}

function narrowOrdersFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "dient-scroll-")), "narrow.db")
  const db = new SqliteDatabase(path)
  db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT)")
  db.run("INSERT INTO orders (id, name) VALUES (1, 'iphone')")
  db.close()
  return path
}

async function openTable(filename: string) {
  const services = await resolveTestServices(freshConfigFile())
  await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename })
  const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("ORDERS"))
  await settle()
  return setup
}

describe("horizontal scroll indicator", () => {
  /* The bar used to be OpenTUI's own slider: a solid `█` thumb on a filled
     track, occupying a full row directly above the status bar. Two problems —
     it looked like a second status bar, and it appeared even for a table with
     nothing to scroll. */
  test("a table that fits shows no bar and keeps the row", async () => {
    const setup = await openTable(narrowOrdersFile())
    try {
      const rows = setup.captureCharFrame().split("\n")
      expect(rows.join("\n")).not.toContain(BLOCK)
      expect(rows.join("\n")).not.toContain(RULE)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a table that overflows shows a thin rule, not a block bar", async () => {
    const setup = await openTable(wideOrdersFile())
    try {
      const rows = setup.captureCharFrame().split("\n")
      const row = rows.find(line => line.includes(RULE))

      /* Drawn at all, and as a rule. */
      expect(row).toBeDefined()
      /* The old bar's fingerprint is gone. */
      expect(rows.join("\n")).not.toContain(BLOCK)
      /* One row, and it is only as wide as the thumb — not the full pane. */
      expect(row?.includes(RULE)).toBe(true)
      const rule = row?.match(new RegExp(`${RULE}+`))?.[0] ?? ""
      expect(rule.length).toBeGreaterThan(0)
      expect(rule.length).toBeLessThan(55)
    } finally {
      setup.renderer.destroy()
    }
  })
})
