/**
 * Data table screen tests — the table area as rendered by the real App against
 * a seeded SQLite file. Driving the table needs the `2` focus switch after
 * connecting, since Enter on a connection leaves focus on the sidebar. Each
 * tree step is an async DB round-trip, so the presses are staged like human
 * input.
 */
import { describe, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

/** Drill down to the seeded users table, then move focus to the table panel. */
async function openTable(setup: Awaited<ReturnType<typeof renderApp>>, waitLine: string) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes(waitLine))
  await pressKeys(setup, ["2"])
  return setup.captureCharFrame()
}

const bigRows: ReadonlyArray<Record<string, unknown>> = Array.from({ length: 1500 }, (_, i) => ({
  id: i + 1,
  name: `user_${i}`,
  email: `user_${i}@example.com`,
}))

/** A data file whose table is far wider than the table pane. */
const wideDataFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "dient-wide-")), "data.db")
  const db = new SqliteDatabase(path)
  db.run(
    `CREATE TABLE invoices (
       id INTEGER PRIMARY KEY,
       customer_name TEXT,
       billing_email TEXT,
       last_order_date TEXT,
       total_due REAL
     )`
  )
  db.run(
    `INSERT INTO invoices (id, customer_name, billing_email, last_order_date, total_due)
     VALUES (1, 'Acme Consolidation Group Ltd', 'billing@acme-consolidated.example', '2026-09-20 11:42', 12345.67)`
  )
  db.close()
  return path
}

describe("data table", () => {
  test("renders aligned column headers and values from metadata", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      const frame = await openTable(setup, "alice")
      /* vertical cell rules make the table boundaries visible while keeping
         each header aligned with its values. Cells are padded to their column
         width, so the rule follows the widest value, not the text. */
      expect(frame).toMatch(/ID\s+│\s+NAME\s+│\s+EMAIL/)
      expect(frame).toMatch(/1\s+│\s+alice/)
      expect(frame).toMatch(/3\s+│\s+carol/)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j/k move the selection arrow down/up and the status bar counts rows", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "alice")
      expect(setup.captureCharFrame()).toContain("3 rows")

      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▶2"))
      expect(setup.captureCharFrame()).toMatch(/▶2\s+│\s+bob/)

      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▶3"))
      expect(setup.captureCharFrame()).toMatch(/▶3\s+│\s+carol/)

      await pressKeys(setup, ["k", "k"])
      await setup.waitForFrame(f => f.includes("▶1"))
      expect(setup.captureCharFrame()).toMatch(/▶1\s+│\s+alice/)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("G jumps to the last row page of a huge table, gg back to the first", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users", bigRows),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "user_0")
      /* the query executor fetches a 200-row page but reports the real total.
         Paged, the bar names the window rather than a bare count, so Ctrl+f is
         discoverable from the status line alone. */
      expect(setup.captureCharFrame()).toContain("1-200 of 1500")

      await pressKeys(setup, ["G"])
      await setup.waitForFrame(f => f.includes("▶200"))
      const last = setup.captureCharFrame()
      expect(last).toContain("▶200")
      expect(last).toContain("user_199")
      /* the loaded page stays virtualized: first rows are not in the frame */
      expect(last).not.toContain("user_0")

      await pressKeys(setup, ["g", "g"])
      await setup.waitForFrame(f => f.includes("▶1"))
      const first = setup.captureCharFrame()
      expect(first).toMatch(/▶1\s+│\s+user_0/)
      expect(first).not.toContain("user_199")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the window slides around the cursor within a huge table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users", bigRows),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "user_0")

      /* j x 4 → cursor sits inside the initial pinned window, top rows visible */
      await pressKeys(setup, ["j", "j", "j", "j"])
      await setup.waitForFrame(f => f.includes("▶5"))
      const nearTop = setup.captureCharFrame()
      expect(nearTop).toMatch(/▶5\s+│\s+user_4/)
      expect(nearTop).toContain("user_0")

      /* 13 more j → cursor 18 is past the viewport half (the pane fills the
         terminal now), so the window recenters and drops the top rows */
      await pressKeys(setup, ["j", "j", "j", "j", "j", "j", "j", "j", "j", "j", "j", "j", "j"])
      await setup.waitForFrame(f => f.includes("▶18"))
      const centered = setup.captureCharFrame()
      expect(centered).toMatch(/▶18\s+│\s+user_17/)
      expect(centered).not.toContain("user_0")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("pans horizontally to reveal columns past the pane edge", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: wideDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "Acme")

      /* the last column starts off-screen to the right */
      const initial = setup.captureCharFrame()
      expect(initial).toContain("CUSTOMER_NAME")
      expect(initial).not.toContain("TOTAL_DUE")

      /* walking the active column right pans the scrollbox to follow it */
      await pressKeys(setup, ["right", "right", "right", "right"])
      await setup.waitForFrame(f => f.includes("TOTAL_DUE"))
      const panned = setup.captureCharFrame()
      expect(panned).toContain("TOTAL_DUE")
      expect(panned).not.toContain("CUSTOMER_NAME")

      /* and back left returns to the first columns */
      await pressKeys(setup, ["left", "left", "left", "left"])
      await setup.waitForFrame(f => f.includes("CUSTOMER_NAME"))
      const back = setup.captureCharFrame()
      expect(back).toContain("CUSTOMER_NAME")
      expect(back).toContain("ID")
    } finally {
      setup.renderer.destroy()
    }
  })
})

/** A users table whose first row holds a value far wider than any column. */
const longValueFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "dient-long-")), "data.db")
  const db = new SqliteDatabase(path)
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)")
  const insert = db.prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)")
  insert.run(1, "FULL-" + "A".repeat(100) + "-TAIL", "alice@example.com")
  insert.run(2, "bob", "bob@example.com")
  db.close()
  return path
}

/** A users table whose first row holds a 25-line value to scroll through. */
const multiLineFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "dient-multiline-")), "data.db")
  const db = new SqliteDatabase(path)
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)")
  const lines = Array.from({ length: 25 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`)
  const insert = db.prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)")
  insert.run(1, lines.join("\n"), "alice@example.com")
  insert.run(2, "bob", "bob@example.com")
  db.close()
  return path
}

describe("cell viewer", () => {
  test("e on a truncated cell shows the whole value, Esc closes it", async () => {
    const full = "FULL-" + "A".repeat(100) + "-TAIL"
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: longValueFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "bob")

      /* the grid truncates to the column width, so the full value is nowhere */
      expect(setup.captureCharFrame()).not.toContain(full)

      /* one step right lands the column cursor on name, e expands it */
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["e"])
      const viewer = await setup.waitForFrame(f => f.includes("j/k scroll"))
      expect(viewer).toContain("users.name")
      /* the value wraps mid-string, so pin its head and its tail */
      expect(viewer).toContain("FULL-AAAAAAAA")
      expect(viewer).toContain("AAAAAAA-TAIL")

      await pressKeys(setup, ["ESCAPE"])
      await setup.waitForFrame(f => !f.includes("j/k scroll"))
      expect(setup.captureCharFrame()).not.toContain(full)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("e inside the preview expands the active cell, j/k and g/G scroll it", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: multiLineFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "bob")
      await pressKeys(setup, ["l", "RETURN"])
      await setup.waitForFrame(f => f.includes("row 1 of 2"))

      /* the preview clips to one row, so the later lines are nowhere */
      expect(setup.captureCharFrame()).not.toContain("row-25")

      await pressKeys(setup, ["e"])
      const viewer = await setup.waitForFrame(f => f.includes("j/k scroll"))
      expect(viewer).toContain("row-02")
      expect(viewer).not.toContain("row-25")

      /* G jumps to the end, g back to the start */
      await pressKeys(setup, ["G"])
      await setup.waitForFrame(f => f.includes("row-25"))
      await pressKeys(setup, ["g"])
      await setup.waitForFrame(f => f.includes("lines 1–"))

      /* Esc lands back on the preview, another Esc closes that too */
      await pressKeys(setup, ["ESCAPE"])
      await setup.waitForFrame(f => f.includes("row 1 of 2") && !f.includes("j/k scroll"))
      await pressKeys(setup, ["ESCAPE"])
      await setup.waitForFrame(f => !f.includes("row 1 of 2"))
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("pane focus", () => {
  test("2 moves focus sidebar to table and 1 moves it back", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    /* wide enough for the full hint strip: at the default width the trailing
       sidebar hints ("Enter open") are shed to fit. */
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />, {
      width: 160,
      height: 26,
    })
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))

      /* sidebar owns the keyboard: its hints name opening, not previewing */
      expect(setup.captureCharFrame()).toContain("Enter open")

      await pressKeys(setup, ["2"])
      await setup.waitForFrame(f => f.includes("Enter preview"))

      await pressKeys(setup, ["1"])
      await setup.waitForFrame(f => f.includes("Enter open"))
      expect(setup.captureCharFrame()).not.toContain("Enter preview")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("plain h/l scroll the columns without leaving the table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: wideDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "Acme")
      expect(setup.captureCharFrame()).not.toContain("TOTAL_DUE")

      /* l walks the active column right exactly like the right arrow */
      await pressKeys(setup, ["l", "l", "l", "l"])
      await setup.waitForFrame(f => f.includes("TOTAL_DUE"))
      const panned = setup.captureCharFrame()
      expect(panned).toContain("TOTAL_DUE")
      /* ...and focus never left the table for the sidebar */
      expect(panned).toContain("Enter preview")

      /* h walks back left */
      await pressKeys(setup, ["h", "h", "h", "h"])
      await setup.waitForFrame(f => f.includes("CUSTOMER_NAME"))
      expect(setup.captureCharFrame()).toContain("Enter preview")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Backspace no longer steals pane focus", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    /* wide enough for the full hint strip: at the default width the trailing
       sidebar hints ("Enter open") are shed to fit. */
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />, {
      width: 160,
      height: 26,
    })
    try {
      await openTable(setup, "alice")
      await setup.waitForFrame(f => f.includes("Enter preview"))

      /* Pane switching now belongs to the number keys, so Backspace — which a
         legacy terminal encodes as the old CTRL+h byte — stays unbound and
         leaves focus on the table. */
      await pressKeys(setup, ["BACKSPACE"])
      await setup.waitForVisualIdle()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("Enter preview")
      expect(frame).not.toContain("Enter open")
    } finally {
      setup.renderer.destroy()
    }
  })
})
