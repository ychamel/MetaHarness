#!/bin/sh
# MetaHarness installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/ychamel/MetaHarness/main/install.sh | sh
# Clones MetaHarness (to $MH_DIR, default ~/metaharness), installs it, builds the web app, puts
# `mh` on your PATH and runs `mh doctor`. It never installs Node or git for you: it says how.
set -eu

DIR="${MH_DIR:-$HOME/metaharness}"
REPO="${MH_REPO:-https://github.com/ychamel/MetaHarness.git}"

say() { printf '%s\n' "$*"; }
fail() { say "" "✗ $*"; exit 1; }
hint() { case "$(uname -s)" in Darwin) say "brew install $1" ;; *) say "your package manager, e.g. sudo apt install $2" ;; esac; }

command -v git >/dev/null 2>&1 || fail "git isn't installed. Install it with: $(hint git git)"
command -v node >/dev/null 2>&1 || fail "Node isn't installed. MetaHarness needs Node 24 or newer: $(hint node nodejs), or https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || fail "Node $(node -v) is too old: MetaHarness needs 24 or newer. Update it: $(hint node nodejs), or https://nodejs.org"

if [ -d "$DIR/.git" ]; then
  say "Updating MetaHarness in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading MetaHarness to $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"
say "Installing (this takes a minute)"
npm install --no-fund --no-audit
npm run ui:build
npm link >/dev/null 2>&1 || say "Couldn't put mh on your PATH (npm link). Use: node $DIR/src/cli.ts instead of mh."

say "" "Checking what's here:" ""
node src/cli.ts doctor || true
say "" "✓ Installed. Start it with:  mh daemon" "  then open the app with:     mh ui"
