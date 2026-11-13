#!/usr/bin/env bash
# Unit tests, then a fresh local validator (pump.fun cloned from mainnet, port 8931) and the end-to-end suite.
# ⛔ Other sessions run validators too: only OUR port's validator is ever stopped (memory local-validators-collide-across-sessions).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${LOCAL_RPC_PORT:-8931}"
node --test tests/unit.test.mjs
pid=$(lsof -ti tcp:$PORT -sTCP:LISTEN || true); [[ -n "$pid" ]] && kill $pid && sleep 1
./validator.sh > validator.log 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT
for i in $(seq 1 120); do
  curl -s -m 2 "http://127.0.0.1:$PORT" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && break
  sleep 1
done
node --test tests/chain.test.mjs
