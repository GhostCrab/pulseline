# Live sync is shared, not duplicated

**Status:** accepted

The span match, the snap-or-slew correction and the slew absorber live in one shared
`sync-core.js`, loaded by `workout.html` and `index.html`, rather than being
re-implemented per page. This is a deliberate exception to the per-page duplication
recorded in [ADR-0001](0001-per-page-auth-and-store-layers.md), and the reason the two
are treated differently is the kind of dependency each one is.

Auth and the store layer must work when a page boots alone, and their failure mode is
silent: a page that mis-authenticates or writes to the wrong namespace looks like it is
working. Live sync is a pure function — no I/O, no storage, no token, no DOM — so a page
cannot be half-synced the way it can be half-authenticated.

## Why it was worth doing

The correction arithmetic was written **three** times and was identical in all three:
the Spotify Connect poll in `workout.html`, the same poll in `index.html`, and the Web
Playback SDK listener in `workout.html` (which differs only in using the SDK's position
field and skipping the half-RTT compensation). The `dt*.12` slew absorber and the
`{start, end, tr}` span builder were each written twice. `docs/DEVELOPING.md` *Hotspots*
6 flags this code as tuned — "changing the constants reintroduces either flicker or
drift" — and tuned constants written out three times are three places to retune.

## Consequences

- The tuned constants (the snap threshold, the order-drift threshold, the slew rate)
  are internal to the module and exported read-only. They are deliberately **not**
  parameters: a per-call-site parameter is how the tuning gets lost.
- The module returns a **decision**, never a mutation. Callers apply it. That is what
  makes it runnable with no SDK, no poll and no clock, and it is the whole reason the
  extraction was worth doing: see `tests/sync-core.test.js`.
- The span carries its own track, so the matcher reads the uri off the span. The
  previous `spans[i] ↔ tracks[i]` parallel-array assumption is **gone**, not merely
  tested — it was redundant, because the span builder produces both.
- The editor's `speed` multiplier and its clamp to the end of the timeline stay outside
  the module: the absorber returns a step and the caller applies it. `sync-core.js` does
  not know that a speed multiplier exists.
- Ongoing order-drift detection previously existed in only one of the three call sites.
  Because the diagnosis is now returned rather than toasted in place, every caller can
  surface it. Enabling it per page is a behaviour change and belongs in its own diff.
- **`workout.html` gains its first shared-logic dependency.** Mitigated by a boot-time
  gate on the module and its version marker, so a missing or stale `sync-core.js` is
  reported as a version mismatch at boot instead of throwing inside the animation loop,
  where the symptom would be a frozen countdown with no error. `analyze.html`'s
  `NEEDS_CORE` gate is the precedent; `index.html` still has no equivalent gate for
  `analysis-core.js`, which remains a known gap.
