/**
 * Shared `$EDITOR` session plumbing: stage a temp file, suspend the renderer,
 * run the editor inline, and hand the edited text back.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, watch as fsWatch } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { describeError } from "@/errors/describe"

export interface EditorRenderer {
  readonly suspend: () => void
  readonly resume: () => void
}

export interface EditorCallbacks {
  readonly notice: (message: string) => void
  readonly error: (message: string) => void
  /** Called exactly once on every terminal outcome, so callers can clear guards. */
  readonly done: () => void
}

export interface EditorSessionOptions {
  readonly renderer: EditorRenderer
  readonly label: string
  /** Sanitized into a safe temp filename stem. */
  readonly filename: string
  /** Includes the leading dot; defaults to `.txt`. */
  readonly extension?: string
  readonly content: string
  readonly callbacks: EditorCallbacks
  readonly onSave: (text: string) => void
  /** Re-run `onSave` on each save while the editor stays open, instead of once
      on exit. */
  readonly watch?: boolean
}

/** `$EDITOR`, then `$VISUAL`, then `vi`. */
export const editorCommand = (): string => process.env.EDITOR ?? process.env.VISUAL ?? "vi"

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "_") || "edit"

const cleanDir = (dir: string): void => {
  Result.try(() => rmSync(dir, { recursive: true, force: true }))
}

export const runEditorSession = (options: EditorSessionOptions): void => {
  const { renderer, label, filename, extension, content, callbacks, onSave, watch } = options
  const command = editorCommand()

  const madeDir = Result.try(() => mkdtempSync(join(tmpdir(), "dient-edit-")))
  if (Result.isFailure(madeDir)) {
    callbacks.error(`could not create a temp file for editing: ${describeError(madeDir.failure)}`)
    callbacks.done()
    return
  }
  const dir = madeDir.success

  const abandon = (message: string): void => {
    cleanDir(dir)
    callbacks.error(message)
    callbacks.done()
  }

  const file = join(dir, `${safeName(filename)}${extension ?? ".txt"}`)

  const staged = Result.try(() => writeFileSync(file, content, "utf8"))
  if (Result.isFailure(staged)) {
    abandon(`could not stage the file for editing: ${describeError(staged.failure)}`)
    return
  }

  let lastContent = content
  let watcher: ReturnType<typeof fsWatch> | null = null
  const closeWatcher = (): void => {
    if (!watcher) return
    const current = watcher
    watcher = null
    void Result.try(() => current.close())
  }
  const readAndSave = (): void => {
    const edited = Result.getOrNull(Result.try(() => readFileSync(file, "utf8")))

    if (edited === null) return
    if (edited === lastContent) return
    lastContent = edited

    const saved = Result.try(() => onSave(edited))
    if (Result.isFailure(saved)) {
      callbacks.error(`could not apply the edit: ${describeError(saved.failure)}`)
    }
  }
  if (watch) {
    const watching = Result.try(() =>
      fsWatch(file, () => {
        // Debounce: editors often write in multiple steps.
        setTimeout(readAndSave, 200)
      })
    )
    if (Result.isSuccess(watching)) watcher = watching.success
  }

  const program = command.split(/\s+/).filter(Boolean)
  const bin = program[0]
  /* GUI editors fork and exit immediately, so append a blocking flag for the
     ones we recognise to keep the process alive until close. */
  const waitFlag = (() => {
    const base = (bin ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? ""
    if (base === "code" || base === "code-insiders" || base === "atom") return "--wait"
    if (base === "subl") return "-w"
    return null
  })()
  const args = [...program.slice(1)]
  if (waitFlag && !program.includes(waitFlag)) args.push(waitFlag)
  args.push(file)
  /* `$EDITOR` is often empty in a shell profile, which parses to an empty argv;
     report it like any other unusable editor. */
  if (bin === undefined) {
    abandon(`no editor to run — set $EDITOR or $VISUAL`)
    return
  }

  callbacks.notice(`editing ${label} in ${bin}`)
  renderer.suspend()

  const spawned = Result.try(() => spawn(bin, args, { stdio: "inherit", env: process.env }))
  if (Result.isFailure(spawned)) {
    renderer.resume()
    abandon(`could not start "${command}": ${describeError(spawned.failure)}`)
    return
  }

  const child = spawned.success

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

    const read = Result.try(() => readFileSync(file, "utf8"))
    if (Result.isFailure(read)) {
      abandon(`could not read the edited file: ${describeError(read.failure)}`)
      return
    }
    const edited = read.success

    cleanDir(dir)

    const saved = Result.try(() => onSave(edited))
    if (Result.isFailure(saved)) {
      callbacks.error(`could not apply the edit: ${describeError(saved.failure)}`)
    }

    callbacks.done()
  })
}
