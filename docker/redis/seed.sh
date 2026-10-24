#!/bin/sh
# Seed the sample Redis Stack instance with one key of every supported type.
#
# This runs from the one-shot `redis-seed` compose service. It is idempotent:
# the marker key lives in DB 15, so restarting the stack does not overwrite a
# keyspace you have been experimenting with. Use `docker compose down -v` for a
# clean reseed.
set -eu

HOST="${REDIS_HOST:-redis}"
PORT="${REDIS_PORT:-6379}"

cli() {
  redis-cli -h "$HOST" -p "$PORT" "$@"
}

if [ "$(cli -n 15 EXISTS dient:sample:loaded)" = "1" ]; then
  echo "Redis sample data already loaded; skipping."
  exit 0
fi

# The compose stack owns this Redis instance; reset it so the examples are
# deterministic even if a previous seed was interrupted.
cli FLUSHALL >/dev/null

# Basic strings, including one that is deliberately larger than dient's 64 KB
# read cap so the truncation notice is visible.
cli SET greeting "hello from the dient sample stack" >/dev/null
cli SET "user profile:ada" "Ada Lovelace <ada@example.com>" >/dev/null
cli SET session:demo "temporary-token" EX 3600 >/dev/null

LONG_NOTE=$(cat <<'EOF'
This is a multi-line sample value.

Open it in dient with Enter. The string view wraps long lines and scrolls with
j / k, g / G, Ctrl+f / Ctrl+b and the arrow keys.

The key also exercises UTF-8: café, naïve, 東京, 🚀.
EOF
)
cli SET note:long "$LONG_NOTE" >/dev/null

LARGE_VALUE=$(head -c 70000 /dev/zero | tr '\0' 'x')
cli SET blob:large "$LARGE_VALUE" >/dev/null

# Core collection types.
cli HSET user:1 name "Ada Lovelace" email "ada@example.com" role admin level 7 >/dev/null
cli RPUSH jobs "write tests" "ship the feature" "review the diff" "celebrate" >/dev/null
cli SADD tags redis database tui terminal >/dev/null
cli ZADD leaderboard 42 ada 17 grace 99 alan 63 barbara 5 ken >/dev/null

# Stream cards: field/value pairs with generated IDs.
cli XADD events '*' type login user ada ip 10.0.0.5 >/dev/null
cli XADD events '*' type purchase user grace amount 149.00 currency USD >/dev/null
cli XADD events '*' type logout user ada duration 812 >/dev/null

# RedisJSON (the Redis Stack image ships the module).
cli JSON.SET doc:1 '$' '{"id":1,"name":"Ada Lovelace","active":true,"loginCount":42,"tags":["redis","json","tui"],"profile":{"role":"admin","level":7}}' >/dev/null

# A second logical database, selected with the /1 suffix in the URL.
cli -n 1 SET greeting "hello from Redis database 1" >/dev/null
cli -n 1 HSET user:2 name "Grace Hopper" role operator >/dev/null

# Idempotency marker, deliberately outside the sample databases.
cli -n 15 SET dient:sample:loaded 1 >/dev/null

echo "Redis sample data loaded (DB 0, DB 1; marker in DB 15)."
