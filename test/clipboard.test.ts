/**
 * Clipboard write tests. The interesting failure is silent: a Wayland/X11
 * clipboard write is only an offer to own the selection, served by whoever wrote
 * it. Disposing the host service right after `writeText` resolves drops that
 * ownership, so every copy reports success and pastes nothing — which is exactly
 * what regressed once. The last test reads the text back from a *fresh* service,
 * which is the only way to see that.
 */
import { describe, expect, test } from "bun:test"
import { createHostClipboard } from "@opentui/core"
import { writeSystemClipboard } from "@/ui/clipboard"

/** Read the clipboard with newlines intact; the app's own reader strips them. */
const readRaw = async (): Promise<string | null> => {
  const clipboard = createHostClipboard({ maxReadBytes: 256 * 1024, timeoutMs: 1000 })
  try {
    const result = await clipboard.read({ preferredTypes: ["text/plain"] })
    return result.status === "read" ? new TextDecoder().decode(result.representation.bytes) : null
  } finally {
    await clipboard.dispose().catch(() => {})
  }
}

describe("writeSystemClipboard", () => {
  test("mirrors the text over OSC 52, which is what reaches a remote session", async () => {
    const seen: string[] = []
    const result = await writeSystemClipboard("id: 1\n", {
      copyToClipboardOSC52: text => {
        seen.push(text)
        return true
      },
    })
    expect(seen).toEqual(["id: 1\n"])
    expect(result.terminal).toBe(true)
    expect(result.ok).toBe(true)
  })

  test("a terminal that rejects OSC 52 is reported, not thrown", async () => {
    const result = await writeSystemClipboard("x", {
      copyToClipboardOSC52: () => {
        throw new Error("terminal says no")
      },
    })
    expect(result.terminal).toBe(false)
    expect(result).toHaveProperty("host")
  })

  /* Writes the test string to the developer's clipboard; unavoidable when the
     thing under test is the clipboard. Skips on a headless host, where there is
     no selection to read back. */
  test("the copied text survives the write (the writer keeps owning the selection)", async () => {
    const text = `dient-clipboard-${Date.now()}\nsecond line\n`
    const result = await writeSystemClipboard(text)
    if (!result.ok) return
    expect(await readRaw()).toBe(text)
  })
})
