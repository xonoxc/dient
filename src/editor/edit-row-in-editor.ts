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
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TableColumn } from "@/inspector/types"
import type { RowValueUpdate } from "@/editor/row-serialization"
import { parseRowKeyValue, serializeRowToKeyValue } from "@/editor/row-serialization"
import { describeError } from "@/errors/describe"

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

  /* Every early return below has to hand control back to the caller, which holds
     a re-entry guard for the whole session. A bail-out that skips `done` leaves
     that guard set for the life of the process, so `i` silently stops opening
     the editor and no key can clear it. */
  const abandon = (message: string): void => {
    callbacks.error(message)
    callbacks.done()
  }

  const dir = mkdtempSync(join(tmpdir(), "dient-row-"))
  const file = join(dir, `${safeName(tableName)}.txt`)
  let wrote = false
  try {
    writeFileSync(file, serializeRowToKeyValue(columns, row), "utf8")
    wrote = true
  } catch (cause) {
    abandon(`could not stage the row for editing: ${describeError(cause)}`)
  }
  if (!wrote) {
    cleanDir(dir)
    return
  }

  const program = command.split(/\s+/).filter(Boolean)
  const bin = program[0]
  /* `$EDITOR` is frequently set to an empty string by a shell profile. That
     parses to an empty argv, and `spawn` would throw on the missing binary —
     inside a keypress handler, with the renderer already suspended and the
     re-entry guard set. Report it the same way as any other unusable editor. */
  if (bin === undefined) {
    cleanDir(dir)
    abandon(`no editor to run — set $EDITOR or $VISUAL`)
    return
  }

  callbacks.notice(`editing ${tableName} in ${bin}`)
  renderer.suspend()

  let child: ChildProcess
  try {
    child = spawn(bin, [...program.slice(1), file], {
      stdio: "inherit",
      env: process.env,
    })
  } catch (cause) {
    renderer.resume()
    cleanDir(dir)
    abandon(`could not start "${command}": ${describeError(cause)}`)
    return
  }

  let handled = false
  child.on("error", err => {
    if (handled) return
    handled = true
    renderer.resume()
    cleanDir(dir)
    abandon(`could not start "${command}": ${err.message}`)
  })
  child.on("exit", code => {
    if (handled) return
    handled = true
    renderer.resume()
    if (code !== 0) {
      cleanDir(dir)
      abandon(`editor exited with code ${code} — no changes taken back`)
      return
    }
    let edited: string
    try {
      edited = readFileSync(file, "utf8")
    } catch (cause) {
      cleanDir(dir)
      abandon(`could not read the edited file: ${describeError(cause)}`)
      return
    }
    cleanDir(dir)
    const result = parseRowKeyValue(edited, columns, primaryKey, row)
    if (!result.ok) {
      abandon(result.error)
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

const cleanDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
}
