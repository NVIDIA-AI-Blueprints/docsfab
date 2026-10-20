#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# BYO Brev bootstrap for DocsFab dogfood.
# Run on a fresh CPU instance in *your* Brev account (not a shared nemoclaw box).
# Does not install or print secrets. Inject MODEL_* only after this script exits.
# A fresh clone needs DOCSFAB_GIT_URL; there is no default source repository.
set -euo pipefail

DOCSFAB_GIT_URL="${DOCSFAB_GIT_URL:-}"
DOCSFAB_GIT_REF="${DOCSFAB_GIT_REF:-main}"
DOCSFAB_SOURCE_DIR="${DOCSFAB_SOURCE_DIR:-$HOME/docsfab}"
WORKSPACES_HOME="${WORKSPACES_HOME:-$HOME/workspaces}"
# The runtime's exact Node floor. The launcher refuses anything older, so a
# major-only check would pass a VM that then cannot run DocsFab.
NODE_MIN_VERSION=24.21.0
NODE_MAJOR="${NODE_MIN_VERSION%%.*}"

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# Refuses only when a clone is needed and no URL is set; an existing clone
# updates from its own remote.
require_clone_source() {
  if [[ -z "$DOCSFAB_GIT_URL" && ! -d "$DOCSFAB_SOURCE_DIR/.git" ]]; then
    echo "DOCSFAB_GIT_URL is required: no clone at $DOCSFAB_SOURCE_DIR and no default source repository. Set DOCSFAB_GIT_URL to the repository's Git URL and re-run." >&2
    exit 1
  fi
}

maybe_sudo_apt_install() {
  local pkgs=("$@")
  if need_cmd apt-get; then
    if need_cmd sudo; then
      # Non-interactive sudo (Brev stock images usually allow passwordless sudo).
      if sudo -n true 2>/dev/null; then
        sudo -n apt-get update -qq
        sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${pkgs[@]}"
      else
        sudo apt-get update -qq
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${pkgs[@]}"
      fi
    elif [[ "$(id -u)" -eq 0 ]]; then
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${pkgs[@]}"
    else
      warn "cannot install packages (${pkgs[*]}); install them manually"
      return 1
    fi
  else
    warn "apt-get not found; ensure ${pkgs[*]} are installed"
    return 1
  fi
}

ensure_os_packages() {
  local missing=()
  need_cmd git || missing+=(git)
  need_cmd curl || missing+=(curl)
  need_cmd ca-certificates || true
  need_cmd rg || missing+=(ripgrep)
  need_cmd bwrap || missing+=(bubblewrap)
  need_cmd tar || missing+=(tar)
  if ((${#missing[@]})); then
    log "installing OS packages: ${missing[*]}"
    maybe_sudo_apt_install ca-certificates "${missing[@]}" || true
  fi
  need_cmd git || { echo "git is required" >&2; exit 1; }
}

# Succeeds when the node on PATH reports NODE_MIN_VERSION or later, compared
# numerically by major, minor, then patch; fails when node is absent or older.
node_meets_floor() {
  local have i have_part
  local -a have_parts min_parts
  have="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  IFS=. read -r -a have_parts <<<"$have"
  IFS=. read -r -a min_parts <<<"$NODE_MIN_VERSION"
  for i in "${!min_parts[@]}"; do
    have_part="${have_parts[i]:-0}"
    have_part="${have_part%%[!0-9]*}"
    have_part="${have_part:-0}"
    if ((10#$have_part > 10#${min_parts[i]})); then return 0; fi
    if ((10#$have_part < 10#${min_parts[i]})); then return 1; fi
  done
  return 0
}

ensure_node() {
  if need_cmd node; then
    if node_meets_floor; then
      log "Node.js $(node -v) ok"
      return 0
    fi
    warn "Node.js $(node -v) is older than ${NODE_MIN_VERSION}; attempting NodeSource ${NODE_MAJOR}.x install"
  else
    log "Node.js not found; attempting NodeSource ${NODE_MAJOR}.x install"
  fi
  if need_cmd curl && (need_cmd sudo || [[ "$(id -u)" -eq 0 ]]); then
    if need_cmd sudo && [[ "$(id -u)" -ne 0 ]]; then
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    else
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    fi
    maybe_sudo_apt_install nodejs || true
  fi
  need_cmd node || { echo "install Node.js ${NODE_MIN_VERSION} or later manually, then re-run" >&2; exit 1; }
  if ! node_meets_floor; then
    echo "Node.js ${NODE_MIN_VERSION} or later required; found $(node -v). Install it manually, then re-run." >&2
    exit 1
  fi
}

clone_or_update_docsfab() {
  mkdir -p "$(dirname "$DOCSFAB_SOURCE_DIR")"
  if [[ -d "$DOCSFAB_SOURCE_DIR/.git" ]]; then
    log "updating existing clone at $DOCSFAB_SOURCE_DIR"
    git -C "$DOCSFAB_SOURCE_DIR" fetch --all --tags
    git -C "$DOCSFAB_SOURCE_DIR" checkout "$DOCSFAB_GIT_REF"
    git -C "$DOCSFAB_SOURCE_DIR" pull --ff-only 2>/dev/null || true
  else
    log "cloning $DOCSFAB_GIT_URL @ $DOCSFAB_GIT_REF → $DOCSFAB_SOURCE_DIR"
    git clone "$DOCSFAB_GIT_URL" "$DOCSFAB_SOURCE_DIR"
    git -C "$DOCSFAB_SOURCE_DIR" checkout "$DOCSFAB_GIT_REF"
  fi
  log "DocsFab revision: $(git -C "$DOCSFAB_SOURCE_DIR" rev-parse HEAD)"
}

build_docsfab() {
  log "npm ci + build in $DOCSFAB_SOURCE_DIR"
  (
    cd "$DOCSFAB_SOURCE_DIR"
    npm ci
    npm run build
  )
}

install_wrapper() {
  mkdir -p "$DOCSFAB_SOURCE_DIR/bin" "$WORKSPACES_HOME" "$HOME/bin"
  cat >"$DOCSFAB_SOURCE_DIR/bin/docsfab-dogfood" <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PI_OFFLINE="${PI_OFFLINE:-0}"
# brev exec is a non-login shell — keep this wrapper self-contained.
exec node "$ROOT/dist/launcher.js" "$@"
WRAP
  chmod +x "$DOCSFAB_SOURCE_DIR/bin/docsfab-dogfood"
  ln -sfn "$DOCSFAB_SOURCE_DIR/bin/docsfab-dogfood" "$HOME/bin/docsfab-dogfood" 2>/dev/null || true
  # Tip for interactive shells; brev exec callers should still use bash -lc or PATH=.
  if [[ -f "$HOME/.bashrc" ]] && ! grep -q 'docsfab-run/bin' "$HOME/.bashrc" 2>/dev/null; then
    printf '\n# DocsFab dogfood (brev)\nexport PATH="$HOME/docsfab/bin:$HOME/bin:$PATH"\n' >>"$HOME/.bashrc"
  fi
}

print_next_steps() {
  cat <<EOF

Bootstrap complete.

Next (on this instance or via: brev exec NAME -- bash -lc '...'):
  1. Copy a mode-600 env file with MODEL_* (do not put keys on brev exec argv).
  2. Clone a target repo, e.g.:
       git clone --depth 1 <target-url> $WORKSPACES_HOME/target
  3. Run offline / read-only checks:
       export PATH="$DOCSFAB_SOURCE_DIR/bin:$HOME/bin:\$PATH"
       docsfab-dogfood test
       docsfab-dogfood doctor
       docsfab-dogfood run audit --repo $WORKSPACES_HOME/target
  4. From your laptop when idle: brev stop <instance>  or  brev delete <instance>

See deployment/brev/README.md (BYO account, CPU SKU, brev exec footguns).
EOF
}

main() {
  log "BYO Brev DocsFab bootstrap (no secrets)"
  require_clone_source
  ensure_os_packages
  ensure_node
  clone_or_update_docsfab
  build_docsfab
  install_wrapper
  if need_cmd bwrap; then
    log "bwrap present"
  else
    warn "bwrap missing — some validation/publish paths will fail closed until bubblewrap is installed"
  fi
  print_next_steps
}

main "$@"
