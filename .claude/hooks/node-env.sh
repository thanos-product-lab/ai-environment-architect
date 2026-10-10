# Sourced by the hooks after they set project_dir. Puts the Node pinned in
# .node-version first on PATH, because Claude Code may have been started from
# a shell with another Node. Finds it if it is active, or installed by nvm,
# fnm or mise.
pinned="$(tr -d '[:space:]' < "$project_dir/.node-version")"
if [ "$(node --version 2>/dev/null)" != "v$pinned" ]; then
  found=""
  for candidate in \
    "${NVM_DIR:-$HOME/.nvm}/versions/node/v$pinned/bin" \
    "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions/v$pinned/installation/bin" \
    "$HOME/Library/Application Support/fnm/node-versions/v$pinned/installation/bin" \
    "${MISE_DATA_DIR:-$HOME/.local/share/mise}/installs/node/$pinned/bin"; do
    if [ -x "$candidate/node" ]; then found="$candidate"; break; fi
  done
  if [ -z "$found" ]; then
    echo "Node v$pinned (from .node-version) is not active and was not found under nvm, fnm or mise." >&2
    exit 2
  fi
  PATH="$found:$PATH"
fi
bin="$project_dir/node_modules/.bin"
if [ ! -x "$bin/vitest" ] || [ ! -x "$bin/tsc" ]; then
  echo "Dependencies are not installed. Run: corepack pnpm install --frozen-lockfile" >&2
  exit 2
fi
