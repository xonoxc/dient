/**
 * System clipboard through small composed Effects. Reads fail with
 * `ClipboardError` (callers fold that into a toast inside their own program);
 * writes never fail — copying is best-effort convenience, so the outcome is a
 * status value, exactly as before.
 */
import { createHostClipboard } from "@opentui/core"
import { Data, Effect, Option } from "effect"

export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Read plain text from the local system clipboard. Terminal paste events are
 * handled separately by OpenTUI; OSC 52 cannot provide portable clipboard reads. */
export const readSystemClipboard: Effect.Effect<Option.Option<string>, ClipboardError> = Effect.gen(function* () {
  const clipboard = yield* Effect.try({
    try: () => createHostClipboard({ maxReadBytes: 256 * 1024, timeoutMs: 1000 }),
    catch: cause => new ClipboardError({ message: "could not open the clipboard", cause }),
  })

  const text = yield* Effect.tryPromise({
    try: () => clipboard.read({ preferredTypes: ["text/plain"] }).finally(() => clipboard.dispose()),
    catch: cause => new ClipboardError({ message: "could not read the clipboard", cause }),
  })

  if (text.status !== "read") return Option.none()
  const singleLine = new TextDecoder()
    .decode(text.representation.bytes)
    .replace(/\0/g, "")
    .replace(/[\r\n]+/g, "")
    .trim()
  return singleLine.length > 0 ? Option.some(singleLine) : Option.none()
})

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

const mirrorToTerminal = (terminal: ClipboardTerminalSink | undefined, text: string): boolean => {
  if (!terminal) return false
  try {
    return terminal.copyToClipboardOSC52(text)
  } catch {
    /* OSC 52 is best-effort: an unsupported terminal throws rather than returning false. */
    return false
  }
}

/**
 * Put text on the clipboard, newline-rich content included. Both channels are
 * tried: the host clipboard for a local terminal, and OSC 52 so a copy still
 * lands when dient runs over SSH and the host clipboard is not ours.
 */
export const writeSystemClipboard = (
  text: string,
  terminal?: ClipboardTerminalSink
): Effect.Effect<ClipboardWriteResult> =>
  Effect.gen(function* () {
    const terminalAccepted = mirrorToTerminal(terminal, text)
    const status = yield* Effect.tryPromise(() => hostClipboardForWrite().writeText(text)).pipe(
      Effect.map(result => result.status),
      Effect.orElseSucceed(() => "failed" as const)
    )
    /* The host reports several non-write outcomes (unsupported, cancelled,
       timed-out); all of them mean "not on the host clipboard". */
    const host: ClipboardWriteStatus =
      status === "written" ? "written" : status === "unsupported" ? "unsupported" : "failed"
    if (host === "written") return { host, terminal: terminalAccepted, ok: true }
    return { host, terminal: terminalAccepted, ok: terminalAccepted }
  })

/**
 * A host clipboard service kept alive for the life of the process.
 *
 * On Wayland (and X11) a clipboard write is not a datastore: whoever wrote it
 * *owns the selection and serves it on request*. Disposing the service drops
 * that ownership — the copy reports success and every paste afterwards comes
 * back empty. So the writer is never disposed; process exit releases it, and
 * the OSC 52 write is what makes a copy survive dient quitting. A scoped
 * resource cannot express "lives as long as the process", hence the singleton.
 */
let writeService: ReturnType<typeof createHostClipboard> | null = null

const hostClipboardForWrite = (): ReturnType<typeof createHostClipboard> => {
  writeService ??= createHostClipboard({ timeoutMs: 1000 })
  return writeService
}
