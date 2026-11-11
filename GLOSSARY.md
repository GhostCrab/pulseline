# Pulseline

Lines up a Spotify playlist against a programmed interval workout on one shared timeline, so song transitions can be kept out of the hardest efforts.

## Language

### Workout

**Workspace**:
A playlist together with its interval program and in-edit track order, saved per Spotify account.
_Avoid_: project, session

**Interval program**:
The ordered list of intervals that makes up one workout.
_Avoid_: workout plan, sections list

**Interval**:
One timed segment of an interval program, with a name, length, color and intensity (called a `section` in code).
_Avoid_: section, block, step

**Intensity**:
An interval's effort level: low, medium, high or peak.

**Transition**:
The instant one song ends and the next begins.
_Avoid_: song change, crossfade

**Span**:
The stretch of the timeline one track occupies, from where it starts to where it ends.
_Avoid_: slot, segment, block

**Clash**:
A transition that lands inside a peak interval.
_Avoid_: conflict, peak collision

### Playlist state

**Clean**:
A workspace whose track order matches the playlist as saved on Spotify. Only clean workspaces may drive real playback.

**Dirty**:
A workspace with local edits not yet saved to Spotify.
_Avoid_: modified, unsaved

### Playback

**Run-through**:
The editor's live clock sweeping the timeline. It is silent by default and drives real audio once a device is linked.
_Avoid_: preview, simulation (when audio is linked)

**Link**:
Binding the editor's run-through to a Spotify Connect device so play, pause and seek control real audio.

**Play-through target**:
Where workout audio comes from: **This app** (the in-browser Web Playback SDK player) or **Spotify app** (whatever Spotify Connect device is active).

**Live sync**:
Keeping the app's workout clock aligned with what Spotify is actually playing.

**Snap**:
A live sync correction applied at once, because the gap is too large to hide.

**Slew**:
A live sync correction absorbed gradually, so the countdown never visibly jumps.
_Avoid_: drift correction, adjustment

**Order drift**:
Playback running in a different order from the timeline — what shuffle being left on looks
like from inside a workout.
_Avoid_: desync, mismatch

**Handoff**:
Moving playback at workout completion from the in-app player to the Spotify app, starting at the exact position so the music carries on without a repeat.
_Avoid_: transfer

### Identity and storage

**Namespace**:
The per-account key (`u_<spotify-id>`) that scopes a user's server-side state and history.
_Avoid_: user, account (when meaning the storage key)

**Device secrets**:
The Client ID, tokens and PKCE verifier, kept only in one browser's local storage and never sent to the server.

**Analysis**:
Essentia measurements of a recording, shared across all accounts because they describe the track, not the listener.
