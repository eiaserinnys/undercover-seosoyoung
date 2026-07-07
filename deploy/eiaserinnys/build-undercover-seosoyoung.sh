#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/eias/services/haniel/services/undercover-seosoyoung"
ENV_FILE="/home/eias/services/undercover-seosoyoung/shared/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing undercover-seosoyoung env file: $ENV_FILE" >&2
  exit 1
fi

unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_UNIQUE_ID

pnpm --dir "$APP_DIR" install --frozen-lockfile
pnpm --dir "$APP_DIR" build
