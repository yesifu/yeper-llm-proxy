#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v docker >/dev/null || { echo "Docker Engine with Compose v2 is required." >&2; exit 1; }
docker compose version >/dev/null || { echo "Install the Docker Compose v2 plugin." >&2; exit 1; }
args=(--project-directory "$root" -f "$root/compose.gateway.yml")
if [[ -f "$root/.env" ]]; then
  args+=(--env-file "$root/.env")
fi
exec docker compose "${args[@]}" "$@"
