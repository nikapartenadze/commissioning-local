#!/bin/sh
# Start ab_server with the generated tag set.
#
#   /gen/tags.txt   one "--tag=NAME:TYPE[dims]" per line (from generate_tags.py)
#   /gen/delay      optional: milliseconds of per-request delay (CIP-saturated
#                   controller profile). Written by the chaos API, picked up on
#                   container restart (env vars can't change across restarts,
#                   a shared-volume file can).
set -eu

TAGS_FILE="${TAGS_FILE:-/gen/tags.txt}"
DELAY_FILE="${DELAY_FILE:-/gen/delay}"

if [ ! -s "$TAGS_FILE" ]; then
    echo "FATAL: $TAGS_FILE missing or empty — run the seeder first" >&2
    exit 1
fi

DELAY_OPT=""
if [ -s "$DELAY_FILE" ]; then
    DELAY_MS="$(head -n1 "$DELAY_FILE" | tr -cd '0-9')"
    if [ -n "$DELAY_MS" ] && [ "$DELAY_MS" -gt 0 ]; then
        DELAY_OPT="--delay=$DELAY_MS"
        echo "plc-sim: CIP-saturation profile, --delay=$DELAY_MS ms"
    fi
fi

TAG_COUNT="$(wc -l < "$TAGS_FILE")"
echo "plc-sim: starting ab_server (ControlLogix, path=1,0) with $TAG_COUNT tags"

# Build the argument list from the tags file (one arg per line, no word
# splitting surprises — names contain ':' and '.').
set -- --plc=ControlLogix --path=1,0
if [ -n "$DELAY_OPT" ]; then set -- "$@" "$DELAY_OPT"; fi
while IFS= read -r line; do
    [ -n "$line" ] && set -- "$@" "$line"
done < "$TAGS_FILE"

exec /usr/local/bin/ab_server "$@"
