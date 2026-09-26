import { describe, expect, test } from "bun:test"
import { Effect, Cause, Exit } from "effect"
import { describeError } from "@/errors/describe"
import { runService } from "@/effect/run"
import { ConnectionError } from "@/drivers/types"
import { connectMysql } from "@/drivers/mysql"

describe("describeError", () => {
  test("joins what failed with the reason underneath it", () => {
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:3309")
    const sql = Object.assign(new Error("MysqlClient: Failed to connect"), { cause: inner })
    const conn = new ConnectionError({ engine: "mysql", message: "SqlError: MysqlClient: Failed to connect", cause: sql })
    expect(describeError(conn)).toBe("Failed to connect: connect ECONNREFUSED 127.0.0.1:3309")
  })

  /* `String(cause)` on a driver failure produced a `(FiberFailure)` prefix, an
     inline `[cause]:` object literal and a stack per level — which is what
     filled the confirm dialog and broke its border. */
  test("never returns a multi-line dump", () => {
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:3309")
    const dump = `(FiberFailure) ConnectionError: SqlError: MysqlClient: Failed to connect\n    at <anonymous> (/app/src/drivers/mysql.ts:35:15) {\n  [cause]: SqlError: MysqlClient: Failed to connect\n}`
    expect(describeError(dump)).not.toContain("\n")
    expect(describeError(dump).length).toBeLessThan(160)
  })

  test("takes the first entry of an AggregateError", () => {
    const aggregate = new AggregateError([new Error("connect ETIMEDOUT 10.0.0.5:3306")], "all addresses failed")
    expect(describeError(aggregate)).toContain("connect ETIMEDOUT 10.0.0.5:3306")
  })

  /* A `FiberFailure` carries only `name` and `stack` — no `cause` — so the
     driver error underneath is genuinely unreachable from it and the deep reason
     is lost. `runService` exists to reject with the typed error instead; this
     pins that it actually does. */
  test("runService rejects with the typed error, not a FiberFailure", async () => {
    const rejected = await runService(
      Effect.fail(
        new ConnectionError({
          engine: "mysql",
          message: "SqlError: MysqlClient: Failed to connect",
          cause: new Error("connect ECONNREFUSED 127.0.0.1:3309"),
        })
      )
    ).catch((cause: unknown) => cause)

    expect(rejected).toBeInstanceOf(ConnectionError)

    const line = describeError(rejected)
    expect(line.split("\n")).toHaveLength(1)
    expect(line).toContain("ECONNREFUSED")
    expect(line).not.toContain("FiberFailure")
    expect(line).not.toContain("[cause]")
    expect(line).not.toContain("at <anonymous>")
  })

  test("handles plain values without inventing detail", () => {
    expect(describeError("boom")).toBe("boom")
    expect(describeError(new Error("bad sql"))).toBe("bad sql")
    expect(describeError(undefined)).toBe("unknown error")
    expect(describeError(null)).toBe("unknown error")
    expect(describeError({})).toBe("unknown error")
  })

  test("keeps the outer message when it already contains the inner one", () => {
    const inner = new Error("syntax error at or near \"SELCT\"")
    const outer = new Error('QueryError: query failed: syntax error at or near "SELCT"')
    expect(describeError({ message: outer.message, cause: inner })).toBe(
      'query failed: syntax error at or near "SELCT"'
    )
  })

  test("caps a runaway message", () => {
    const line = describeError("x".repeat(4000))
    expect(line.length).toBeLessThanOrEqual(140)
    expect(line.endsWith("…")).toBe(true)
  })

  test("does not loop on a self-referential cause", () => {
    const looped: Record<string, unknown> = { message: "loop" }
    looped.cause = looped
    expect(describeError(looped)).toBe("loop")
  })
})

describe("describeError against a real driver failure", () => {
  test("a refused MySQL connection reads as one sentence", async () => {
    type Outcome = Exit.Exit<unknown, unknown>
    const exit = (await Effect.runPromiseExit(
      connectMysql({
        engine: "mysql",
        host: "127.0.0.1",
        port: 1,
        user: "root",
        defaultDatabase: "nope",
      } as never).pipe(Effect.scoped)
    )) as Outcome
    expect(Exit.isSuccess(exit)).toBe(false)
    if (Exit.isSuccess(exit)) return
    const failure = Cause.failureOption(exit.cause)
    const err: unknown = failure._tag === "Some" ? failure.value : Cause.squash(exit.cause)

    const line = describeError(err)
    /* The reason is the part a person can act on, and it was previously buried
       under the whole AggregateError tree. */
    expect(line).toContain("ECONNREFUSED")
    expect(line).not.toContain("[cause]")
    expect(line).not.toContain("at <anonymous>")
    expect(line.split("\n")).toHaveLength(1)
    expect(line.length).toBeLessThanOrEqual(140)
  }, 30000)
})
