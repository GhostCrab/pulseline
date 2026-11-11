#!/usr/bin/env bash
# Prerequisites and sequence for a device pass on the workout playback path.
#
#   bash scripts/hitl-workout.sh
#
# This used to walk you through the whole sequence prompt by prompt and capture your
# answers. In practice nobody did that: running a workout normally and then reading
# scripts/clientlog.py produced better evidence with less ceremony, because the page
# records what happened whether or not a script is watching.
#
# So what is left is the part that still earns its keep: the prerequisites, which decide
# whether the pass means anything at all, and the sequence, which is easy to shortcut.
# CODING_STANDARDS.md requires a diff touching beginPlayback(), pause handling, completion
# or handoff to state how the whole sequence was re-verified, and nothing automated reaches
# it - docs/agents/spotify-api.md quirk 9 is why: the API reports success throughout a
# silent failure, so only the SDK events and your own ears can tell.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

cat <<'EOF'
PREREQUISITES - the pass proves nothing if any of these is wrong.

  1. Spotify Premium. Without it the SDK fires account_error and the page drops to
     SIMULATED.
  2. The right origin. Locally that is `python3 server.py` and http://127.0.0.1:8888/
     exactly - not localhost, because the redirect URI must match character for
     character.
  3. Logged in WITH the `streaming` scope. A token without it gives a LIVE badge, no
     sound and no error (quirk 8). If you last logged in through an older build, log out
     and back in.
  4. A CLEAN, non-demo workspace. W.live is `key !== "demo" && !ws.dirty`, so a dirty or
     demo workspace runs silent by design and you would be testing the simulated path.
  5. The Spotify app running on this same machine, so the handoff has a device of the
     right type to find.
  6. A second Spotify client you can reach, for the external-pause step.

THE SEQUENCE - in this order. The order is the point: each step has broken
independently of the others.

  start -> pause -> resume -> external pause -> external resume
        -> finish naturally -> completion card -> handoff

  Listen for the interval ding after a RESUME specifically: iOS takes the audio session
  on pause, and that is where the cues have gone silent before.

  Do not use the exit button for the finish - that is a different branch.
EOF

printf '\n>>> Run the workout now. Press Enter when it is done (and the page is closed\n'
printf '    or backgrounded, so the last client-log batch is flushed).\n'
read -r -p "    [Enter] " _

echo
PY=
for c in python3 python py; do
  if "$c" -c "import sys" >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "no working Python found (tried python3, python, py)"; exit 1; }

if ls data/clientlog-*.jsonl >/dev/null 2>&1; then
  exec "$PY" scripts/clientlog.py
fi

cat <<'EOF'
No client log in data/.

If the workout ran against production the log is on the Pi:

  bash scripts/pull-log.sh

Otherwise the page never reached a namespace, which is itself the finding.
EOF
exit 1
