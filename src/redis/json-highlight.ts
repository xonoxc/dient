/**
 * Tiny JSON highlighter for the RedisJSON value panel. The app cannot rely on
 * `jq` being installed, so this keeps the styling in-process: tokenize the
 * pretty-printed document, then wrap the tokens into fixed-width visual lines
 * without losing their colors. `wrapText` elsewhere still handles plain
 * strings; this module only knows the handful of JSON token classes.
 */

export type JsonTokenKind = "key" | "string" | "number" | "literal" | "punctuation" | "plain"

export interface JsonSegment {
  readonly text: string
  readonly kind: JsonTokenKind
}

const TOKEN = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]|\s+|./g

const nextNonSpace = (text: string, from: number): string => {
  for (let at = from; at < text.length; at++) {
    const char = text[at]!
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") return char
  }
  return ""
}

/** Split JSON text into colored tokens. Malformed JSON still renders: unknown
 *  characters fall through as plain text instead of dropping the value. */
export const tokenizeJson = (text: string): ReadonlyArray<JsonSegment> => {
  const segments: JsonSegment[] = []
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0]
    if (token.length === 0) continue
    const at = match.index ?? 0
    let kind: JsonTokenKind
    if (token.startsWith('"')) {
      kind = nextNonSpace(text, at + token.length) === ":" ? "key" : "string"
    } else if (token === "true" || token === "false" || token === "null") {
      kind = "literal"
    } else if (/^-?\d/.test(token)) {
      kind = "number"
    } else if (/^[{}[\],:]$/.test(token)) {
      kind = "punctuation"
    } else {
      kind = "plain"
    }
    const previous = segments[segments.length - 1]
    if (previous && previous.kind === kind) {
      segments[segments.length - 1] = { text: previous.text + token, kind }
    } else {
      segments.push({ text: token, kind })
    }
  }
  return segments
}

/** Wrap colored tokens into visual lines of at most `width` cells. This mirrors
 *  `wrapText` (split on real newlines, then chunk), but keeps each chunk tagged
 *  so a long string stays green across line breaks. */
export const highlightJsonLines = (text: string, width: number): ReadonlyArray<ReadonlyArray<JsonSegment>> => {
  const room = Math.max(1, Math.floor(width))
  const lines: Array<Array<{ text: string; kind: JsonTokenKind }>> = [[]]
  let column = 0

  const append = (segment: { text: string; kind: JsonTokenKind }) => {
    const current = lines[lines.length - 1]!
    const previous = current[current.length - 1]
    if (previous && previous.kind === segment.kind) {
      current[current.length - 1] = { text: previous.text + segment.text, kind: segment.kind }
    } else {
      current.push(segment)
    }
  }

  for (const token of tokenizeJson(text)) {
    const parts = token.text.split("\n")
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        lines.push([])
        column = 0
      }
      let remaining = part
      while (remaining.length > 0) {
        if (column >= room) {
          lines.push([])
          column = 0
        }
        const chunk = remaining.slice(0, room - column)
        append({ text: chunk, kind: token.kind })
        column += chunk.length
        remaining = remaining.slice(chunk.length)
      }
    }
  }
  return lines
}
