#!/bin/sh
# Seed the sample RabbitMQ instance with a small topic-exchange topology.
#
# This runs from the one-shot `rabbitmq-seed` compose service. Declarations are
# idempotent and a sample queue is only filled when it is empty, so restarting
# the stack does not duplicate messages. Use `docker compose down -v` for a
# clean reseed.
set -eu

HOST="${RABBITMQ_HOST:-rabbitmq}"
PORT="${RABBITMQ_PORT:-15672}"
USER="${RABBITMQ_USER:-dient}"
PASSWORD="${RABBITMQ_PASSWORD:-dient}"
VHOST="${RABBITMQ_VHOST:-/}"

EXCHANGE="dient.events"
ORDERS_QUEUE="dient.orders"
NOTIFICATIONS_QUEUE="dient.notifications"

JSON_PROPERTIES='{"content_type":"application/json","delivery_mode":2,"headers":{"source":"dient-samples"}}'
TEXT_PROPERTIES='{"content_type":"text/plain","delivery_mode":2,"headers":{"source":"dient-samples"}}'

admin() {
  rabbitmqadmin \
    --host "$HOST" \
    --port "$PORT" \
    --username "$USER" \
    --password "$PASSWORD" \
    --vhost "$VHOST" \
    --quiet "$@"
}

queue_depth() {
  admin --format tsv list queues name messages 2>/dev/null |
    awk -F '	' -v queue="$1" '$1 == queue { print $2; found = 1 } END { if (!found) print "" }'
}

publish() {
  routing_key="$1"
  payload="$2"
  properties="$3"
  admin publish \
    exchange="$EXCHANGE" \
    routing_key="$routing_key" \
    payload="$payload" \
    properties="$properties" >/dev/null
}

seed_orders() {
  depth="$(queue_depth "$ORDERS_QUEUE")"
  if [ -n "$depth" ] && [ "$depth" -gt 0 ] 2>/dev/null; then
    echo "Queue $ORDERS_QUEUE already has $depth message(s); skipping."
    return
  fi

  publish orders.created \
    '{"orderId":"ORD-1042","customer":"Ada Lovelace","total":149.00,"currency":"USD","status":"created"}' \
    "$JSON_PROPERTIES"
  publish orders.paid \
    '{"orderId":"ORD-1042","customer":"Ada Lovelace","total":149.00,"currency":"USD","status":"paid"}' \
    "$JSON_PROPERTIES"
  publish orders.shipped \
    '{"orderId":"ORD-1043","customer":"Grace Hopper","total":55.50,"currency":"USD","status":"shipped"}' \
    "$JSON_PROPERTIES"
  publish orders.cancelled \
    '{"orderId":"ORD-1044","customer":"Alan Turing","total":89.90,"currency":"USD","status":"cancelled"}' \
    "$JSON_PROPERTIES"
  echo "Published 4 messages to $ORDERS_QUEUE."
}

seed_notifications() {
  depth="$(queue_depth "$NOTIFICATIONS_QUEUE")"
  if [ -n "$depth" ] && [ "$depth" -gt 0 ] 2>/dev/null; then
    echo "Queue $NOTIFICATIONS_QUEUE already has $depth message(s); skipping."
    return
  fi

  publish notifications.email \
    '{"channel":"email","to":"ada@example.com","subject":"Order ORD-1042 confirmed","body":"Thanks for your order."}' \
    "$JSON_PROPERTIES"
  publish notifications.sms \
    '{"channel":"sms","to":"+1-555-0100","body":"Your order ORD-1043 has shipped."}' \
    "$JSON_PROPERTIES"
  publish notifications.push \
    '{"channel":"push","to":"device/grace","title":"Delivery update","body":"Your parcel arrives today."}' \
    "$JSON_PROPERTIES"
  publish notifications.ops \
    'deployment finished: dient-api@2026.10.25' \
    "$TEXT_PROPERTIES"
  echo "Published 4 messages to $NOTIFICATIONS_QUEUE."
}

# Topology: a durable topic exchange feeding one classic queue and one quorum
# queue. Both queues are visible in dient's QUEUES and ROUTES tabs.
admin declare exchange name="$EXCHANGE" type=topic durable=true
admin declare queue name="$ORDERS_QUEUE" durable=true
admin declare queue name="$NOTIFICATIONS_QUEUE" durable=true queue_type=quorum
admin declare binding source="$EXCHANGE" destination="$ORDERS_QUEUE" destination_type=queue routing_key='orders.*'
admin declare binding source="$EXCHANGE" destination="$NOTIFICATIONS_QUEUE" destination_type=queue routing_key='notifications.#'

# Management stats are collected on a timer; give a freshly declared queue a
# moment to report its (empty) depth before publishing.
sleep 1

seed_orders
seed_notifications

echo "RabbitMQ sample topology loaded (exchange $EXCHANGE, vhost $VHOST)."
