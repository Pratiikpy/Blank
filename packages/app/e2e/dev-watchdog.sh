#!/bin/bash
# Restart-on-crash watchdog for the Vite dev server.
# Without this, a single unhandled rejection (ethers 502, Supabase blip)
# kills Node and every subsequent /api/* call dies with ECONNREFUSED.
#
# We also have a process-level guard inside vite-plugin-api.ts that catches
# unhandled rejections, but this watchdog is the second line of defence.
cd "$(dirname "$0")/../../.."

while true; do
  echo "[watchdog $(date +%T)] starting dev server"
  pnpm app:dev > /tmp/dev-server.log 2>&1
  exit_code=$?
  echo "[watchdog $(date +%T)] dev server exited (code=$exit_code), restarting in 3s"
  sleep 3
done
