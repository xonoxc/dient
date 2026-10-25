/**
 * Shared `$EDITOR` session plumbing. Both the SQL row editor and the Redis
 * text/row editors stage a temp file, suspend the renderer, run the user's
 * editor inline, and hand the edited text back. Keeping the lifecycle here
 * means every caller gets the same re-entry guard discipline: `done` runs once
 * on every terminal path, including the early ones before a child exists.
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeError } from "@/errors/describe"

/** The suspend/resume surface the editor session needs from the renderer. */
export interface EditorRenderer {
  readonly suspend: () => void
  readonly resume: () => void
}

export interface EditorCallbacks {
  readonly notice: (message: string) => void
  readonly error: (message: string) => void
  /** Called exactly once on every terminal outcome, so callers can clear
      re-entry guards whether the session saved, no-op'd, or failed. */
  readonly done: () => void
}

export interface EditorSessionOptions {
  readonly renderer: EditorRenderer
  /** Shown in the "editing <label> in <editor>" notice. */
  readonly label: string
  /** Suggested temp filename; a safe stem is derived from it. */
  readonly filename: string
  /** File extension, including the leading dot. Defaults to `.txt`. */
  readonly extension?: string
  readonly content: string
  readonly callbacks: EditorCallbacks
  /** Receives the edited file text once the editor exits successfully. */
  readonly onSave: (text: string) => void
}

/** The editor program, honouring `$EDITOR` first, then `$VISUAL`, then `vi`. */
export const editorCommand = (): string => process.env.EDITOR ?? process.env.VISUAL ?? "vi"

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "_") || "edit"

const cleanDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
}

/** Run one editor session over `content` and report the edited text to `onSave`. */
export const runEditorSession = (options: EditorSessionOptions): void => {
  const { renderer, label, filename, extension, content, callbacks, onSave } = options
  const command = editorCommand()

  let dir: string
  try {
    dir = mkdtempSync(join(tmpdir(), "dient-edit-"))
  } catch (cause) {
    callbacks.error(`could not create a temp file for editing: ${describeError(cause)}`)
    callbacks.done()
    return
  }

  const abandon = (message: string): void => {
    cleanDir(dir)
    callbacks.error(message)
    callbacks.done()
  }

  const file = join(dir, `${safeName(filename)}${extension ?? ".txt"}`)
  try {
    writeFileSync(file, content, "utf8")
  } catch (cause) {
    abandon(`could not stage the file for editing: ${describeError(cause)}`)
    return
  }

  const program = command.split(/\s+/).filter(Boolean)
  const bin = program[0]
  /* `$EDITOR` is frequently set to an empty string by a shell profile. That
     parses to an empty argv, and `spawn` would throw on the missing binary —
     inside a keypress handler, with the renderer already suspended and the
     re-entry guard set. Report it the same way as any other unusable editor. */
  if (bin === undefined) {
    abandon(`no editor to run — set $EDITOR or $VISUAL`)
    return
  }

  callbacks.notice(`editing ${label} in ${bin}`)
  renderer.suspend()

  let child: ChildProcess
  try {
    child = spawn(bin, [...program.slice(1), file], {
      stdio: "inherit",
      env: process.env,
    })
  } catch (cause) {
    renderer.resume()
    abandon(`could not start "${command}": ${describeError(cause)}`)
    return
  }

  let handled = false
  child.on("error", err => {
    if (handled) return
    handled = true
    renderer.resume()
    abandon(`could not start "${command}": ${err.message}`)
  })
  child.on("exit", code => {
    if (handled) return
    handled = true
    renderer.resume()
    if (code !== 0) {
      abandon(`editor exited with code ${code} — no changes taken back`)
      return
    }
    let edited: string
    try {
      edited = readFileSync(file, "utf8")
    } catch (cause) {
      abandon(`could not read the edited file: ${describeError(cause)}`)
      return
    }
    cleanDir(dir)
    try {
      onSave(edited)
    } catch (cause) {
      callbacks.error(`could not apply the edit: ${describeError(cause)}`)
    } finally {
      callbacks.done()
    }
  })
}
