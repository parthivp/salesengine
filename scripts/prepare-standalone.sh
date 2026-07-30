#!/usr/bin/env bash
# Next's standalone output excludes static assets and public/ by design; the
# Dockerfile copies them in explicitly. This does the same for a local run.
#
# `rm -rf` first is deliberate: `cp -r src dest/` on an existing directory nests
# it (static/static), which silently serves a page with no CSS.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public
echo "standalone assets ready"
