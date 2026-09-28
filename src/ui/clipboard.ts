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
