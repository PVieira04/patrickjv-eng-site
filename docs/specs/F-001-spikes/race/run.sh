#!/usr/bin/env bash
# Race spike for F-001: 20 concurrent bookings for one slot against a local SQLite Durable Object.
# "naive" checks the slot, awaits a simulated Google call, then writes. "safe" claims the slot
# before awaiting. Pass: safe = 1. Run from the repo root: bash docs/specs/F-001-spikes/race/run.sh
set -euo pipefail
cd "$(dirname "$0")"
W=../../../../node_modules/.bin/wrangler
$W dev --port 8799 > /dev/null 2>&1 & PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -s localhost:8799/reset > /dev/null 2>&1 && break; sleep 0.5; done
for mode in naive safe; do
  pids=(); for i in $(seq 1 20); do curl -s "localhost:8799/book?mode=$mode&slot=2026-10-26T10:00Z" -o /dev/null & pids+=($!); done
  wait "${pids[@]}"
  echo "$mode: confirmed bookings for one slot after 20 concurrent requests = $(curl -s "localhost:8799/count?mode=$mode")"
done
