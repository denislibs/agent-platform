#!/bin/bash
# Supervisor for browserd: restarts it 1 s after it exits, so the sandbox outlives the browser
# (an agent's `pkill node`, an OOM kill). Runs as the only child of tini (`docker run --init`).
# TERM/INT from `docker stop` stop browserd and end the loop at once.
set -u
child=''
on_stop() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  exit 143
}
trap on_stop TERM INT
while :; do
  node /opt/browserd/server.mjs &
  child=$!
  wait "$child"
  echo "supervise: browserd exited ($?), restarting in 1s" >&2
  # Sleep in the background so a signal interrupts `wait` at once instead of after a second.
  sleep 1 &
  child=$!
  wait "$child"
  child=''
done
