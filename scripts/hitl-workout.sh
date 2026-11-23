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

#   bash scripts/hitl-workout.sh resumed
#
# The resumed-app pass: the one step the sequence below cannot reach, because it needs a
# page that has sat in the background for hours. Every other step runs on a fresh page,
# which is why the silent start of 2026-11-15 (the installed iOS app resumed, not
# restarted: play accepted, nothing heard, a force-close cured it) never showed up in a
# pass. It is kept out of commit_msg.py's required steps because it takes overnight.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

find_python() {
  PY=
  for c in python3 python py; do
    if "$c" -c "import sys" >/dev/null 2>&1; then PY="$c"; break; fi
  done
  [ -n "$PY" ] || { echo "no working Python found (tried python3, python, py)"; exit 1; }
}

if [ "${1:-}" = "resumed" ]; then
  cat <<'EOF'
THE RESUMED-APP PASS - against production, on the phone.

  1. Finish a workout as usual (handoff or Done), then leave the app in the background.
     Do NOT force-close it.
  2. Hours later (the failures came after overnight), reopen the app from the home
     screen. Do not force-close it first: the force-close is what hides the bug.
  3. Pick a workout and tap START. Note whether you hear music.

Expected in the log: `staleReload` (the page replaced itself), a new `load`, then a
`begin` whose start ends in `heard`. A `start-not-heard` finding means a reload is not
enough on iOS.
EOF
  printf '\n>>> Press Enter once the START has been tapped (and music heard or not).\n'
  read -r -p "    [Enter] " _
  bash scripts/pull-log.sh >/dev/null || { echo "pull-log.sh failed - run it on its own to see why"; exit 1; }
  find_python
  exec "$PY" scripts/clientlog.py --expect staleReload --expect load --expect heard
fi

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
find_python

# --expect: the sequence ends in a handoff, and a pass that never reached it must not read
# as a clean pass. The handoff was broken for three days while passes that stopped at the
# completion card came back with no findings.
if ls data/clientlog-*.jsonl >/dev/null 2>&1; then
  exec "$PY" scripts/clientlog.py --expect begin --expect playAck --expect handoff
fi

cat <<'EOF'
No client log in data/.

If the workout ran against production the log is on the Pi:

  bash scripts/pull-log.sh

Otherwise the page never reached a namespace, which is itself the finding.
EOF
exit 1
