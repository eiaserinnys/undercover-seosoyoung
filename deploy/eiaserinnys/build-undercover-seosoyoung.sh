#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/eias/services/haniel/services/undercover-seosoyoung"
ENV_FILE="/home/eias/services/undercover-seosoyoung/shared/.env"
SHARED_DIR="/home/eias/services/undercover-seosoyoung/shared"
NODE_VERSION="24.18.0"
NODE_DIR="$SHARED_DIR/node-v${NODE_VERSION}-linux-x64"
NODE_TARBALL="$SHARED_DIR/node-v${NODE_VERSION}-linux-x64.tar.xz"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing undercover-seosoyoung env file: $ENV_FILE" >&2
  exit 1
fi

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  mkdir -p "$SHARED_DIR"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "$NODE_TARBALL"
  tar -xJf "$NODE_TARBALL" -C "$SHARED_DIR"
fi

unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_UNIQUE_ID

export PATH="$NODE_DIR/bin:$PATH"

pnpm --dir "$APP_DIR" install --frozen-lockfile
pnpm --dir "$APP_DIR" build
