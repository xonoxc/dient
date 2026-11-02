/**
 * Shared `$EDITOR` session plumbing. Both the SQL row editor and the Redis
 * text/row editors stage a temp file, suspend the renderer, run the user's
 * editor inline, and hand the edited text back. Keeping the lifecycle here
 * means every caller gets the same re-entry guard discipline: `done` runs once
 * on every terminal path, including the early ones before a child exists.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, watch as fsWatch } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Either } from "effect"
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
  /** When true, re-run `onSave` whenever the file is saved while the editor
      stays open, instead of only on exit. */
  readonly watch?: boolean
}

/** The editor program, honouring `$EDITOR` first, then `$VISUAL`, then `vi`. */
export const editorCommand = (): string => process.env.EDITOR ?? process.env.VISUAL ?? "vi"

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "_") || "edit"

const cleanDir = (dir: string): void => {
  /* best-effort temp cleanup */
  Either.try(() => rmSync(dir, { recursive: true, force: true }))
}

/** Run one editor session over `content` and report the edited text to `onSave`. */
export const runEditorSession = (options: EditorSessionOptions): void => {
  const { renderer, label, filename, extension, content, callbacks, onSave, watch } = options
  const command = editorCommand()

  const madeDir = Either.try(() => mkdtempSync(join(tmpdir(), "dient-edit-")))
  if (Either.isLeft(madeDir)) {
    callbacks.error(`could not create a temp file for editing: ${describeError(madeDir.left)}`)
    callbacks.done()
    return
  }
  const dir = madeDir.right

  const abandon = (message: string): void => {
    cleanDir(dir)
    callbacks.error(message)
    callbacks.done()
  }

  const file = join(dir, `${safeName(filename)}${extension ?? ".txt"}`)

  const staged = Either.try(() => writeFileSync(file, content, "utf8"))
  if (Either.isLeft(staged)) {
    abandon(`could not stage the file for editing: ${describeError(staged.left)}`)
    return
  }

  let lastContent = content
  let watcher: ReturnType<typeof fsWatch> | null = null
  const closeWatcher = (): void => {
    if (!watcher) return
    const current = watcher
    watcher = null
    void Either.try(() => current.close())
  }
  const readAndSave = (): void => {
    const edited = Either.getOrNull(Either.try(() => readFileSync(file, "utf8")))

    if (edited === null) return
    if (edited === lastContent) return
    lastContent = edited

    const saved = Either.try(() => onSave(edited))
    if (Either.isLeft(saved)) {
      callbacks.error(`could not apply the edit: ${describeError(saved.left)}`)
    }
  }
  if (watch) {
    const watching = Either.try(() =>
      fsWatch(file, () => {
        // Debounce: editors often write in multiple steps.
        setTimeout(readAndSave, 200)
      })
    )
    if (Either.isRight(watching)) watcher = watching.right
    /* watching is best-effort */
  }

  const program = command.split(/\s+/).filter(Boolean)
  const bin = program[0]
  /* GUI editors (VS Code, Sublime, Atom, ...) fork and exit immediately, so
     the session would read the file before the user saves. Append a blocking
     flag for the ones we recognise so the process stays alive until close. */
  const waitFlag = (() => {
    const base = (bin ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? ""
    if (base === "code" || base === "code-insiders" || base === "atom") return "--wait"
    if (base === "subl") return "-w"
    return null
  })()
  const args = [...program.slice(1)]
  if (waitFlag && !program.includes(waitFlag)) args.push(waitFlag)
  args.push(file)
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

  const spawned = Either.try(() => spawn(bin, args, { stdio: "inherit", env: process.env }))
  if (Either.isLeft(spawned)) {
    renderer.resume()
    abandon(`could not start "${command}": ${describeError(spawned.left)}`)
    return
  }

  const child = spawned.right

  let handled = false
  child.on("error", err => {
    if (handled) return

    handled = true
    closeWatcher()
    renderer.resume()
    abandon(`could not start "${command}": ${err.message}`)
  })

  child.on("exit", code => {
    if (handled) return

    handled = true
    closeWatcher()
    renderer.resume()
    if (code !== 0) {
      abandon(`editor exited with code ${code} — no changes taken back`)
      return
    }

    if (watch) {
      readAndSave()
      cleanDir(dir)
      callbacks.done()
      return
    }

    const read = Either.try(() => readFileSync(file, "utf8"))
    if (Either.isLeft(read)) {
      abandon(`could not read the edited file: ${describeError(read.left)}`)
      return
    }
    const edited = read.right

    cleanDir(dir)

    const saved = Either.try(() => onSave(edited))
    if (Either.isLeft(saved)) {
      callbacks.error(`could not apply the edit: ${describeError(saved.left)}`)
    }

    callbacks.done()
  })
}
