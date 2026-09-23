/**
 * `$EDITOR`-based row editing. The cursor row is serialized to a temp file of
 * `column: value` lines (generated from the table schema) and handed to the
 * user's editor (`$EDITOR`/`$VISUAL`, falling back to `vi`), spawned inline in
 * the terminal. While the editor owns the terminal the renderer is suspended
 * (raw mode off, alternate screen released), then resumed on exit; the edited
 * file is parsed back and offered to the caller as typed UPDATE parameters.
 *
 * This replaces an in-TUI form: the user gets their own editor (vim, nano,
 * code) with full syntax, and Escape/save semantics are whatever that editor
 * provides — nothing is lost by a stray keypress inside the app.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TableColumn } from "@/inspector/types"
import type { RowValueUpdate } from "@/editor/row-serialization"
import { parseRowKeyValue, serializeRowToKeyValue } from "@/editor/row-serialization"

/** The suspend/resume surface the editor session needs from the renderer. */
export interface EditorRenderer {
  readonly suspend: () => void
  readonly resume: () => void
}

export interface EditRowCallbacks {
  readonly notice: (message: string) => void
  readonly error: (message: string) => void
  /** Called with the parsed changes once the editor committed a valid file. */
  readonly onChanges: (updates: ReadonlyArray<RowValueUpdate>) => void
  /** Called exactly once on every terminal outcome, so callers can clear
      re-entry guards whether the session saved, no-op'd, or failed. */
  readonly done: () => void
}

export interface EditRowOptions {
  readonly renderer: EditorRenderer
  readonly tableName: string
  readonly columns: ReadonlyArray<TableColumn>
  readonly primaryKey: ReadonlyArray<string>
  readonly row: Readonly<Record<string, unknown>>
  readonly callbacks: EditRowCallbacks
}

/** The editor program, honouring `$EDITOR` first, then `$VISUAL`, then `vi`. */
export const editorCommand = (): string => process.env.EDITOR ?? process.env.VISUAL ?? "vi"

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "_") || "table"

/** Launch `$EDITOR` over a temp `column: value` file of the row and report parsed changes. */
export const editRowInEditor = (options: EditRowOptions): void => {
  const { renderer, tableName, columns, primaryKey, row, callbacks } = options
  const command = editorCommand()

  const dir = mkdtempSync(join(tmpdir(), "dient-row-"))
  const file = join(dir, `${safeName(tableName)}.txt`)
  let wrote = false
  try {
    writeFileSync(file, serializeRowToKeyValue(columns, row), "utf8")
    wrote = true
  } catch (cause) {
    callbacks.error(`could not stage the row for editing: ${String(cause)}`)
    return
  }

  const clean = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort temp cleanup */
    }
  }

  const program = command.split(/\s+/).filter(Boolean)
  const bin = program[0]

  callbacks.notice(`editing ${tableName} in ${bin}`)
  renderer.suspend()

  const child = spawn(bin!, [...program.slice(1), file], {
    stdio: "inherit",
    env: process.env,
  })

  let handled = false
  child.on("error", err => {
    if (handled) return
    handled = true
    renderer.resume()
    clean()
    callbacks.error(`could not start "${command}": ${err.message}`)
    callbacks.done()
  })
  child.on("exit", code => {
    if (handled) return
    handled = true
    renderer.resume()
    if (code !== 0) {
      clean()
      callbacks.error(`editor exited with code ${code} — no changes taken back`)
      callbacks.done()
      return
    }
    let edited: string
    try {
      edited = readFileSync(file, "utf8")
    } catch (cause) {
      clean()
      callbacks.error(`could not read the edited file: ${String(cause)}`)
      callbacks.done()
      return
    }
    clean()
    const result = parseRowKeyValue(edited, columns, primaryKey, row)
    if (!result.ok) {
      callbacks.error(result.error)
      callbacks.done()
      return
    }
    if (result.updates.length === 0) {
      callbacks.notice("no changes to save")
      callbacks.done()
      return
    }
    options.callbacks.onChanges(result.updates)
    callbacks.done()
  })
}