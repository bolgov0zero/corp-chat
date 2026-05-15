#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/client/package.json"

CURRENT=$(node -p "require('$PKG').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

PATCH=$((PATCH + 1))
if [ "$PATCH" -ge 10 ]; then
  PATCH=0
  MINOR=$((MINOR + 1))
  if [ "$MINOR" -ge 10 ]; then
    MINOR=0
    MAJOR=$((MAJOR + 1))
  fi
fi

NEW="$MAJOR.$MINOR.$PATCH"

node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PKG'));
  pkg.version = '$NEW';
  fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2) + '\n');
"

echo "$NEW"
