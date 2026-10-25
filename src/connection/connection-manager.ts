/**
 * ConnectionManager owns the lifecycle of every open database connection.
 *
 * It is the only component that talks to `DatabaseDriver` or `RedisDriver` on
 * the app's behalf: screens and hooks ask the manager to "connect this
 * connection id" and then run queries through it, so exactly one place caches
 * live connections and knows which engine each belongs to.
 *
 * Lifecycle rules:
 *   - `connect` is lazy and idempotent (an already-open connection is reused).
 *   - A failed connect is remembered so the sidebar can show an error dot and
 *     a retry replaces the failed entry.
 *   - `query` connects on demand, so a screen can run SQL without managing
 *     the connection itself.
 *   - `disconnect` best-effort closes the engine client and drops the entry.
 */
import { ConfigStore, ConfigError } from "@/config"
import { DatabaseDriver } from "@/drivers/database-driver"
import { RedisDriver } from "@/drivers/redis"
import { RabbitMqDriver } from "@/rabbitmq/driver"
import { ConnectionError, QueryError } from "@/drivers/types"
import { resolveConnectionConfig } from "@/connection/config"
import { Context, Effect, Layer, Ref, Schedule } from "effect"

import type { ActiveConnection, QueryResult } from "@/drivers/types"
import type { Connection, ConnectionId, Database } from "@/domain"

export type ConnectionStatus = "connected" | "disconnected" | "error"

export interface ManagedConnection {
  readonly id: ConnectionId
  readonly connection: Connection
  readonly database: Database
  readonly active: ActiveConnection
}

export interface ConnectionManagerService {
  readonly connect: (id: ConnectionId) => Effect.Effect<ActiveConnection, ConnectionError | ConfigError>
  readonly disconnect: (id: ConnectionId) => Effect.Effect<void>
  readonly isConnected: (id: ConnectionId) => Effect.Effect<boolean>
  readonly statusOf: (id: ConnectionId) => Effect.Effect<ConnectionStatus>
  readonly query: (
    id: ConnectionId,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<QueryResult, QueryError | ConnectionError | ConfigError>
  /** Connects, pings, and tears down. Retries transient failures (host still
      booting, flaky network) up to 3 attempts with backoff and never fails —
      the result is just `false`. */
  readonly pingConnection: (database: Database, connection: Connection) => Effect.Effect<boolean>
  readonly activeConnections: () => Effect.Effect<ReadonlyArray<ManagedConnection>>
}

interface OpenSlots {
  readonly active: Map<ConnectionId, ManagedConnection>
  readonly failed: Map<ConnectionId, ConnectionError | ConfigError>
}

const emptySlots = (): OpenSlots => ({ active: new Map(), failed: new Map() })

export class ConnectionManager extends Context.Tag("ConnectionManager")<
  ConnectionManager,
  ConnectionManagerService
>() {}

const findByDatabase = (
  store: ConfigStoreServiceRef,
  id: ConnectionId
): Effect.Effect<{ connection: Connection; database: Database }, ConfigError> =>
  Effect.gen(function* () {
    for (const project of yield* store.listProjects()) {
      for (const database of yield* store.listDatabases(project.id)) {
        for (const connection of yield* store.listConnections(database.id)) {
          if (connection.id === id) {
            return { connection, database }
          }
        }
      }
    }
    return yield* Effect.fail(new ConfigError({ message: `no connection with id ${id}` }))
  })

type ConfigStoreServiceRef = import("@/config").ConfigStoreService

export namespace ConnectionManager {
  export const layer: Layer.Layer<
    ConnectionManager,
    never,
    ConfigStore | DatabaseDriver | RedisDriver | RabbitMqDriver
  > = Layer.effect(
    ConnectionManager,
    Effect.gen(function* () {
      const store = yield* ConfigStore
      const driver = yield* DatabaseDriver
      const redis = yield* RedisDriver
      const rabbitmq = yield* RabbitMqDriver
      const slots = yield* Ref.make(emptySlots())

      const open = (id: ConnectionId) =>
        Effect.gen(function* () {
          const found = yield* findByDatabase(store, id)
          const config = yield* resolveConnectionConfig(found.database, found.connection)
          /* drivers mint their own internal scope; connect only needs an ambient
             scope for the construction itself, so this stays runnable from
             hooks (`Effect.runPromise`) that live outside any scope. */
          const active =
            config.engine === "redis"
              ? yield* Effect.scoped(redis.connect(config))
              : config.engine === "rabbitmq"
                ? yield* Effect.scoped(rabbitmq.connect(config))
                : yield* Effect.scoped(driver.connect(config))
          yield* Ref.update(slots, s => {
            s.active.set(id, { id, connection: found.connection, database: found.database, active })
            s.failed.delete(id)
            return s
          })
          return active
        })

      const connect = (id: ConnectionId) =>
        Effect.gen(function* () {
          const existing = yield* slots.pipe(
            Ref.get,
            Effect.map(s => s.active.get(id))
          )
          if (existing) return existing.active
          return yield* open(id).pipe(
            Effect.tapError(e =>
              Ref.update(slots, s => {
                s.failed.set(id, e)
                s.active.delete(id)
                return s
              })
            )
          )
        })

      const disconnect = (id: ConnectionId) =>
        Effect.gen(function* () {
          const current = yield* slots.pipe(
            Ref.get,
            Effect.map(s => s.active.get(id))
          )
          if (current) {
            const close =
              current.active.engine === "redis"
                ? redis.disconnect
                : current.active.engine === "rabbitmq"
                  ? rabbitmq.disconnect
                  : driver.disconnect
            yield* close(current.active).pipe(Effect.catchAll(() => Effect.void))
          }
          yield* Ref.update(slots, s => {
            s.active.delete(id)
            s.failed.delete(id)
            return s
          })
        })

      return {
        connect,
        disconnect,
        isConnected: id =>
          slots.pipe(
            Ref.get,
            Effect.flatMap(s => {
              const entry = s.active.get(id)
              if (!entry) return Effect.succeed(false)
              const check =
                entry.active.engine === "redis"
                  ? redis.isConnected
                  : entry.active.engine === "rabbitmq"
                    ? rabbitmq.isConnected
                    : driver.isConnected
              return check(entry.active).pipe(Effect.catchAll(() => Effect.succeed(false)))
            })
          ),

        statusOf: id =>
          slots.pipe(
            Ref.get,
            Effect.flatMap(s => {
              if (s.failed.has(id)) return Effect.succeed("error" as const)
              const entry = s.active.get(id)
              if (!entry) return Effect.succeed("disconnected" as const)
              /* the entry is live; a dead session is reported as an error so a retry replaces it */
              const check =
                entry.active.engine === "redis"
                  ? redis.isConnected
                  : entry.active.engine === "rabbitmq"
                    ? rabbitmq.isConnected
                    : driver.isConnected
              return check(entry.active).pipe(Effect.map(ok => (ok ? "connected" : "error") as ConnectionStatus))
            })
          ),

        query: (id, sql, params) =>
          Effect.gen(function* () {
            const active = yield* connect(id)
            if (active.engine === "redis" || active.engine === "rabbitmq") {
              return yield* Effect.fail(
                new QueryError({
                  engine: active.engine,
                  message: `SQL queries are not supported on a ${active.engine} connection`,
                })
              )
            }
            return yield* driver.query(active, sql, params).pipe(Effect.mapError(e => e as QueryError))
          }),

        pingConnection: (database, connection) =>
          Effect.gen(function* () {
            const config = yield* resolveConnectionConfig(database, connection)
            const attempt = Effect.scoped(
              Effect.gen(function* () {
                const active =
                  config.engine === "redis"
                    ? yield* redis.connect(config)
                    : config.engine === "rabbitmq"
                      ? yield* rabbitmq.connect(config)
                      : yield* driver.connect(config)
                /* close the probe session; the app's real connections live in
                   the open-slot cache, not in pings */
                if (config.engine === "redis") {
                  yield* redis.disconnect(active).pipe(Effect.catchAll(() => Effect.void))
                } else if (config.engine === "rabbitmq") {
                  yield* rabbitmq.disconnect(active).pipe(Effect.catchAll(() => Effect.void))
                } else {
                  yield* driver.disconnect(active).pipe(Effect.catchAll(() => Effect.void))
                }
                return true
              })
            )
            const outcome = yield* attempt
              .pipe(Effect.retry(Schedule.intersect(Schedule.recurs(2), Schedule.exponential("500 millis"))))
              .pipe(Effect.timeout("6 seconds"))
            return outcome
          }).pipe(Effect.catchAll(() => Effect.succeed(false))),

        activeConnections: () =>
          slots.pipe(
            Ref.get,
            Effect.map(s => [...s.active.values()])
          ),
      }
    })
  )
}
