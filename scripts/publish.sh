#!/usr/bin/env bash
#
# Publish coding-agent-memory-mcp to npm.
#
# Usage:
#   scripts/publish.sh                 # publish current version (patch by default prompt)
#   scripts/publish.sh patch|minor|major   # bump then publish
#   DRY_RUN=1 scripts/publish.sh       # build + pack only, no publish
#
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-}"
DRY_RUN="${DRY_RUN:-0}"

echo "==> Checking npm auth"
if [ "$DRY_RUN" != "1" ]; then
  npm whoami >/dev/null 2>&1 || {
    echo "Not logged in to npm. Run 'npm login' first." >&2
    exit 1
  }
fi

echo "==> Installing dependencies"
npm install

echo "==> Running tests"
npm test || { echo "Tests failed; aborting." >&2; exit 1; }

echo "==> Clean production build (excludes tests)"
npm run clean
npm run build

if [ -n "$BUMP" ]; then
  echo "==> Bumping version ($BUMP)"
  npm version "$BUMP" -m "release: v%s"
fi

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"
echo "==> Packaging $NAME@$VERSION"
npm pack --dry-run

if [ "$DRY_RUN" = "1" ]; then
  echo "==> DRY_RUN=1 set; skipping publish."
  exit 0
fi

echo "==> Publishing $NAME@$VERSION to npm"
npm publish --access public

echo "==> Published $NAME@$VERSION"
echo "Install with: npm i -g $NAME"
