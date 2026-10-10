#!/bin/sh
# PostToolUse hook on Edit|Write: typecheck the project and run only the tests
# affected by the changed file. Exit 2 shows the failure to Claude.
input="$(cat)"
project_dir="$(cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" && pwd -P)"

# Any Node can parse the input; the pinned one is selected below.
if ! file="$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    process.stdout.write(JSON.parse(s).tool_input?.file_path ?? "");
  });')"; then
  echo "after-edit: could not read the hook input" >&2
  exit 2
fi
[ -n "$file" ] || exit 0

# Compare real paths, so a symlinked checkout still matches.
dir="$(cd "$(dirname "$file")" 2>/dev/null && pwd -P)" || exit 0
file="$dir/$(basename "$file")"

case "$file" in
  "$project_dir"/test/fixtures/*) exit 0 ;;
  "$project_dir"/src/*.ts | "$project_dir"/test/*.ts | "$project_dir"/schemas/*.ts) scope=related ;;
  "$project_dir"/vitest.config.ts | "$project_dir"/tsconfig*.json | "$project_dir"/package.json) scope=all ;;
  *) exit 0 ;;
esac

. "$(dirname "$0")/node-env.sh"
cd "$project_dir" || exit 2

if ! out="$("$bin/tsc" --noEmit 2>&1)"; then
  printf 'Typecheck failed after editing %s:\n%s\n' "$file" "$out" >&2
  exit 2
fi
if [ "$scope" = related ]; then
  set -- related --run --passWithNoTests "$file"
else
  set -- run
fi
if ! out="$("$bin/vitest" "$@" 2>&1)"; then
  printf 'Tests failed after editing %s:\n%s\n' "$file" "$out" >&2
  exit 2
fi
echo "after-edit: typecheck and $scope tests passed for ${file#"$project_dir"/}"
