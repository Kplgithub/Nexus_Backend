#!/usr/bin/env bash
# Runs a CI step and, on failure, surfaces the tail of its output as a GitHub
# annotation so the cause is visible in the run summary without opening logs.
#   scripts/ci-run.sh "<title>" <command...>
set -uo pipefail
title="$1"
shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  # Strip ANSI colours, keep the last 80 lines, encode newlines for the annotation.
  tail -n 80 "$log" | sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' | sed -e 's/%/%25/g' -e 's/\r//g' | awk 'BEGIN{ORS="%0A"} {print}' > "$log.msg"
  echo "::error title=${title} failed::$(cat "$log.msg")"
fi
exit "$status"
