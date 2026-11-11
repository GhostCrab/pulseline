# The state API is namespaced, not protected

**Status:** accepted

`server.py` puts **no authentication** in front of the state API. Namespaces (`u_<spotify-id>`)
scope a user's server-side state and history, but they do not protect it: anyone who can reach the
port can read and write any namespace. This was an explicit, informed choice — acceptable for a
household behind a Cloudflare tunnel, and not acceptable for the open internet.

## Consequences

- The absence of auth on `/api/state/`, `/api/history/`, `/api/log/` and `/api/analysis` is the
  design, not an oversight. Do not treat it as a missing feature to be added incidentally.
- Reaching the port is the actual security control. Exposing the service more widely, rather than
  adding auth, is what would make this decision wrong.
- A consequence worth keeping: any client — including a test — can address any namespace directly
  over HTTP with no credentials, which makes the state API the one seam in this project that is
  exercisable without a browser and without a Spotify session.

Background: `docs/DEVELOPING.md` *Operational notes*.
