#!/usr/bin/env bash
# Zeus installer.
#
#   curl -fsSL https://raw.githubusercontent.com/mjrafg/zeus/main/install.sh | bash
#
# Design rules this script follows:
#   * no root, ever — everything lands under $HOME
#   * idempotent — re-running upgrades in place and never duplicates state
#   * nothing else is installed here: once Zeus is on disk it hands over
#     to `zeus setup`, which asks before it installs or signs in to
#     anything
#   * attached to a terminal it runs that wizard; otherwise it prints the one
#     command to run and stops, because consent cannot be inferred
#   * touches only its own directories, plus one clearly announced PATH line
#   * verifies what it downloaded before installing it
#   * uninstall is one documented command
set -euo pipefail

REPO="${ZEUS_REPO:-mjrafg/zeus}"
VERSION="${ZEUS_VERSION:-main}"
DATA_DIR="${ZEUS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/zeus}"
BIN_DIR="${ZEUS_BIN_DIR:-$HOME/.local/bin}"
NON_INTERACTIVE="${ZEUS_NON_INTERACTIVE:-0}"
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --help|-h) printf 'usage: install.sh [--non-interactive]\n'; exit 0 ;;
  esac
done
VERSIONS_DIR="$DATA_DIR/versions"
RUNTIME_LINK="$DATA_DIR/runtime"

c_b=""; c_g=""; c_y=""; c_r=""; c_x=""
if [ -t 1 ]; then c_b=$'\e[1m'; c_g=$'\e[32m'; c_y=$'\e[33m'; c_r=$'\e[31m'; c_x=$'\e[0m'; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$c_g" "$c_x" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_y" "$c_x" "$*"; }
die()  { printf '%s✗%s %s\n' "$c_r" "$c_x" "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) ;;
  Darwin) warn "macOS is not the primary target; Linux is. Continuing." ;;
  *) die "unsupported operating system: $(uname -s). Linux is required." ;;
esac

say "${c_b}Zeus Setup${c_x}  ${c_b}·${c_x} ${REPO}@${VERSION}"
say "Checking your system..."

# ---- preflight: only what this installer itself cannot do without -----------
# Everything else — provider CLIs, sandboxing, search tools — is the setup
# wizard's business, and it asks first.
missing=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major:-0}" -ge 18 ]; then ok "Node.js $(node -v)"; else
    warn "Node.js $(node -v) found, but 18+ is required"; missing=1; fi
else
  warn "Node.js 18+ not found (required to run Zeus at all)"; missing=1
fi
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || { warn "git not found (required)"; missing=1; }
if [ "$missing" -ne 0 ]; then
  say ""
  say "Zeus itself needs Node.js 18+ and git before it can be installed."
  say "Install them with your platform's package manager, then run this again."
  die "DEPENDENCY_MISSING"
fi

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }
need tar
if command -v curl >/dev/null 2>&1; then DL="curl -fsSL"; elif command -v wget >/dev/null 2>&1; then DL="wget -qO-"; else die "need curl or wget"; fi

# ---- fetch -----------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Work from a directory we are certain to be able to read. Piping this script
# from a shell whose cwd is not readable (a sudo invocation, a deleted
# directory) otherwise breaks `find` in confusing ways.
cd "$tmp"
tarball="$tmp/zeus.tar.gz"
url="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${VERSION}"
case "$VERSION" in v*) url="https://codeload.github.com/${REPO}/tar.gz/refs/tags/${VERSION}" ;; esac

say ""
if [ -n "${ZEUS_TARBALL:-}" ]; then
  # Offline / private-repository install: use an archive already on disk.
  [ -f "$ZEUS_TARBALL" ] || die "ZEUS_TARBALL not found: $ZEUS_TARBALL"
  say "${c_b}Using local archive${c_x} $ZEUS_TARBALL"
  cp "$ZEUS_TARBALL" "$tarball"
else
  say "${c_b}Downloading${c_x} $url"
  if [ -n "${GH_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "Authorization: Bearer $GH_TOKEN" "$url" > "$tarball" || die "download failed"
  else
    $DL "$url" > "$tarball" || die "download failed. For a private repository set GH_TOKEN, or pass ZEUS_TARBALL=/path/to.tar.gz"
  fi
fi
[ -s "$tarball" ] || die "archive is empty"

# Integrity: record what we installed so upgrades and audits can compare.
if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$tarball" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then digest="$(shasum -a 256 "$tarball" | awk '{print $1}')"
else digest="unavailable"; fi
if [ -n "${ZEUS_SHA256:-}" ] && [ "$ZEUS_SHA256" != "$digest" ]; then
  die "checksum mismatch: expected $ZEUS_SHA256, got $digest"
fi
ok "sha256 $digest"

mkdir -p "$tmp/x" && tar xzf "$tarball" -C "$tmp/x"
srcdir="$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -d "$srcdir/src" ] || die "archive does not look like zeus (no src/)"

# ---- install into a versioned directory ------------------------------------
stamp="${VERSION}-$(date +%Y%m%d%H%M%S)"
target="$VERSIONS_DIR/$stamp"
mkdir -p "$VERSIONS_DIR" "$BIN_DIR"
cp -a "$srcdir" "$target"
printf '%s\n' "$digest" > "$target/.sha256"
printf '%s\n' "$VERSION" > "$target/.version"

# A release archive already ships dist/; only a source checkout needs building.
if [ -f "$target/dist/cli.js" ]; then
  ok "prebuilt dist/ shipped in the archive"
elif [ -f "$target/package.json" ] && command -v npm >/dev/null 2>&1 && [ "${ZEUS_SKIP_BUILD:-0}" != "1" ]; then
  say ""
  say "${c_b}Building${c_x} (npm install --omit=optional && npm run build)"
  ( cd "$target" && npm install --silent --no-audit --no-fund >/dev/null 2>&1 && npm run --silent build >/dev/null 2>&1 ) \
    && ok "built dist/" || warn "build skipped or failed; the launcher will run from source via ts-node"
fi

ln -sfn "$target" "$RUNTIME_LINK"
ln -sfn "$RUNTIME_LINK/bin/zeus" "$BIN_DIR/zeus"
chmod +x "$target/bin/zeus" 2>/dev/null || true
ok "runtime  $RUNTIME_LINK -> $target"
ok "cli      $BIN_DIR/zeus"
# Temporary alias so an existing `autopilot` on PATH keeps working. It prints a
# deprecation notice and forwards. Remove it with: rm "$BIN_DIR/autopilot"
if [ -f "$target/bin/autopilot" ]; then
  ln -sfn "$RUNTIME_LINK/bin/autopilot" "$BIN_DIR/autopilot"
  chmod +x "$target/bin/autopilot" 2>/dev/null || true
  ok "alias    $BIN_DIR/autopilot (deprecated, forwards to zeus)"
fi

# A previous install under the old name is reported, never touched. `zeus`
# offers to migrate it on first run.
legacy_data="${XDG_DATA_HOME:-$HOME/.local/share}/ai-autopilot"
if [ -d "$legacy_data" ]; then
  warn "found a previous installation at $legacy_data"
  say "      Nothing there was changed. Zeus will offer to migrate it on first run."
fi

# Keep the last few versions so an upgrade can be rolled back, and no more.
ls -1dt "$VERSIONS_DIR"/*/ 2>/dev/null | tail -n +6 | while read -r old; do rm -rf "$old"; done

# ---- PATH ------------------------------------------------------------------
say ""
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is already on PATH" ;;
  *)
    warn "$BIN_DIR is not on your PATH"
    say "      Add this line to your shell profile:"
    say ""
    say "        export PATH=\"$BIN_DIR:\$PATH\""
    say ""
    say "      (this installer does not edit your shell files)"
    ;;
esac

say ""
say "${c_b}Zeus installed ✓${c_x}"
say "  Uninstall: rm -rf \"$DATA_DIR\" \"$BIN_DIR/zeus\" \"$BIN_DIR/autopilot\""

# ---- hand over to the setup wizard -----------------------------------------
# This script is usually run as `curl … | bash`, so stdin is the script itself.
# The wizard therefore reads the user's answers from /dev/tty, and if there is
# no terminal it is not run at all: an installer must never answer its own
# consent prompts.
zeus_bin="$BIN_DIR/zeus"
if [ "$NON_INTERACTIVE" = "1" ]; then
  say ""
  say "${c_b}Non-interactive install.${c_x} Nothing else was installed and no sign-in was attempted."
  say "  Review what this machine still needs:"
  say ""
  say "    zeus setup --dry-run"
  say ""
  say "  Then, on a terminal:  zeus setup"
elif [ -e /dev/tty ] && (exec 3</dev/tty) 2>/dev/null; then
  say ""
  say "${c_b}Continuing with setup.${c_x}"
  "$zeus_bin" setup </dev/tty || true
else
  say ""
  warn "no terminal available, so setup was not run (nothing was installed or authenticated)"
  say "      Finish on a terminal with:"
  say ""
  say "        zeus setup"
fi
