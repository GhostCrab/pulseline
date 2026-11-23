# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pulseline lines up a Spotify playlist against a programmed interval workout. No build step: plain HTML pages with inline `<script>`, a stdlib-only `server.py`, and dev-only tooling in `package.json` that is never deployed.

## Commands

```bash
python3 server.py                   # local server: open http://127.0.0.1:8888/ (not localhost: Spotify's redirect URI must match exactly)
python3 scripts/check.py            # all mechanical checks; ESLint included after `npm install`
python3 scripts/test.py             # behaviour tests (state API, analysis-core, clientlog reader)
python3 scripts/clientlog.py          # what a real device saw (newest log, latest session); --timeline for the entries in order
python3 scripts/mutate.py <file> <old> <new>   # prove a test can fail; green is the failure
bash scripts/pull-log.sh            # copy the newest client log down from the Pi (read-only)
bash scripts/hitl-workout.sh        # prerequisites + sequence for a device pass
git config core.hooksPath .githooks # once per clone: check.py + test.py on every commit, and the commit-msg check below
```

On Windows type `python`, not `python3`: `python3` there is the Store stub and exits 49.

A commit that changes the playback path in `workout.html` is refused unless its message accounts for each step of the sequence; the refusal prints the format (`scripts/commit_msg.py`).

## Environments

Develop and test on the build/test machine against the local server. Production is `/opt/pulseline` on the Pi (`pulseline.pielow.io`); deploy there only when asked. The Pi pulls from GitHub, so a commit is deployable only once pushed: when the user will deploy, push, or say plainly that it is not pushed. For ad-hoc SSH to the Pi, use PowerShell; Git Bash's ssh cannot read the key. See `docs/DEVELOPING.md` *Environments*.

## Where things are

- **`docs/DEVELOPING.md`**: read the section for the area you touch before changing it: storage rules, caching, iOS, canvas, and **Hotspots** (the most-regressed code). It also holds the owner's binding working agreement (*The no-invented-numbers rule*, *On reporting work in this repo*) and *The three tiers of guardrail* — read that before adding a check, a standard or a test.
- **`docs/adr/`**: decisions not to re-litigate. Read before proposing a refactor.
- **`docs/agents/spotify-api.md`**: read before any change that calls Spotify. Endpoints, fields and scopes come from `docs/spotify/open-api-schema.yaml`; grep it.
- **`CODING_STANDARDS.md`**: the review rules.
- **`data/clientlog-<ns>.jsonl`**: what real devices reported (Spotify player events, API failures). Read it first when playback misbehaves. Then watch the real player: `workout.html?probe=1` on the local server loads `debug/start-probe.js` (every SDK event and Spotify call, with timings and fault injection); `debug/sdk-probe.html` probes the in-app player on its own.
- Auth and `api()` code is duplicated in every page on purpose; a change to one copy applies to all. `scripts/check.py`'s `copies` check enforces the response-handling part.
- **Write JavaScript with the Edit/Write tools: the pages, the shared `.js` and the tests alike. Keep it out of shell heredocs, `python - <<EOF` and `sed`.** Escaping through a shell into JavaScript corrupted a page four times in one session and broke a test-file append in another.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for GhostCrab/pulseline (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
