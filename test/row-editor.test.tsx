/**
 * `$EDITOR`-based row editing end to end. Pressing `i` suspends the renderer,
 * hands a TSV of the cursor row to `$EDITOR`, and on exit parses the file back
 * into typed UPDATE params and persists them. These tests substitute a shell
 * script for the editor: one that rewrites the temp file (save), one that does
 * nothing useful (abort), and one that reproduces the file (no changes).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import App from "@/app"
import { makeTheme } from "@/theme"
import { Database as SqliteDatabase } from "bun:sqlite"
import { pressKeys, renderApp, waitForFrameDriven } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

const TMP_ROOT = mkdtempSync(join(tmpdir(), "dient-editor-test-"))

const installEditor = (name: string, body: string): string => {
  const file = join(TMP_ROOT, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

let previousEditor: string | undefined
const setEditor = (program: string): void => {
  previousEditor = process.env.EDITOR
  process.env.EDITOR = program
}

afterEach(() => {
  if (previousEditor === undefined) delete process.env.EDITOR
  else process.env.EDITOR = previousEditor
})

async function openUsers(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("○ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("▶ USERS") && f.includes("alice"))
}

describe("$EDITOR row editing", () => {
  test("pressing i opens the row in $EDITOR and parses edits back to the database", async () => {
    const dataPath = freshSqliteDataFile()
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: dataPath })
    /* The fake editor rewrites the row file: rename alice, clear her email. */
    setEditor(
      installEditor(
        "save.sh",
        `cat > "$1" <<'DIENTEOF'\nid\tname\temail\n1\tamy\t\nDIENTEOF\n`
      )
    )
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openUsers(setup)
      await pressKeys(setup, ["i"])
      await waitForFrameDriven(setup, f => f.includes("saved users.") && f.includes("amy"))

      const db = new SqliteDatabase(dataPath)
      const row = db
        .query<{ id: number; name: string; email: string | null }, []>(
          "SELECT id, name, email FROM users WHERE id = 1"
        )
        .get()!
      db.close()
      expect(row.id).toBe(1)
      expect(row.name).toBe("amy")
      expect(row.email).toBeNull()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("an editor that exits non-zero discards the session", async () => {
    const dataPath = freshSqliteDataFile()
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: dataPath })
    setEditor(installEditor("abort.sh", "exit 1"))
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openUsers(setup)
      await pressKeys(setup, ["i"])
      await waitForFrameDriven(setup, f => f.includes("editor exited with code 1"))

      const db = new SqliteDatabase(dataPath)
      const row = db.query<{ name: string }, []>("SELECT name FROM users WHERE id = 1").get()!
      db.close()
      expect(row.name).toBe("alice")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("an unchanged file reports no changes to save", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    setEditor(installEditor("touch.sh", "exit 0"))
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openUsers(setup)
      await pressKeys(setup, ["i"])
      await waitForFrameDriven(setup, f => f.includes("no changes to save"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test("tables without a primary key refuse row editing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dient-data-")), "notes.db")
    const db = new SqliteDatabase(path)
    db.run("CREATE TABLE notes (body TEXT)")
    db.run("INSERT INTO notes (body) VALUES ('hello')")
    db.close()

    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: path })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("▶ NOTES") && f.includes("hello"))
      await pressKeys(setup, ["i"])
      await setup.waitForFrame(f => f.includes("no primary key"))
    } finally {
      setup.renderer.destroy()
    }
  })
})