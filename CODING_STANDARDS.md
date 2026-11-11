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

## A test is shown to fail

A new or changed assertion is complete when the diff says which mutation turned it red.
`scripts/mutate.py` does it in one command. A test that has only ever passed proves
nothing, and this project has shipped four of them: an assertion that matched the word
`finally` in a comment rather than the keyword; an extractor that truncated at a default
parameter and so tested a fragment; a call-site scan that missed every path built into a
variable; and a threshold asserted as `> 100` when the real figure was 70.

Structural assertions over source text are the sharp case. Strip comments first, and
assert the thing sits **inside** the construct rather than merely later in the file than
it.

Review question: for each new assertion, does the diff name the mutation that breaks it?
If the answer is "it passes", that is not an answer.

## A finding says nothing about a healthy run

Anything that reports a severity - a toast, a client-log finding, a check failure - needs
a case proving a healthy input produces it **not**. Three diagnostics in this project
have cried wolf: an order-drift test that fired on every correct playthrough, a verdict
that reported HIGH on a run that finished correctly, and a cooldown read as a fault. Each
was caught by a real device rather than by review.

A reader who sees one false alarm discounts the next one, so a noisy diagnostic is worse
than no diagnostic.

Review question: what input makes this report nothing, and is that input tested?

## The fragile path is re-verified end to end

A diff touching `workout.html`'s `beginPlayback()`, pause handling, completion or handoff, or the
token code under them, states in the PR or commit how the whole sequence was re-verified: start,
pause, external pause, finish, completion card, handoff.
