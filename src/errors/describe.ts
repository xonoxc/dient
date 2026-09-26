/**
 * Turning a thrown value into something worth showing a person.
 *
 * Every driver failure arrives wrapped several layers deep — a `ConnectionError`
 * around a `SqlError` around a driver `Error` — and `String(cause)` on any of
 * them produces a multi-line dump: a `(FiberFailure)` prefix, an inline object
 * literal with a `[cause]` key, and a stack per level. Poured into a 60-column
 * confirm dialog that fills the screen and breaks the border.
 *
 * What a reader needs is the operation that failed plus the reason, which is
 * almost always the *deepest* message in the chain: the `ConnectionError` only
 * says "Failed to connect", while the innermost error says why.
 */

/** Cap so a message can never run away inside a fixed-width dialog. */
const MAX_LENGTH = 140

/**
 * A stack frame as V8 appends it when an Error is interpolated: a name and a
 * parenthesised `file:line:column`. Requiring that location is what keeps this
 * from eating prose — SQL errors legitimately contain "syntax error at or near"
 * and "at line 3", and a bare `\s+at\s+` would truncate them mid-sentence.
 */
const FRAME = /\s+at\s+.*\([^()]*:\d+:\d+\)\s*$/

/**
 * Drop everything after the first line and remove the frame list. An Error
 * interpolated into a template string carries ` at <anonymous> (file:line)` for
 * every frame, which is noise in a dialog.
 */
const firstLine = (text: string): string => {
  const line = text.split("\n", 1)[0] ?? ""
  return line.replace(FRAME, "").trim()
}

/**
 * A library tag prefixing a message: `SqlError: `, `MysqlClient: `,
 * `ConnectionError: `. These name the layer rather than the problem, and the
 * deepest message already implies them.
 *
 * Anchored and PascalCase-only on purpose. Matching any word would eat prose
 * that legitimately contains a colon — "query failed: syntax error" would lose
 * its own subject — while every tag these libraries emit is capitalised.
 */
const TAG = /^\s*(?:\(FiberFailure\)\s*)?(?:[A-Z][A-Za-z0-9]*:\s*)+/

/** Messages nest, so the chain can be several tags deep. */
const stripTags = (text: string): string => {
  let out = text
  for (let match = TAG.exec(out); match !== null; match = TAG.exec(out)) {
    out = out.slice(match[0].length)
  }
  return out.trim()
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const messageOf = (value: unknown): string | null => {
  if (typeof value === "string") {
    const line = firstLine(value)
    return line.length > 0 ? line : null
  }
  if (!isObject(value)) return null
  for (const key of ["message", "sqlMessage", "reason"]) {
    const raw = value[key]
    if (typeof raw === "string") {
      const line = firstLine(raw)
      if (line.length > 0) return line
    }
  }
  /* An Error subclass built without a message still names itself. */
  if (value.name instanceof String || typeof value.name === "string") {
    const name = String(value.name)
    if (name.length > 0 && name !== "Error") return name
  }
  return null
}

/**
 * Walk the chain outward-in, collecting one message per level. `cause` is the
 * usual link; `AggregateError.errors` is how Node reports "tried every address
 * in the pool" and only its first entry is ever interesting.
 */
const collectChain = (cause: unknown, depth = 0): ReadonlyArray<string> => {
  if (depth > 6) return []
  if (typeof cause === "string") {
    const line = firstLine(cause)
    return line.length > 0 ? [line] : []
  }
  if (!isObject(cause)) return []

  const own = messageOf(cause)
  const nested: ReadonlyArray<string> = Array.isArray(cause.errors)
    ? collectChain(cause.errors[0], depth + 1)
    : []
  const inner = cause.cause === undefined || cause.cause === null ? [] : collectChain(cause.cause, depth + 1)

  return own === null ? [...nested, ...inner] : [own, ...nested, ...inner]
}

const clip = (text: string): string => (text.length <= MAX_LENGTH ? text : `${text.slice(0, MAX_LENGTH - 1)}…`)

/**
 * A single line describing `cause`: what failed, and why.
 *
 * `connect ECONNREFUSED 127.0.0.1:3309` alone loses the context that this was a
 * connection attempt, and `Failed to connect` alone loses the reason, so the
 * outermost and innermost distinct messages are joined. Anything unrecognised
 * degrades to a short generic line rather than a dump.
 */
export function describeError(cause: unknown): string {
  const chain = collectChain(cause)
  if (chain.length === 0) return "unknown error"

  const cleaned = chain.map(stripTags).filter((line, index, all) => line.length > 0 && all.indexOf(line) === index)
  if (cleaned.length === 0) return "unknown error"

  const head = cleaned[0]!
  const tail = cleaned[cleaned.length - 1]!
  /* A single distinct message needs no ceremony. */
  if (cleaned.length === 1) return clip(head)
  /* When the outer message already contains the inner one, keep the outer. */
  if (head.includes(tail)) return clip(head)
  return clip(`${head}: ${tail}`)
}
