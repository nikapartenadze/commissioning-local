#!/bin/sh
# Pre-build every battle image ONCE and push to the registry so the nightly
# DinD job PULLS instead of building (the 2026-06-06 disk failure: building
# ab_server + the Next cloud + the tool from scratch on the shared ci-runner
# blew its /var/cache). Run this on a machine with registry push rights
# (ci-runner / dh1 / a dev box on the LAN) whenever battle/ images change.
#
#   REGISTRY=registry.lci.ge/battle sh battle/ci/build_and_push.sh
set -eu

REGISTRY="${REGISTRY:-registry.lci.ge/battle}"
cd "$(dirname "$0")/.."   # battle/
ROOT="$(cd .. && pwd)"

build_push() {
  name="$1"; shift
  tag="$REGISTRY/$name:latest"
  echo "=== building $tag ==="
  docker build -t "$tag" "$@"
  docker push "$tag"
}

# Only the THREE heavy images are pre-built (these caused the disk failure):
#   tool    — full Vite+Express build
#   cloud   — full Next.js build
#   plc-sim — compiles ab_server from source (apt + cmake; the worst hog)
# The tiny seeder/crew/chaos/observer (python/node base + a script) are cheap
# enough to build in CI without disk pressure.
build_push tool    -f "$ROOT/frontend/Dockerfile" "$ROOT/frontend"
build_push cloud   "$ROOT/../commissioning-cloud"
build_push plc-sim ./plc-sim

echo "=== done. CI pulls these (set in .gitlab-ci.yml): ==="
echo "  TOOL_IMAGE=$REGISTRY/tool:latest"
echo "  CLOUD_IMAGE=$REGISTRY/cloud:latest"
echo "  PLC_SIM_IMAGE=$REGISTRY/plc-sim:latest"
