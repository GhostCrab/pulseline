# Coding standards

Read during review. These are the judgement calls. Mechanical rules (syntax, identical login scopes,
version markers, undefined identifiers, debug tags) are enforced by `scripts/check.py`, so this file
doesn't restate them.

## Every fallback is visible

When code degrades behaviour (switches playback target, runs simulated, skips a step, falls back
to another endpoint or to browser storage), the user is told at the moment it happens, in the
place they are looking. The silent case is the bug: `workout.html` once switched itself from in-app
to Spotify-app mode at boot, the badge read LIVE, and the workout ran over silence with no error.

Review question: for each `catch`, early `return`, or default value on a path the user depends on,
can the user tell it happened?

## Auth and API changes land on every page

Each page carries its own copy of the login, token refresh and `api()` code on purpose (each page
loads standalone). A change to one copy is complete only when the other copies match, or the
diff explains why this page differs. Copies: `index.html`, `workout.html`, `calendar.html`,
`analyze.html`.

Review question: does the diff touch one copy of a duplicated auth/API block? Then check the others.

## Spotify calls follow the reference

New or changed Spotify calls use endpoints, fields and scopes as they appear in
`docs/spotify/open-api-schema.yaml`, and respect the rules in `docs/agents/spotify-api.md`. When a
diff changes a row of that file's status table, the table is updated in the same diff.

## Measured or documented, never invented

Ranges, thresholds and constants presented as facts about music, audio or Spotify's behaviour come
from documentation or measurement, and the code comment says which. A value chosen for UX or storage
(a retry count, a log size cap) is labelled as a chosen value. Background: `docs/DEVELOPING.md`,
"The no-invented-numbers rule".

## The fragile path is re-verified end to end

A diff touching `workout.html`'s `beginPlayback()`, pause handling, completion or handoff, or the
token code under them, states in the PR or commit how the whole sequence was re-verified: start,
pause, external pause, finish, completion card, handoff.
