#!/bin/sh
# Stop hook: typecheck and run the full test suite before Claude finishes a turn.
# Exit 2 sends the failure back to Claude; stop_hook_active prevents a loop.
input="$(cat)"
case "$input" in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;;
esac
project_dir="$(cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" && pwd -P)"
. "$(dirname "$0")/node-env.sh"
cd "$project_dir" || exit 2

if ! out="$("$bin/tsc" --noEmit 2>&1)"; then
  printf 'Typecheck failed:\n%s\n' "$out" >&2
  exit 2
fi
if ! out="$("$bin/vitest" run 2>&1)"; then
  printf 'The full test suite failed:\n%s\n' "$out" >&2
  exit 2
fi
echo "on-stop: typecheck and full test suite passed"
