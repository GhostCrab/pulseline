#!/usr/bin/env bash
# Copy the newest client diagnostics log down from the Pi, read-only.
#
#   bash scripts/pull-log.sh            # newest log for any namespace
#   bash scripts/pull-log.sh u_alice    # a specific namespace
#   PI_HOST=ps-cf bash scripts/pull-log.sh
#
# The log is written by whichever server served the page, so a workout run against
# production leaves it on the Pi and local data/ stays empty. Getting the first one took
# an ad-hoc ssh and a round trip for permission; this is the same thing as one reviewable
# command that only ever reads.
#
# It copies into data/, which is gitignored. Note docs/DEVELOPING.md *Operational notes*:
# data/ was scrubbed from git history once, and if it reaches a public remote again the
# tokens are revoked at spotify.com/account/apps. The log itself carries no tokens by
# construction (see the comment above clog() in workout.html), but it does carry your
# Spotify user id in the filename.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PI_HOST="${PI_HOST:-ps}"
REMOTE_DIR="${REMOTE_DIR:-/opt/pulseline/data}"
NS="${1:-}"

echo "host:   $PI_HOST   (override with PI_HOST=...)"
echo "remote: $REMOTE_DIR"

# Read-only: list what is there, newest first. Fails cleanly if the host is unreachable
# rather than hanging on a password prompt.
listing=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$PI_HOST" \
  "ls -t '$REMOTE_DIR'/clientlog-*.jsonl 2>/dev/null" || true)

if [ -z "$listing" ]; then
  echo
  echo "No clientlog-*.jsonl found on $PI_HOST:$REMOTE_DIR."
  echo "Either no workout has run against production yet, or the host/path is wrong."
  echo "Check with:  ssh $PI_HOST ls -la $REMOTE_DIR"
  exit 1
fi

if [ -n "$NS" ]; then
  remote="$REMOTE_DIR/clientlog-$NS.jsonl"
  echo "$listing" | grep -qx "$remote" || {
    echo
    echo "No log for namespace '$NS'. Available:"
    echo "$listing" | sed 's|.*/|  |'
    exit 1
  }
else
  remote=$(echo "$listing" | head -1)
fi

mkdir -p data
echo "pulling: $remote"
scp -q "$PI_HOST:$remote" data/
local="data/$(basename "$remote")"
echo "wrote:   $local  ($(wc -c < "$local") bytes)"

echo
PY=
for c in python3 python py; do
  if "$c" -c "import sys" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -n "$PY" ]; then
  exec "$PY" scripts/clientlog.py "$local"
fi
echo "Read it with:  python3 scripts/clientlog.py $local"
