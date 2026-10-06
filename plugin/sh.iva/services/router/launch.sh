#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PLUGIN_DATA:?PLUGIN_DATA required}"
command -v flock >/dev/null || { echo 'iva-panels requires flock' >&2; exit 1; }
mkdir -p "$PLUGIN_DATA"
exec flock --nonblock --no-fork "$PLUGIN_DATA/router.lock" node server.mjs
