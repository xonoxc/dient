/**
 * RabbitMQ management API driver. RabbitMQ's binary AMQP protocol is designed
 * for application messaging; this interactive explorer uses the optional
 * management plugin's HTTP API for topology and troubleshooting operations.
 */
import { Context, Effect, Layer, Scope } from "effect"
import type { RabbitMqConnectionConfig } from "@/domain"
import type { ActiveConnection } from "@/drivers/types"
import { ConnectionError, QueryError } from "@/drivers/types"
import { describeError } from "@/errors/describe"

const ENGINE = "rabbitmq" as const

export interface RabbitQueue {
  readonly name: string
  readonly vhost: string
  readonly type?: string
  readonly durable?: boolean
  readonly auto_delete?: boolean
  readonly state?: string
  readonly messages?: number
  readonly messages_ready?: number
  readonly messages_unacknowledged?: number
  readonly consumers?: number
  readonly message_stats?: {
    readonly publish_details?: { readonly rate?: number }
    readonly deliver_get_details?: { readonly rate?: number }
  }
  readonly arguments?: Readonly<Record<string, unknown>>
}

export interface RabbitExchange {
  readonly name: string
  readonly vhost: string
  readonly type: string
  readonly durable?: boolean
  readonly auto_delete?: boolean
  readonly internal?: boolean
  readonly message_stats?: {
    readonly publish_in_details?: { readonly rate?: number }
    readonly publish_out_details?: { readonly rate?: number }
  }
}

export interface RabbitBinding {
  readonly source: string
  readonly destination: string
  readonly destination_type: "queue" | "exchange"
  readonly routing_key: string
  readonly properties_key: string
  readonly arguments?: Readonly<Record<string, unknown>>
}

export interface RabbitMessage {
  readonly payload: string
  readonly payload_bytes?: number
  readonly payload_encoding?: "string" | "base64"
  readonly exchange: string
  readonly routing_key: string
  readonly redelivered?: boolean
  readonly message_count?: number
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface RabbitMqDriverService {
  readonly connect: (config: RabbitMqConnectionConfig) => Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope>
  readonly listQueues: (conn: ActiveConnection) => Effect.Effect<ReadonlyArray<RabbitQueue>, QueryError>
  readonly listExchanges: (conn: ActiveConnection) => Effect.Effect<ReadonlyArray<RabbitExchange>, QueryError>
  readonly listBindings: (conn: ActiveConnection) => Effect.Effect<ReadonlyArray<RabbitBinding>, QueryError>
  readonly peekMessages: (
    conn: ActiveConnection,
    queue: string,
    count?: number
  ) => Effect.Effect<ReadonlyArray<RabbitMessage>, QueryError>
  readonly declareQueue: (
    conn: ActiveConnection,
    name: string,
    options?: { durable?: boolean; arguments?: Record<string, unknown> }
  ) => Effect.Effect<void, QueryError>
  readonly deleteQueue: (conn: ActiveConnection, name: string) => Effect.Effect<void, QueryError>
  readonly purgeQueue: (conn: ActiveConnection, name: string) => Effect.Effect<void, QueryError>
  readonly declareExchange: (
    conn: ActiveConnection,
    name: string,
    type: "direct" | "fanout" | "topic" | "headers",
    options?: { durable?: boolean; autoDelete?: boolean }
  ) => Effect.Effect<void, QueryError>
  readonly deleteExchange: (conn: ActiveConnection, name: string) => Effect.Effect<void, QueryError>
  readonly publish: (
    conn: ActiveConnection,
    exchange: string,
    routingKey: string,
    payload: string,
    properties?: Record<string, unknown>
  ) => Effect.Effect<boolean, QueryError>
  readonly bindQueue: (
    conn: ActiveConnection,
    exchange: string,
    queue: string,
    routingKey?: string,
    args?: Record<string, unknown>
  ) => Effect.Effect<void, QueryError>
  readonly unbindQueue: (conn: ActiveConnection, binding: RabbitBinding) => Effect.Effect<void, QueryError>
  readonly disconnect: (conn: ActiveConnection) => Effect.Effect<void>
  readonly isConnected: (conn: ActiveConnection) => Effect.Effect<boolean>
}

export class RabbitMqDriver extends Context.Tag("RabbitMqDriver")<RabbitMqDriver, RabbitMqDriverService>() {}

interface ManagementClient {
  readonly baseUrl: string
  readonly auth: string
  readonly vhost: string
}

const clientOf = (conn: ActiveConnection): ManagementClient => conn._client as ManagementClient
const segment = (value: string): string => encodeURIComponent(value)
const vhostPath = (conn: ActiveConnection): string => segment(clientOf(conn).vhost)

const makeClient = (config: RabbitMqConnectionConfig): ManagementClient => {
  const host = config.host?.trim() || "localhost"
  const safeHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  const scheme = config.tls ? "https" : "http"
  const port = config.port ?? (config.tls ? 15671 : 15672)
  const user = config.user ?? "guest"
  const password = config.password ?? "guest"
  return {
    baseUrl: `${scheme}://${safeHost}:${port}`,
    auth: `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`,
    vhost: config.defaultDatabase?.trim() || "/",
  }
}

const fetchManagement = async <A>(client: ManagementClient, path: string, init: RequestInit = {}): Promise<A> => {
  const response = await fetch(`${client.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: client.auth,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(8000),
  })
  const body = await response.text()
  if (!response.ok) {
    const detail = body.trim().replace(/\s+/g, " ").slice(0, 240)
    throw new Error(`RabbitMQ management API ${response.status}${detail ? `: ${detail}` : ""}`)
  }
  return (body ? JSON.parse(body) : undefined) as A
}

const request = <A>(conn: ActiveConnection, path: string, init?: RequestInit): Effect.Effect<A, QueryError> =>
  Effect.tryPromise({
    try: () => fetchManagement<A>(clientOf(conn), path, init),
    catch: cause => new QueryError({ engine: ENGINE, message: describeError(cause), cause }),
  })

const json = (value: unknown): string => JSON.stringify(value)

export const connectRabbitMq = (
  config: RabbitMqConnectionConfig
): Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = makeClient(config)
    yield* Effect.tryPromise({
      try: () => fetchManagement(client, "/api/overview"),
      catch: cause =>
        new ConnectionError({
          engine: ENGINE,
          message: `${describeError(cause)} (enable RabbitMQ's management plugin and use its HTTP port)`,
          cause,
        }),
    })
    return { id: crypto.randomUUID(), engine: ENGINE, _client: client, _scope: null }
  })

export const listRabbitQueues = (conn: ActiveConnection): Effect.Effect<ReadonlyArray<RabbitQueue>, QueryError> =>
  request(conn, `/api/queues/${vhostPath(conn)}`)

export const listRabbitExchanges = (conn: ActiveConnection): Effect.Effect<ReadonlyArray<RabbitExchange>, QueryError> =>
  request(conn, `/api/exchanges/${vhostPath(conn)}`)

export const listRabbitBindings = (conn: ActiveConnection): Effect.Effect<ReadonlyArray<RabbitBinding>, QueryError> =>
  request(conn, `/api/bindings/${vhostPath(conn)}`)

export const peekRabbitMessages = (
  conn: ActiveConnection,
  queue: string,
  count = 30
): Effect.Effect<ReadonlyArray<RabbitMessage>, QueryError> =>
  request(conn, `/api/queues/${vhostPath(conn)}/${segment(queue)}/get`, {
    method: "POST",
    body: json({
      count: Math.max(1, Math.min(100, count)),
      ackmode: "ack_requeue_true",
      encoding: "auto",
      truncate: 65536,
    }),
  })

export const declareRabbitQueue = (
  conn: ActiveConnection,
  name: string,
  options: { durable?: boolean; arguments?: Record<string, unknown> } = {}
): Effect.Effect<void, QueryError> =>
  request(conn, `/api/queues/${vhostPath(conn)}/${segment(name)}`, {
    method: "PUT",
    body: json({ durable: options.durable ?? true, auto_delete: false, arguments: options.arguments ?? {} }),
  })

export const deleteRabbitQueue = (conn: ActiveConnection, name: string): Effect.Effect<void, QueryError> =>
  request(conn, `/api/queues/${vhostPath(conn)}/${segment(name)}`, { method: "DELETE" })

export const purgeRabbitQueue = (conn: ActiveConnection, name: string): Effect.Effect<void, QueryError> =>
  request(conn, `/api/queues/${vhostPath(conn)}/${segment(name)}/contents`, { method: "DELETE" })

export const declareRabbitExchange = (
  conn: ActiveConnection,
  name: string,
  type: "direct" | "fanout" | "topic" | "headers",
  options: { durable?: boolean; autoDelete?: boolean } = {}
): Effect.Effect<void, QueryError> =>
  request(conn, `/api/exchanges/${vhostPath(conn)}/${segment(name)}`, {
    method: "PUT",
    body: json({
      type,
      durable: options.durable ?? true,
      auto_delete: options.autoDelete ?? false,
      internal: false,
      arguments: {},
    }),
  })

export const deleteRabbitExchange = (conn: ActiveConnection, name: string): Effect.Effect<void, QueryError> =>
  request(conn, `/api/exchanges/${vhostPath(conn)}/${segment(name)}`, { method: "DELETE" })

export const publishRabbitMessage = (
  conn: ActiveConnection,
  exchange: string,
  routingKey: string,
  payload: string,
  properties: Record<string, unknown> = {}
): Effect.Effect<boolean, QueryError> =>
  request<{ routed: boolean }>(conn, `/api/exchanges/${vhostPath(conn)}/${segment(exchange)}/publish`, {
    method: "PUT",
    body: json({ properties, routing_key: routingKey, payload, payload_encoding: "string" }),
  }).pipe(Effect.map(result => result.routed))

export const bindRabbitQueue = (
  conn: ActiveConnection,
  exchange: string,
  queue: string,
  routingKey = "",
  args: Record<string, unknown> = {}
): Effect.Effect<void, QueryError> =>
  request(conn, `/api/bindings/${vhostPath(conn)}/e/${segment(exchange)}/q/${segment(queue)}`, {
    method: "POST",
    body: json({ routing_key: routingKey, arguments: args }),
  })

export const unbindRabbitQueue = (conn: ActiveConnection, binding: RabbitBinding): Effect.Effect<void, QueryError> =>
  request(
    conn,
    `/api/bindings/${vhostPath(conn)}/e/${segment(binding.source)}/q/${segment(binding.destination)}/${segment(binding.properties_key)}`,
    { method: "DELETE" }
  )

export const disconnectRabbitMq = (_conn: ActiveConnection): Effect.Effect<void> => Effect.void

export const isConnectedRabbitMq = (conn: ActiveConnection): Effect.Effect<boolean> =>
  request(conn, "/api/overview").pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

export namespace RabbitMqDriver {
  export const layer: Layer.Layer<RabbitMqDriver> = Layer.succeed(RabbitMqDriver, {
    connect: connectRabbitMq,
    listQueues: listRabbitQueues,
    listExchanges: listRabbitExchanges,
    listBindings: listRabbitBindings,
    peekMessages: peekRabbitMessages,
    declareQueue: declareRabbitQueue,
    deleteQueue: deleteRabbitQueue,
    purgeQueue: purgeRabbitQueue,
    declareExchange: declareRabbitExchange,
    deleteExchange: deleteRabbitExchange,
    publish: publishRabbitMessage,
    bindQueue: bindRabbitQueue,
    unbindQueue: unbindRabbitQueue,
    disconnect: disconnectRabbitMq,
    isConnected: isConnectedRabbitMq,
  })
}
