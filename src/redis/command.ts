/**
 * Small shell-like tokenizer for the `:redis` command console.
 *
 * Redis command arguments routinely contain spaces, quotes, and JSON, so
 * splitting on whitespace would make `SET greeting "hello world"` impossible.
 * This understands single and double quotes plus backslash escapes without
 * pulling in a shell parser.
 */
import { Either } from "effect"

const tokenize = (input: string): Either.Either<ReadonlyArray<string>, string> => {
  const tokens: Array<string> = []
  let current = ""
  let quote: '"' | "'" | null = null
  let escaped = false
  let started = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === "\\") {
      escaped = true
      started = true
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }

  if (escaped) {
    return Either.left("command ends with an unfinished escape")
  }
  if (quote !== null) {
    return Either.left(`unterminated ${quote === '"' ? "double" : "single"} quote`)
  }
  if (started) tokens.push(current)
  if (tokens.length === 0) return Either.left("expected a Redis command")
  return Either.right(tokens)
}

export interface ParsedRedisCommand {
  readonly name: string
  readonly args: ReadonlyArray<string>
  /** Echo form for the result title, e.g. `GET greeting`. */
  readonly display: string
}

export const parseRedisCommand = (input: string): Either.Either<ParsedRedisCommand, string> =>
  Either.flatMap(tokenize(input), tokens => {
    const [name, ...args] = tokens
    if (!name) return Either.left("expected a Redis command")
    return Either.right({
      name: name.toUpperCase(),
      args,
      display: [name, ...args].join(" "),
    })
  })

/** Render a raw Redis reply for the text viewer. */
export const formatRedisReply = (value: unknown): string => {
  if (value === null || value === undefined) return "(nil)"
  if (typeof value === "string") return value.length === 0 ? "(empty string)" : value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  const encoded = JSON.stringify(value, null, 2)
  return encoded === undefined ? String(value) : encoded
}
