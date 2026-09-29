import { createHostClipboard } from "@opentui/core"

/** Read plain text from the local system clipboard. Terminal paste events are
 * handled separately by OpenTUI; OSC 52 cannot provide portable clipboard reads. */
export async function readSystemClipboard(): Promise<string | null> {
  const clipboard = createHostClipboard({ maxReadBytes: 256 * 1024, timeoutMs: 1000 })
  try {
    const result = await clipboard.read({ preferredTypes: ["text/plain"] })
    if (result.status !== "read") return null
    const text = new TextDecoder().decode(result.representation.bytes)
    const singleLine = text
      .replace(/\0/g, "")
      .replace(/[\r\n]+/g, "")
      .trim()
    return singleLine.length > 0 ? singleLine : null
  } finally {
    await clipboard.dispose()
  }
}

/** The renderer surface needed to mirror a copy into the terminal's own
 * clipboard (OSC 52), the only path that reaches a remote/SSH session. */
export interface ClipboardTerminalSink {
  copyToClipboardOSC52: (text: string) => boolean
}

export type ClipboardWriteStatus = "written" | "unsupported" | "failed"

export interface ClipboardWriteResult {
  /** Host clipboard outcome, or the failure that replaced it. */
  readonly host: ClipboardWriteStatus
  /** Whether OSC 52 accepted the text (unknown when no sink was offered). */
  readonly terminal: boolean
  /** True when either channel took the text. */
  readonly ok: boolean
}

/**
 * Put text on the clipboard, newline-rich content included. Both channels are
 * tried: the host clipboard for a local terminal, and OSC 52 so a copy still
 * lands when dient runs over SSH and the host clipboard is not ours. A failure
 * is reported rather than thrown — copying is a convenience, not an operation
 * the caller has to unwind.
 */
export async function writeSystemClipboard(
  text: string,
  terminal?: ClipboardTerminalSink
): Promise<ClipboardWriteResult> {
  let terminalAccepted = false
  try {
    terminalAccepted = terminal?.copyToClipboardOSC52(text) ?? false
  } catch {
    /* OSC 52 is best-effort: an unsupported terminal throws rather than returning false. */
  }

  try {
    const clipboard = hostClipboardForWrite()
    const result = await clipboard.writeText(text)
    if (result.status === "written") {
      return { host: "written", terminal: terminalAccepted, ok: true }
    }
    /* Only the host had not taken it; OSC 52 alone is still a real copy. */
    if (result.status === "unsupported") {
      return { host: "unsupported", terminal: terminalAccepted, ok: terminalAccepted }
    }
    return { host: "failed", terminal: terminalAccepted, ok: terminalAccepted }
  } catch {
    /* Includes a host clipboard the platform cannot create at all. */
    return { host: "failed", terminal: terminalAccepted, ok: terminalAccepted }
  }
}

/**
 * A host clipboard service kept alive for the life of the process.
 *
 * On Wayland (and X11) a clipboard write is not a datastore: whoever wrote it
 * *owns the selection and serves it on request*. Disposing the service drops
 * that ownership — the copy reports success and every paste afterwards comes
 * back empty. So the writer is never disposed; process exit releases it, and
 * the OSC 52 write is what makes a copy survive dient quitting.
 */
let writeService: ReturnType<typeof createHostClipboard> | null = null

const hostClipboardForWrite = (): ReturnType<typeof createHostClipboard> => {
  writeService ??= createHostClipboard({ timeoutMs: 1000 })
  return writeService
}
