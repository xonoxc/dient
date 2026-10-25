/**
 * One-line connection strings, the primary way a connection (a database) gets
 * created. The user pastes whatever they have — a `postgres://`/`mysql://`/
 * `redis://`/`amqp://` URL, or a filesystem path for SQLite — and the parser resolves it
 * to an engine, its parameters, and a display name taken from the tail of the
 * string (`…/some_db` → `some_db`). When a server URL carries no database path,
 * the caller is expected to ask for the name in a follow-up prompt.
 *
 * Parser is intentionally permissive: anything with no scheme is treated as a
 * SQLite path, because that is the local-file case users paste most. Every
 * other form returns `null` so the settings form can toast a clear failure.
 */
import { basename, extname } from "node:path"

export type ConnectionString =
  | { readonly engine: "sqlite"; readonly filename: string; readonly name: string }
  | {
      readonly engine: "postgres" | "mysql"
      readonly host: string
      readonly port?: number
      readonly user?: string
      readonly password?: string
      readonly defaultDatabase?: string
      /** Database/display name from the URL tail, absent when the URL had none. */
      readonly name?: string
    }
  | {
      readonly engine: "redis"
      readonly host: string
      readonly port?: number
      readonly user?: string
      readonly password?: string
      /** Redis logical database index, as a string (`"0"` by default). */
      readonly defaultDatabase?: string
      readonly tls?: boolean
      /** Always present: a Redis URL without a path still names a server. */
      readonly name: string
    }
  | {
      readonly engine: "rabbitmq"
      readonly host: string
      /** RabbitMQ management API port, not the AMQP protocol port. */
      readonly port?: number
      readonly user?: string
      readonly password?: string
      readonly defaultDatabase?: string
      readonly tls?: boolean
      readonly name: string
    }

const SCHEME = /^([a-z][a-z0-9+.-]*):/

const decodeComponent = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const tailName = (input: string): string =>
  basename(input)
    .replace(extname(basename(input)), "")
    .trim()

/** Parse a `postgres://`/`mysql://` URL into engine parameters. */
const parseServerUrl = (engine: "postgres" | "mysql", rest: string): ConnectionString | null => {
  let url: URL
  try {
    /* `rest` is scheme-less (we sliced it off already); the URL constructor
     * needs an absolute input, so rebuild the scheme before parsing. */
    url = new URL(`${engine}:${rest}`)
  } catch {
    return null
  }

  const name =
    url.pathname && url.pathname !== "/"
      ? decodeURIComponent(
          url.pathname
            .replace(/^\/+|\/+$/g, "")
            .split("/")
            .at(-1) ?? ""
        ).trim()
      : undefined

  return {
    engine,
    host: url.hostname || "localhost",
    ...(url.port ? { port: Number(url.port) } : {}),
    ...(url.username ? { user: decodeComponent(url.username) } : {}),
    ...(url.password ? { password: decodeComponent(url.password) } : {}),
    ...(name ? { defaultDatabase: name, name } : {}),
  }
}

/**
 * Redis URLs put the logical database index in the path, not a database name:
 * `redis://host:6379/2`. `rediss://` (and `valkeys://`) enable TLS. The display
 * name is derived from host/port/index because there is no path name to borrow.
 */
const parseRedisUrl = (rest: string, tls: boolean): ConnectionString | null => {
  let url: URL
  try {
    url = new URL(`${tls ? "rediss" : "redis"}:${rest}`)
  } catch {
    return null
  }

  const host = url.hostname || "localhost"
  const port = url.port ? Number(url.port) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null

  const path = url.pathname.replace(/^\/+|\/+$/g, "")
  if (path && !/^\d+$/.test(path)) return null
  const defaultDatabase = path || undefined
  const displayPort = port ?? 6379
  const dbSuffix = defaultDatabase && defaultDatabase !== "0" ? `/${defaultDatabase}` : ""

  return {
    engine: "redis",
    host,
    ...(port !== undefined ? { port } : {}),
    ...(url.username ? { user: decodeComponent(url.username) } : {}),
    ...(url.password ? { password: decodeComponent(url.password) } : {}),
    ...(defaultDatabase ? { defaultDatabase } : {}),
    ...(tls ? { tls: true } : {}),
    name: `${host}:${displayPort}${dbSuffix}`,
  }
}

/**
 * RabbitMQ's AMQP URLs identify the broker endpoint. Dient talks to the
 * RabbitMQ management HTTP API, so AMQP ports map to its conventional
 * management ports. `rabbitmq://` is the direct management-port form for
 * installations that expose the API on a custom port.
 */
const parseRabbitUrl = (kind: string, rest: string): ConnectionString | null => {
  const tls = kind === "amqps"
  const protocol = kind === "rabbitmq" ? "amqp" : kind
  let url: URL
  try {
    url = new URL(`${protocol}:${rest}`)
  } catch {
    return null
  }

  const host = url.hostname || "localhost"
  const givenPort = url.port ? Number(url.port) : undefined
  if (givenPort !== undefined && (!Number.isInteger(givenPort) || givenPort < 1 || givenPort > 65535)) return null
  const managementPort =
    kind === "rabbitmq"
      ? (givenPort ?? (tls ? 15671 : 15672))
      : givenPort === 15672 || givenPort === 15671
        ? givenPort
        : tls
          ? 15671
          : 15672

  let vhost = "/"
  if (url.pathname && url.pathname !== "/") {
    try {
      vhost = decodeURIComponent(url.pathname.replace(/^\//, "")) || "/"
    } catch {
      return null
    }
  }
  const name = `${host}:${managementPort}${vhost !== "/" ? `/${vhost}` : ""}`
  return {
    engine: "rabbitmq",
    host,
    port: managementPort,
    ...(url.username ? { user: decodeComponent(url.username) } : {}),
    ...(url.password ? { password: decodeComponent(url.password) } : {}),
    defaultDatabase: vhost,
    ...(tls ? { tls: true } : {}),
    name,
  }
}

export const parseConnectionString = (input: string): ConnectionString | null => {
  const raw = input.trim()
  if (!raw) return null

  const scheme = raw.match(SCHEME)
  if (!scheme) {
    /* No scheme → treat as a filesystem path for SQLite. */
    return {
      engine: "sqlite",
      filename: raw,
      name: tailName(raw),
    }
  }

  const kind = scheme[1]!.toLowerCase()
  const rest = raw.slice(scheme[0]!.length)

  if (kind === "postgres" || kind === "postgresql") return parseServerUrl("postgres", rest)
  if (kind === "mysql") return parseServerUrl("mysql", rest)
  if (kind === "amqp" || kind === "amqps" || kind === "rabbitmq") {
    return parseRabbitUrl(kind, rest)
  }
  if (kind === "redis" || kind === "rediss" || kind === "valkey" || kind === "valkeys") {
    return parseRedisUrl(rest, kind === "rediss" || kind === "valkeys")
  }

  if (kind === "sqlite" || kind === "file") {
    const filename = rest.replace(/^\/\//, "").trim()
    if (!filename) return null
    return {
      engine: "sqlite",
      filename,
      name: tailName(filename),
    }
  }

  return null
}

/** Connection parameters for the postgres/mysql config shape. */
export const namedDatabase = (parsed: Extract<ConnectionString, { engine: "postgres" | "mysql" }>, name: string) => ({
  engine: parsed.engine,
  name,
  defaultDatabase: parsed.defaultDatabase ?? name,
})
