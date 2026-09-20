/**
 * Resolves the engine-specific `ConnectionConfig` a driver needs from the
 * domain model. A stored `Connection` is engine-agnostic (host/port/user/...),
 * so turning it into a runnable config is the bridge between ConfigStore and
 * the driver facade.
 */
import { Effect } from "effect"
import type { Connection, ConnectionConfig, Database } from "@/domain"
import { ConfigError } from "@/config"

export const resolveConnectionConfig = (
  database: Database,
  connection: Connection
): Effect.Effect<ConnectionConfig, ConfigError> =>
  Effect.gen(function* () {
    switch (database.engine) {
      case "postgres":
      case "mysql":
        return {
          engine: database.engine,
          host: connection.host,
          port: connection.port,
          user: connection.user,
          password: connection.password,
          defaultDatabase: connection.defaultDatabase,
        } as ConnectionConfig
      case "sqlite": {
        const filename = connection.filename
        if (!filename) {
          return yield* Effect.fail(
            new ConfigError({ message: `connection ${connection.id} has no file for its SQLite database` })
          )
        }
        return { engine: "sqlite", filename } as ConnectionConfig
      }
    }
  })

/**
 * A short human label for a connection (connections carry no name in the
 * domain model, so the label is derived from its host/file).
 */
export const connectionLabel = (connection: Connection): string => {
  if (connection.filename) {
    return connection.filename.split(/[\\/]/).pop() ?? connection.filename
  }
  const host = connection.host ?? "localhost"
  const port = connection.port ? `:${connection.port}` : ""
  const user = connection.user ? `${connection.user}@` : ""
  return `${user}${host}${port}`
}
