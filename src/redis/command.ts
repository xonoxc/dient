/** Shell-like tokenizer for the `:redis` console: quotes and escapes keep
 *  arguments like `"hello world"` intact without pulling in a shell parser. */
import { Result } from "effect"

const tokenize = (input: string): Result.Result<ReadonlyArray<string>, string> => {
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
    return Result.fail("command ends with an unfinished escape")
  }
  if (quote !== null) {
    return Result.fail(`unterminated ${quote === '"' ? "double" : "single"} quote`)
  }
  if (started) tokens.push(current)
  if (tokens.length === 0) return Result.fail("expected a Redis command")
  return Result.succeed(tokens)
}

export interface ParsedRedisCommand {
  readonly name: string
  readonly args: ReadonlyArray<string>
  /** Echo form for the result title, e.g. `GET greeting`. */
  readonly display: string
}

export const parseRedisCommand = (input: string): Result.Result<ParsedRedisCommand, string> =>
  Result.flatMap(tokenize(input), tokens => {
    const [name, ...args] = tokens
    if (!name) return Result.fail("expected a Redis command")
    return Result.succeed({
      name: name.toUpperCase(),
      args,
      display: [name, ...args].join(" "),
    })
  })

export const formatRedisReply = (value: unknown): string => {
  if (value === null || value === undefined) return "(nil)"
  if (typeof value === "string") return value.length === 0 ? "(empty string)" : value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  const encoded = JSON.stringify(value, null, 2)
  return encoded === undefined ? String(value) : encoded
}
