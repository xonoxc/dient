import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ActiveConnection } from "@/drivers/types"
import { listRabbitConsumers, moveRabbitMessage } from "@/rabbitmq/driver"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const connection = (): ActiveConnection =>
  ({
    id: "rabbit-test",
    engine: "rabbitmq",
    _client: { baseUrl: "http://broker", auth: "Basic test", vhost: "/" },
    _scope: null,
  }) as unknown as ActiveConnection

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

const installFetch = (
  handlers: ReadonlyArray<{ match: (url: string, method: string) => boolean; body?: unknown; status?: number }>
) => {
  const calls: Array<RecordedCall> = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? "GET").toUpperCase()
    const parsedBody = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ url, method, body: parsedBody })
    const handler = handlers.find(item => item.match(url, method))
    if (!handler) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(handler.body ?? {}), {
      status: handler.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  return calls
}

describe("RabbitMQ management driver", () => {
  test("lists consumers for the current vhost", async () => {
    const calls = installFetch([
      {
        match: (url, method) => method === "GET" && url.endsWith("/api/consumers/%2F"),
        body: [{ consumer_tag: "worker-1", queue: { name: "jobs", vhost: "/" }, prefetch_count: 10 }],
      },
    ])

    const consumers = await Effect.runPromise(listRabbitConsumers(connection()))
    expect(consumers).toEqual([{ consumer_tag: "worker-1", queue: { name: "jobs", vhost: "/" }, prefetch_count: 10 }])
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(["GET http://broker/api/consumers/%2F"])
  })

  test("moves the next ready message and preserves payload encoding and properties", async () => {
    const calls = installFetch([
      {
        match: (url, method) => method === "GET" && url.endsWith("/api/queues/%2F/target"),
        body: { name: "target" },
      },
      {
        match: (url, method) => method === "POST" && url.endsWith("/api/queues/%2F/source/get"),
        body: [
          {
            payload: "AAEC",
            payload_encoding: "base64",
            exchange: "events",
            routing_key: "source",
            properties: { content_type: "application/octet-stream", headers: { retry: 1 } },
          },
        ],
      },
      {
        match: (url, method) => method === "PUT" && url.endsWith("/api/exchanges/%2F//publish"),
        body: { routed: true },
      },
    ])

    const result = await Effect.runPromise(moveRabbitMessage(connection(), "source", "target"))
    expect(result.moved).toBe(true)
    expect(result.message?.payload).toBe("AAEC")

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      "GET http://broker/api/queues/%2F/target",
      "POST http://broker/api/queues/%2F/source/get",
      "PUT http://broker/api/exchanges/%2F//publish",
    ])
    expect(calls[1]!.body).toEqual({ count: 1, ackmode: "ack_requeue_false", encoding: "auto" })
    expect(calls[2]!.body).toEqual({
      properties: { content_type: "application/octet-stream", headers: { retry: 1 } },
      routing_key: "target",
      payload: "AAEC",
      payload_encoding: "base64",
    })
  })

  test("checks the destination before consuming the source", async () => {
    const calls = installFetch([])
    const exit = await Effect.runPromiseExit(moveRabbitMessage(connection(), "source", "missing"))
    expect(exit._tag).toBe("Failure")
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(["GET http://broker/api/queues/%2F/missing"])
  })
})
