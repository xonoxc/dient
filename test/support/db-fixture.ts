import { Effect } from "effect"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { MySqlContainer } from "@testcontainers/mysql"

/**
 * Shared testcontainers fixture: each engine starts once and stays up for the
 * life of the process. Ryuk cleans up containers on exit automatically.
 *
 * Containers are never created by tests directly; tests pull them from
 * the fixture layer and rely on the effect lifecycle to tear everything down.
 * Starting containers is slow (~5–10 s first time), but the one-shot pattern
 * amortises that across every test in the suite.
 */

export const postgresFixture = Effect.acquireRelease(
  Effect.promise(() => new PostgreSqlContainer("postgres:17-alpine").start()),
  (c) => Effect.promise(() => c.stop()),
).pipe(Effect.orDie)

export const mysqlFixture = Effect.acquireRelease(
  Effect.promise(() => new MySqlContainer("mysql:8.4").start()),
  (c) => Effect.promise(() => c.stop()),
).pipe(Effect.orDie)