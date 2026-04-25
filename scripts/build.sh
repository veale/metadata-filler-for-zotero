#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
VERSION=$(jq -r '.version' manifest.json)
OUT="metadata-filler-${VERSION}.xpi"
rm -f "$OUT"
zip -r "$OUT" manifest.json bootstrap.js lib/ content/ locale/ -x "*.DS_Store" "*/.DS_Store"
echo "Built $OUT"
