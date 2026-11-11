#!/usr/bin/env bash
# Human-in-the-loop verification pass for the workout playback path.
#
#   bash scripts/hitl-workout.sh
#
# WHY THIS IS A SCRIPT AND NOT A TEST
#
# CODING_STANDARDS.md requires a diff touching workout.html's beginPlayback(), pause
# handling, completion or handoff to state how the whole sequence was re-verified:
# start -> pause -> external pause -> finish -> completion card -> handoff.
#
# No automated seam reaches that sequence. docs/agents/spotify-api.md quirk 9 is why:
# `PUT /me/player/play` returns 204 and the server reports is_playing:true even when the
# in-browser player produces nothing, so a browser-driving agent would see success during
# the exact failure that matters. Only the SDK events say otherwise, and only your ears
# confirm audio.
#
# So this script does the two things automation can do: it keeps you to the full sequence
# in order, and it captures the client diagnostics for just this pass and runs them
# through scripts/clientlog.py. What you get at the end is a report, not a claim.
#
# The log is snapshotted by byte offset before the run, so findings cover only this pass.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PY=
for c in python3 python py; do
  if "$c" -c "import sys" >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "no working Python found (tried python3, python, py)"; exit 1; }

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

hr() { printf '\n%s\n' "------------------------------------------------------------"; }

# ---------------------------------------------------------------- prerequisites

hr
cat <<'EOF'
PREREQUISITES - the run proves nothing if any of these is wrong.

  1. Spotify Premium. The in-app player needs it; without it the SDK fires
     account_error and workout.html drops to SIMULATED.
  2. The server is running and you are on the matching origin. Locally that is
     `python3 server.py` and http://127.0.0.1:8888/ exactly - not localhost, because
     the Spotify redirect URI must match character for character.
  3. You are logged in with the `streaming` scope. If you last logged in through an
     older build, log out and back in: a token without it produces LIVE badge, no
     sound, no error (spotify-api.md quirk 8).
  4. The workspace is CLEAN and is not the demo. W.live is
     `key !== "demo" && !ws.dirty`, so a dirty or demo workspace runs silent by
     design and you would be testing the simulated path.
  5. The Spotify app is running on this same machine, so handoff has a device of the
     right type to find. On a desktop that means device type "Computer".
  6. A second Spotify client you can reach (phone, another browser, the desktop app)
     for the external-pause step.
EOF

capture ENV_KIND "Which environment? (local / pi)"
capture TARGET "Which play-through target are you testing? (sdk = this app / connect = Spotify app)"
capture PREREQS_OK "Are all six prerequisites satisfied? (y/n)"
if [ "$PREREQS_OK" != "y" ]; then
  echo
  echo "Stopping: fix the prerequisites first, or the pass will produce a false green."
  exit 1
fi

# ------------------------------------------------------------ locate the log file

if [ "$ENV_KIND" = "pi" ]; then
  capture PI_HOST "ssh host for the Pi (e.g. ps)"
  capture NS "namespace (u_<spotify-id>), or '?' to list what is there"
  if [ "$NS" = "?" ]; then
    ssh "$PI_HOST" 'ls -la /opt/pulseline/data/clientlog-*.jsonl' || true
    capture NS "namespace (u_<spotify-id>)"
  fi
  LOG_REMOTE="/opt/pulseline/data/clientlog-${NS}.jsonl"
  BEFORE=$(ssh "$PI_HOST" "wc -c < '$LOG_REMOTE' 2>/dev/null || echo 0")
else
  if ! ls data/clientlog-*.jsonl >/dev/null 2>&1; then
    echo
    echo "No data/clientlog-*.jsonl yet. That is expected on a fresh clone: the file is"
    echo "created the first time workout.html flushes events. Run the pass anyway; this"
    echo "script will pick the file up afterwards."
    NS=""
  else
    ls -la data/clientlog-*.jsonl
    capture NS "namespace (u_<spotify-id>) from the list above"
  fi
  LOG_LOCAL="data/clientlog-${NS}.jsonl"
  BEFORE=$( [ -f "$LOG_LOCAL" ] && wc -c < "$LOG_LOCAL" || echo 0 )
fi
BEFORE=$(printf '%s' "$BEFORE" | tr -d '[:space:]')
echo "    log size before this pass: ${BEFORE} bytes"

# --------------------------------------------------------------------- the sequence

hr
echo "THE SEQUENCE - do these in order. Do not skip a step even if it looks fine."

step "Open workout.html and pick the workspace you are testing. Do not press START yet."
capture BADGE_ARMED "What does the badge read before you start? (LIVE / SIMULATED / other)"

step "Press START."
capture AUDIBLE_START "Can you HEAR music? This is the one thing nothing else can check. (y/n)"
capture BADGE_START "What does the badge read now? (LIVE / SIMULATED / other)"
capture CLOCK_START "Is the countdown advancing? (y/n)"

step "Let it run through at least one interval boundary, so a cue fires."
capture CUE_HEARD "Did you hear the interval ding? (y/n)"

step "Press PAUSE."
capture PAUSE_AUDIO "Did the music stop? (y/n)"
capture PAUSE_CLOCK "Did the countdown stop? (y/n)"
capture PAUSE_BTN "What does the button read now? (START / PAUSE / RESUME / other)"

step "Press RESUME. (The iOS audio session is taken on pause, so cues after a resume are a known fragile point.)"
capture RESUME_AUDIO "Did the music resume? (y/n)"
capture RESUME_CUE "Let another interval boundary pass - did the ding still fire? (y/n)"

step "EXTERNAL PAUSE: pause playback from the OTHER Spotify client, not from this page."
capture EXT_PAUSE_SEEN "Did this page notice and show itself as paused? (y/n)"
capture EXT_PAUSE_SECS "Roughly how many seconds until it noticed? (the connect poll runs every 5s; the SDK path should be immediate)"

step "EXTERNAL RESUME: resume from that other client."
capture EXT_RESUME_SEEN "Did this page pick it back up? (y/n)"

step "Let the workout run to the end, or scrub near the end and let it finish naturally. Do NOT use the exit button - that is a different branch."
capture MODAL_SHOWN "Did the WORKOUT COMPLETE card appear? (y/n)"
capture MODAL_STATS "Do the stats on the card look right? (y/n/na)"
capture COOLDOWN_AUDIO "Is the music still playing after completion? It should be - cooldown is deliberate. (y/n)"

step "Press the handoff button ('Continue in Spotify on ...')."
capture HANDOFF_OK "Did playback move to the Spotify app? (y/n)"
capture HANDOFF_SEAMLESS "Did the music carry on from the same point WITHOUT repeating a few seconds? (y/n)"
capture HANDOFF_NOTE "Anything else you noticed (or 'none'):"

# ------------------------------------------------------------- collect the evidence

hr
echo "Collecting client diagnostics for this pass..."
echo "(events are flushed on a 1.5s timer and on pagehide - close or background the"
echo " workout page now so the last batch is sent.)"
step "Closed or backgrounded the workout page?"

OUT="${TMPDIR:-/tmp}/pulseline-hitl-$(date +%Y%m%d-%H%M%S).jsonl"

if [ "$ENV_KIND" = "pi" ]; then
  ssh "$PI_HOST" "tail -c +$((BEFORE + 1)) '$LOG_REMOTE' 2>/dev/null" > "$OUT" || true
else
  if [ -n "${NS:-}" ] && [ -f "data/clientlog-${NS}.jsonl" ]; then
    tail -c +$((BEFORE + 1)) "data/clientlog-${NS}.jsonl" > "$OUT" || true
  elif ls data/clientlog-*.jsonl >/dev/null 2>&1; then
    # namespace was unknown before the run; the file exists now, so take all of it.
    cat data/clientlog-*.jsonl > "$OUT"
  else
    : > "$OUT"
  fi
fi

echo "    new events written to: $OUT"
hr
echo "FINDINGS"
echo
CLOG_STATUS=0
"$PY" scripts/clientlog.py "$OUT" || CLOG_STATUS=$?

# ------------------------------------------------------------------- what you said

hr
printf 'ENV=%s\nTARGET=%s\n' "$ENV_KIND" "$TARGET"
printf 'BADGE_ARMED=%s\n' "$BADGE_ARMED"
printf 'AUDIBLE_START=%s\nBADGE_START=%s\nCLOCK_START=%s\n' "$AUDIBLE_START" "$BADGE_START" "$CLOCK_START"
printf 'CUE_HEARD=%s\n' "$CUE_HEARD"
printf 'PAUSE_AUDIO=%s\nPAUSE_CLOCK=%s\nPAUSE_BTN=%s\n' "$PAUSE_AUDIO" "$PAUSE_CLOCK" "$PAUSE_BTN"
printf 'RESUME_AUDIO=%s\nRESUME_CUE=%s\n' "$RESUME_AUDIO" "$RESUME_CUE"
printf 'EXT_PAUSE_SEEN=%s\nEXT_PAUSE_SECS=%s\nEXT_RESUME_SEEN=%s\n' "$EXT_PAUSE_SEEN" "$EXT_PAUSE_SECS" "$EXT_RESUME_SEEN"
printf 'MODAL_SHOWN=%s\nMODAL_STATS=%s\nCOOLDOWN_AUDIO=%s\n' "$MODAL_SHOWN" "$MODAL_STATS" "$COOLDOWN_AUDIO"
printf 'HANDOFF_OK=%s\nHANDOFF_SEAMLESS=%s\nHANDOFF_NOTE=%s\n' "$HANDOFF_OK" "$HANDOFF_SEAMLESS" "$HANDOFF_NOTE"
printf 'CLIENTLOG=%s\nCLIENTLOG_HIGH_FINDINGS=%s\n' "$OUT" "$([ "$CLOG_STATUS" -ne 0 ] && echo yes || echo no)"

# --------------------------------------------------------------------- the verdict

hr
VERDICT=pass
for v in "$AUDIBLE_START" "$CLOCK_START" "$CUE_HEARD" "$PAUSE_AUDIO" "$PAUSE_CLOCK" \
         "$RESUME_AUDIO" "$RESUME_CUE" "$EXT_PAUSE_SEEN" "$EXT_RESUME_SEEN" \
         "$MODAL_SHOWN" "$COOLDOWN_AUDIO" "$HANDOFF_OK" "$HANDOFF_SEAMLESS"; do
  [ "$v" = "y" ] || VERDICT=fail
done
[ "$BADGE_START" = "LIVE" ] || VERDICT=fail
[ "$CLOG_STATUS" -eq 0 ] || VERDICT=fail

if [ "$VERDICT" = pass ]; then
  echo "VERDICT: pass - full sequence verified, no high-severity diagnostics."
  echo "Paste the block above into the PR or commit message as the re-verification record."
else
  echo "VERDICT: fail - something above did not hold. Do not report this path as verified."
  echo "The findings section and the captured answers together say where to look."
fi
exit 0
