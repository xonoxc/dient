/**
 * Row preview overlay — what `Enter` opens on a row.
 *
 * Enter inspects and `i` edits, and the split is the whole point: a preview that
 * quietly launched `$EDITOR` would make Return a destructive key in the one
 * place a reader's fingers already live, while an edit reachable only through a
 * panel would be two keystrokes for no reason. These tests pin both halves —
 * Enter shows the row and commits nothing, `i` reaches `$EDITOR` from inside the
 * panel *and* straight from the grid.
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

const TMP_ROOT = mkdtempSync(join(tmpdir(), "dient-preview-test-"))

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

/** A `$EDITOR` that reports which row it was handed without changing it, so a
    test can prove Enter never got this far. */
const spyEditor = (): string => installEditor("spy.sh", `printf 'EDITOR-RAN %s' "$1" > "$(dirname "$1")/ran.txt"`)

async function openUsers(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("○ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("▌ USERS") && f.includes("alice"))
}

const seed = async (dataPath: string) => {
  const services = await resolveTestServices(freshConfigFile())
  await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: dataPath })
  return services
}

describe("row preview", () => {
  test("Enter shows the whole row as column: value pairs without editing anything", async () => {
    const dataPath = freshSqliteDataFile()
    const services = await seed(dataPath)
    /* An `$EDITOR` that would shout if it were ever spawned. */
    setEditor(spyEditor())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openUsers(setup)
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["RETURN"])

      const frame = await waitForFrameDriven(setup, f => f.includes("row 1 of 3"))
      /* Every column is named, so the panel is the row and not a pretty excerpt. */
      expect(frame).toContain("id")
      expect(frame).toContain("name")
      expect(frame).toContain("email")
      expect(frame).toContain("alice@example.com")
      /* The value is paired with its column name, the same shape `$EDITOR`
         receives. */
      expect(frame).toMatch(/name\s+alice/)
      /* The hint strip advertises the way out and the way in. */
      expect(frame).toContain("i edit")
      expect(frame).toContain("Esc close")
      /* And the panel did not run the editor. */
      expect(frame).not.toContain("editing users in")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("i inside the preview opens $EDITOR and the panel still shows the saved row", async () => {
    const dataPath = freshSqliteDataFile()
    const services = await seed(dataPath)
    setEditor(installEditor("save.sh", `cat > "$1" <<'DIENTEOF'\nid: 1\nname: amy\nemail: NULL\nDIENTEOF\n`))
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openUsers(setup)
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["RETURN"])
      await waitForFrameDriven(setup, f => f.includes("row 1 of 3"))

      await pressKeys(setup, ["i"])
      await waitForFrameDriven(setup, f => f.includes("saved users."))

      const db = new SqliteDatabase(dataPath)
      const row = db
        .query<{ name: string; email: string | null }, []>("SELECT name, email FROM users WHERE id = 1")
        .get()!
      db.close()
      expect(row.name).toBe("amy")

      /* The preview is left up and reads the cursor row, so the result is
         visible without reopening anything. */
      expect(setup.captureCharFrame()).toMatch(/name\s+amy/)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Esc closes the preview, and i on the row still opens the editor afterwards", async () => {
    const services = await seed(freshSqliteDataFile())
    setEditor(installEditor("noop.sh", "exit 0"))
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openUsers(setup)
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["RETURN"])
      await waitForFrameDriven(setup, f => f.includes("row 1 of 3"))

      await pressKeys(setup, ["ESCAPE"])
      await waitForFrameDriven(setup, f => !f.includes("row 1 of 3"))

      /* Closing a panel must not strand the keybindings — `i` was reachable
         without the panel in the first place, so it has to be reachable after. */
      await pressKeys(setup, ["i"])
      await waitForFrameDriven(setup, f => f.includes("editing users in"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j and k walk the rows behind the panel instead of being swallowed", async () => {
    const services = await seed(freshSqliteDataFile())
    setEditor(installEditor("noop.sh", "exit 0"))
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openUsers(setup)
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["RETURN"])
      await waitForFrameDriven(setup, f => f.includes("row 1 of 3"))

      await pressKeys(setup, ["j"])
      await waitForFrameDriven(setup, f => f.includes("row 2 of 3"))
      expect(setup.captureCharFrame()).toContain("bob@example.com")
    } finally {
      setup.renderer.destroy()
    }
  })
})
