#!/usr/bin/env bash
# The release acceptance of SPEC.md §18 Session 17: on a machine with only Node
# (and git), `npx yuzie@latest init` in a fresh repository completes Journey A.
#
# The packages are packed exactly as `changeset publish` would publish them and
# served from a throwaway registry (verdaccio), so `npx` resolves `yuzie@latest`
# the way it will from npmjs — nothing is published anywhere real.
#
#   scripts/ci/clean-machine.sh http://localhost:8787   # a running server
#
# Needs docker, and the workspace built (`pnpm turbo build`).
set -euo pipefail

server="${1:?usage: clean-machine.sh <server-url>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
registry_port="${REGISTRY_PORT:-4873}"
registry="http://localhost:${registry_port}"
node_image="${NODE_IMAGE:-node:22}"

cleanup() {
  docker rm -f yuzie-registry >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "• packing the packages"
for dir in core store sdk git cli server mcp yuzie; do
  (cd "$root/packages/$dir" && pnpm pack --pack-destination "$work" >/dev/null)
done
ls "$work"

echo "• starting a throwaway registry at $registry"
docker rm -f yuzie-registry >/dev/null 2>&1 || true
docker run -d --name yuzie-registry -p "${registry_port}:4873" \
  -v "$root/scripts/ci/verdaccio.yaml:/verdaccio/conf/config.yaml:ro" \
  verdaccio/verdaccio:6 >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "$registry/-/ping" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$registry/-/ping" >/dev/null

echo "• publishing to it"
cat >"$work/.npmrc" <<NPMRC
registry=$registry
//localhost:${registry_port}/:_authToken=anonymous
NPMRC
for tarball in "$work"/*.tgz; do
  # Provenance needs GitHub's OIDC token; it is the real release's job, not this one's.
  NPM_CONFIG_USERCONFIG="$work/.npmrc" npm publish "$tarball" --provenance=false --access public >/dev/null
done

echo "• a clean ${node_image} container: npx yuzie@latest init"
docker run --rm --network host \
  -v "$root/scripts/journey-a.mjs:/journey-a.mjs:ro" \
  -e npm_config_registry="$registry" \
  -e npm_config_update_notifier=false \
  "$node_image" \
  node /journey-a.mjs --server "$server" --yuzie "npx --yes yuzie@latest"
