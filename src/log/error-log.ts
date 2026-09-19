/**
 * Plain file-backed error log. The TUI appends one line per unexpected failure
 * so a crash after exit still leaves a trace for debugging. Reads/writes never
 * block the UI thread: appends are fire-and-forget async appends.
 */
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

export const defaultLogPath = (): string => join(homedir(), ".dient", "error.log")

const MAX_LOG_LINES = 2000

/* Keep only the tail when the log grows past the cap, so it never balloons. */
const trimLog = async (path: string): Promise<void> => {
  const { readFile, writeFile } = await import("node:fs/promises")
  try {
    const lines = (await readFile(path, "utf8")).split("\n")
    if (lines.length <= MAX_LOG_LINES) return
    await writeFile(path, lines.slice(-MAX_LOG_LINES).join("\n"))
  } catch {
    /* trimming is best effort */
  }
}

export const appendError = async (path: string, source: string, error: unknown): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack ? "\n" + error.stack : ""
  const line = `[${new Date().toISOString()}] ${source} :: ${message}${stack}`
  try {
    await appendFile(path, line + "\n", "utf8")
    void trimLog(path)
  } catch {
    /* logging must never crash the app */
  }
}

export const appendErrorDefault = (source: string, error: unknown): void => {
  void appendError(defaultLogPath(), source, error)
}