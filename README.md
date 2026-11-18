# Practiae — front-only, Google Drive storage

Live: **https://antgro.github.io/practiae/** — a welcome page offering the
demo or Google Drive sign-in. App: [/app.html](https://antgro.github.io/practiae/app.html)
(demo: [/demo.html](https://antgro.github.io/practiae/demo.html)).

Single-page app, no build step, no framework, vanilla JS (ES modules).
Data lives in the user's Google Drive, one file. Same architecture as
DeLaClaw. The old Flask app in `routine_render/` is untouched.

## Hosting (GitHub Pages)

The repo is static files only, so GitHub Pages serves it directly:
Settings → Pages → Build and deployment → Source: **Deploy from a branch**
→ Branch: **main**, folder: **/(root)** → Save. The site builds in about
a minute at `https://antgro.github.io/practiae/`.

Note: Google Drive sign-in works only if `https://antgro.github.io` is an
authorised JavaScript origin on the OAuth client (see `js/config.js`).
Until it is added, the hosted site still works in local mode and as the
demo — only the Drive sign-in button will fail with an origin error.

## Run locally

```sh
node serve.mjs
# open http://localhost:8000
```

No Flask, no Python, no dependencies at all: the app is static files,
served by the zero-dependency Node script `serve.mjs` (Node 18+).
`npm start` does the same thing.

Local mode works immediately, no sign-in: data in `localStorage`, seeded
from `data/default_routine.json` (the 68-piece "Toutes les pièces" program
from the Flask app).

## Demo version (no sign-in, localStorage only)

`demo.html` — same UI, Drive controls hidden, no Google code loaded at
all. Data lives in `localStorage` under its own key
(`practiae-gdrive:demo:v1`), so demo edits never touch the real local data
or Drive. `index.html?demo=1` does the same thing.

## Google Drive mode

Click **Google Drive** in the header. That signs in with Google Identity
Services (`drive.file` scope only — the app can only see files it created)
and stores the whole document as one file, `practiae.json`, in a Drive
folder named `PractiaeDev` on localhost / `Practiae` on practiae.com.

- Saves are debounced 2s after the last change.
- Before overwriting, the file's md5 is re-checked: if it changed in Drive
  since it was last read (another tab/device), the save is refused with a
  conflict instead of overwriting.
- Drive is polled every 30s; a remote change reloads the document.
- The token lives in `sessionStorage` only.

Default OAuth client id is DeLaClaw's. It works only if the current origin
is an authorised JavaScript origin on that client. If Google answers with
an origin error, create a Web OAuth client for Practiae in Google Cloud
Console (enable the Drive API, add the origin), and paste its client id in
Settings — or pass `?client_id=...`.

## What was ported from the Flask app (faithfully)

- Data model: Program (name, num_days, day_names, pieces, exclusion /
  inclusion groups, pinned routine) and Piece (title, composer, perc,
  tags, custom_days, notes, duration_min).
- Generation (`js/generate.js` ← `utils.py`): fixed day patterns first,
  least-loaded-day placement, lowest perc first, `k = round(perc × days / 100)`,
  exclusion / inclusion post-passes, tag distribution + tag colours,
  `Piece.__str__` display labels.
- One deliberate change: groups store piece **ids**, not ranks (Flask ranks
  break on reorder/delete). Flask rank groups are converted on import,
  and back to ranks at generation time.

## What is NOT ported (yet)

- Accounts, email confirmation, plans, Brevo — there is no server at all.
- Sharing a program with another user (DeLaClaw-style sharing would be the
  route for that, not in scope here).
- Infinity-day mode, checkpoints, PDF/Excel export, phone app — see
  `routine_render/ROADMAP.md`.
- The Flask app's htmx UI details (Tagify, Sortable tabs, floating add
  button). Tabs here are a plain list; pieces are edited inline
  (double-click, Enter saves, Esc/blur cancels).

## Tests

```sh
node tests/tests.js   # generation invariants (counts, fixed days, groups, tags) + store import
# with the server running (node serve.mjs):
node tests/browser-smoke.mjs   # headless Chromium: demo loads, edit persists, Generate + chart, add piece
```

Note: the Muse cloud/device browsers cannot reach `localhost:8000` on
this machine, so live browser tests run in headless Chromium here
(`browser-smoke.mjs`), not via `browser.browse`.

## Files

- `index.html` — welcome page: SVG logo, demo vs Drive choice, live stats
  + tag chart generated from the seed program
- `app.html`, `demo.html`, `style.css` — the app + theme (dark/light via
  CSS variables); demo is the same app with Drive hidden, no sign-in
- `serve.mjs` — zero-dependency Node static server for local dev (no Flask, no Python)
- `logo.svg` — the original Practiae logo (purple grid + checkmarks),
  reused from the Flask app's favicon; also the favicon for all pages
- `icons/brand/googledrive.svg` — Google Drive brand logo (thesvg, via DeLaClaw)
- `js/icons.js` — Lucide icons (embedded path data, same source as DeLaClaw)
- `js/chart.js` — tag distribution chart (vertical stacked bars, Pieces /
  Duration toggle, ported from the Flask app)
- `js/welcome.js` — welcome page: live stats + chart from the seed
- `ATTRIBUTIONS.md` — third-party sources (DM Sans, Lucide, Google Identity, thesvg)

## Ported from the Flask app

- **Routine highlighting**: hovering a routine cell highlights the same
  piece across all days (blue); pieces it must never share a day with
  (warm) and pieces it must share days with (green), from the program's
  exclusion / inclusion groups. Click pins the highlight (touch has no
  hover); Esc clears it.
- **Tag chart**: vertical stacked bars per day with a Pieces / Duration
  toggle and hover tooltips. Totals show pieces (or minutes), never the
  sum of tag occurrences.
- **Navigation**: the program list in the sidebar is the port of the
  Flask program tabs (switch, rename, duplicate, delete, add).

## Mobile (≤800px) — a different layout, same data
Desktop keeps the dense tables. On a phone the app swaps in:
- **piece cards** instead of the 9-column table (big title, full-width slider,
  tap-to-edit — no double-click on touch — actions in one thumb row);
- **a day-by-day routine view** instead of the 8-column grid (day chips +
  prev/next, one day's list at a time);
- **a sticky Generate bar** at the bottom, with a live piece count, so the
  action is always in reach while scrolling through 68 pieces;
- **search** (title/composer/tags), programs as a horizontal chip row,
  tag filters as tap-sized pills, 44px minimum touch targets.
Cards and table render from the same data and share the same `data-action`
handlers, so one delegated handler serves both.
- `js/app.js` — UI, one document-level click handler (`data-action`)
- `js/generate.js` — routine generation (pure, tested)
- `js/store.js` — document model, normalisation, Flask import
- `js/config.js` — client id, Drive folder naming, scope
- `js/adapters/local.js` — localStorage
- `js/adapters/drive.js` — GIS + Drive single-file adapter
- `data/default_routine.json` — seed program, copied from the Flask app
