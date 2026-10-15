/**
 * Plain file-backed error log. The TUI appends one line per unexpected failure
 * so a crash after exit still leaves a trace for debugging. Appends are small
 * composed Effects (`read → trim → append`) forked exactly once inside the
 * service — callers stay synchronous and can never observe a rejection,
 * because logging must never crash the app.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { Effect } from "effect"

export const defaultLogPath = (): string => join(homedir(), ".dient", "error.log")

const MAX_LOG_LINES = 2000

/* Keep only the tail when the log grows past the cap, so it never balloons.
   Best effort: trimming failure degrades to an untrimmed log, never an error. */
const trimLog = (path: string): Effect.Effect<void> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap(contents => {
      const lines = contents.split("\n")
      if (lines.length <= MAX_LOG_LINES) return Effect.void
      return Effect.tryPromise(() => writeFile(path, lines.slice(-MAX_LOG_LINES).join("\n"), "utf8")).pipe(
        Effect.orElseSucceed(() => undefined)
      )
    }),
    Effect.orElseSucceed(() => undefined)
  )

const formatLine = (source: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack ? "\n" + error.stack : ""
  return `[${new Date().toISOString()}] ${source} :: ${message}${stack}\n`
}

const appendLine = (path: string, line: string): Effect.Effect<void> =>
  Effect.tryPromise(() => appendFile(path, line, "utf8")).pipe(Effect.orElseSucceed(() => undefined))

/** A ready-to-call appender bound to one log file (tests use a temp path). */
export interface ErrorLog {
  readonly append: (source: string, error: unknown) => void
}

export const makeErrorLog = (path: string): ErrorLog => ({
  append: (source, error) => {
    /* The single fork: read, trim, and append compose into one Effect whose
       every failure is already folded to success — fire and forget. */
    Effect.runFork(
      Effect.gen(function* () {
        yield* appendLine(path, formatLine(source, error))
        yield* trimLog(path)
      })
    )
  },
})

export const appendErrorDefault = (source: string, error: unknown): void => {
  makeErrorLog(defaultLogPath()).append(source, error)
}
