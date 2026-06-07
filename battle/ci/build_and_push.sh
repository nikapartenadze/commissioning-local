#!/bin/sh
# Build the heavy battle images and push them to the GitLab project registry,
# so the nightly DinD job PULLS them. RUN THIS ON A MACHINE WITH DISK (a dev
# box or dh1) — the ci-runner's DinD storage is too small to build them
# (pipelines 622/624 failed on /var/cache/apt). The nightly only pulls.
#
# Auth: a PAT with read_registry+write_registry scope (NOT a plain api PAT).
#   docker login registry.gitlab.lci.ge -u <user> -p <registry-PAT>
# then:
#   sh battle/ci/build_and_push.sh
#
# cloud:latest is normally refreshed by the CI `refresh-cloud-image` job
# (it just copies the prod image — light enough for the runner). This script
# can also push it if you pass BUILD_CLOUD=1 with the sibling repo present.
set -eu

REG="${REG:-registry.gitlab.lci.ge/commissioning/commissioning-local}"
cd "$(dirname "$0")/.."   # battle/
ROOT="$(cd .. && pwd)"

echo "=== tool ==="
docker build -t "$REG/tool:latest" -f "$ROOT/frontend/Dockerfile" "$ROOT/frontend"
docker push "$REG/tool:latest"

echo "=== plc-sim ==="
docker build -t "$REG/plc-sim:latest" ./plc-sim
docker push "$REG/plc-sim:latest"

if [ "${BUILD_CLOUD:-0}" = "1" ]; then
  echo "=== cloud (from sibling repo) ==="
  docker build -t "$REG/cloud:latest" "$ROOT/../commissioning-cloud"
  docker push "$REG/cloud:latest"
fi

echo "=== done — nightly TOOL_IMAGE/PLC_SIM_IMAGE/CLOUD_IMAGE point at $REG/*:latest ==="
