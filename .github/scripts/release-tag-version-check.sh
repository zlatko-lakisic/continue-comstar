#!/usr/bin/env bash
# Validate vX.Y.Z-vscode release tag minor parity (odd = pre-release, even = stable).
set -euo pipefail

TAG="${1:?tag name required}"
WANT="${2:?want odd or even}"

if [[ ! "$TAG" =~ ^v([0-9]+)\.([0-9]+)\.[0-9]+-vscode$ ]]; then
  echo "Tag must match vX.Y.Z-vscode (got: $TAG)"
  exit 1
fi

minor="${BASH_REMATCH[2]}"
if [[ "$WANT" == "odd" && $((minor % 2)) -ne 1 ]]; then
  echo "Pre-release tag requires odd minor (got minor=$minor in $TAG)"
  exit 1
fi
if [[ "$WANT" == "even" && $((minor % 2)) -ne 0 ]]; then
  echo "Stable release tag requires even minor (got minor=$minor in $TAG)"
  exit 1
fi

echo "OK: $TAG (minor=$minor, want=$WANT)"
