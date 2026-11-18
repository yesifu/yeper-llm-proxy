#!/bin/sh
set -eu

# Passwords stay readable in Compose. Encode them here so @, #, %, spaces and
# other URI delimiters cannot change the meaning of a connection string.
urlencode() {
  printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n' | sed 's/../%&/g'
}

if [ -z "${SQL_DSN:-}" ]; then
  : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
  SQL_DSN="postgresql://$(urlencode "${POSTGRES_USER:-newapi}"):$(urlencode "$POSTGRES_PASSWORD")@${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432}/$(urlencode "${POSTGRES_DB:-newapi}")?sslmode=disable"
  export SQL_DSN
fi

if [ -z "${REDIS_CONN_STRING:-}" ]; then
  : "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"
  REDIS_CONN_STRING="redis://:$(urlencode "$REDIS_PASSWORD")@${REDIS_HOST:-redis}:${REDIS_PORT:-6379}/${REDIS_DB:-0}"
  export REDIS_CONN_STRING
fi

if [ "$#" -gt 0 ] && [ "${1#-}" != "$1" ]; then
  set -- /new-api "$@"
fi
exec "$@"
