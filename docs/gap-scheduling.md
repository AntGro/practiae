# Gap scheduling — a second way to build a routine

Practiae has two scheduling modes, per program. **Frequency mode** (the
original) plans an N-day cycle from per-piece frequencies. **Gap mode**
(this document) builds one practice session at a time from target gaps
and the history of plays. The two modes share the piece list, durations,
tags and groups; they differ in what a piece carries and what Generate
produces.

## 1. Model

### 1.1 Program fields (gap mode)

| Field | Meaning |
|---|---|
| `mode` | `'frequency'` (default) or `'gap'`. |
| `session_minutes` | Duration cap for one session, minutes. Default 60. |
| `play_log` | `[{ date: 'YYYY-MM-DD', piece_id }]` — one entry per play. Appended when a piece is ticked done in the gap-mode day view; removed when unticked. |

### 1.2 Piece fields (gap mode)

| Field | Meaning |
|---|---|
| `gap` | Integer 0–30. Days *between* two sessions containing the piece. Period = `gap + 1` days. `gap = 0` → every day; `gap = 1` → every other day; `gap = 2` → every 3 days. |
| `duration_min` | Assumed present (the session cap is meaningless without it). Missing duration counts as 0 and never consumes the cap. |

`perc` is unused in gap mode; `gap` is unused in frequency mode. Both
fields live on every piece so switching modes is lossless-ish (see §6).

### 1.3 History window

The log is pruned to the last **180 days** on load. Pruning never
changes a scheduling decision: the longest gap is 30 (period 31), so a
piece unplayed for 180 days is due under any gap. The only loss is old
history for display. Entries are deduplicated on `(date, piece_id)`.

### 1.4 Fixed days

`custom_days` (fixed-day pieces) are ignored in gap mode: a gap
schedule has no fixed program days, so there is nothing to pin a piece
to. The Days button is hidden in gap mode. (A weekday constraint —
"only on Mondays" — is a different feature and is out of scope.)

## 2. Due / overdue

Let `T` be today (local calendar date) and `last(i)` the latest log
date for piece `i` (none = never played).

- `since(i)` = `T − last(i)` in days; `∞` if never played.
- `period(i)` = `gap(i) + 1`.
- `dueIn(i)` = `period(i) − since(i)`: days until the piece is next due.
  `dueIn ≤ 0` means due; `dueIn = 0` means due today.
- `overdue(i)` = `max(0, −dueIn(i))`; `∞` if never played.

A piece is **due** iff `dueIn ≤ 0`. A never-played piece is due and
outranks every played piece (its gap has never been respected at all).

## 3. Units (groups)

- **Inclusion groups collapse into units.** A unit is the set of pieces
  that must always share a day. Pieces in no inclusion group are
  singleton units. A piece in several inclusion groups merges them
  (union-find): overlapping inclusion groups are one unit.
- A unit's **duration** is the sum of its members' durations.
- A unit's **overdue** is the max of its members' overdue
  (the unit is as overdue as its most overdue member);
  its **dueIn** is the min of its members' dueIn.
  A unit is due iff any member is due; it is never-played iff any
  member is never played.
- **Exclusion groups are a constraint, not a collapse.** At most one
  member of an exclusion group may be in a session. Two units conflict
  if any of their members share an exclusion group.
- **Unsatisfiable unit.** If one unit contains two members of the same
  exclusion group (an inclusion group overlapping an exclusion group),
  it can never be scheduled: it is excluded from every session and
  reported as a warning. The user must split one of the groups.

## 4. Building today's session

`buildSession(program, T)` is pure and deterministic: same log, gaps,
cap and groups on the same day always give the same session.

### 4.1 Candidate order

Units are ranked once, then walked greedily:

1. **Never-played units** — `gap` ascending (the most frequent piece
   first), then duration ascending.
2. **Due units** — `overdue` descending, then duration ascending
   (shorter first within the same overdue, so the session packs better).
3. **Fill** — not-yet-due units with `dueIn ≤ 1` (due tomorrow) that
   were **not played today**, `dueIn` ascending, then duration
   ascending. A piece played today is due tomorrow but must not be
   replayed the same day just because the session has spare time.

### 4.2 Greedy pick

Walk the ranked list in two phases:

- **Phase 1** (never-played + due): add a unit if its duration fits
  the remaining budget and it does not conflict (exclusion) with an
  already-picked unit. Otherwise skip it (it stays due for tomorrow).
- **Phase 2** (fill): same rule over the fill candidates — not-yet-due
  units due within a day and not played today (see §4.1).

Why greedy and not an exact knapsack: an exact optimum (max total
overdue covered) can skip a very overdue long piece in favour of
several medium ones, which is hard to explain ("why wasn't my
10-days-overdue piece scheduled?"). Greedy by overdue is predictable:
the most overdue piece that fits is always in. The cost is a session
that is sometimes a few minutes short of the cap.

### 4.3 The fill rule (a deliberate choice)

Phase 2 only pulls in pieces due **within 1 day**. Playing a piece due
tomorrow shortens its gap by one day; pulling in a piece due in 5 days
would shorten it by five. The 1-day bound keeps every realised gap
close to its target while still using the session time instead of
leaving it empty. If nothing is due today and nothing is due tomorrow,
the session is **empty** — a legitimate rest day, not an error. The UI
says so ("Nothing due today").

### 4.4 Warnings

The session reports, for the UI to show:

- units whose duration alone exceeds the cap (they can **never** be
  scheduled — raise the cap or split the unit);
- unsatisfiable units (§3);
- an empty session.

## 5. The session as data

A session is stored as the program's `pinned_routine`, reusing the
frequency routine's shape so the table, the mobile day view and the
tag chart just work:

- `columns`: `[formatted date]` (one column, e.g. `"Fri 20 Nov"`).
- `data`: slot rows like the frequency routine (`data[r][d]` = label
  of the r-th picked piece, or `''`).
- `ids`: parallel slot rows of piece ids (`ids[r][d]`), so the day
  view can tick by id (labels are not unique).
- `indices`: row numbers `"1."`, `"2."`, …
- `tag_distribution`: from `computeTagDistribution` over the one day.
- `date`: `'YYYY-MM-DD'` — the day the session was generated for.

**Staleness.** If `pinned_routine.date` is not today, the session is
stale: the UI shows "This session was generated for <date>. Generate
a new session for today." The old session stays visible until the user
regenerates; nothing is auto-regenerated.

**Done state.** In gap mode, an item is done iff the log contains
`(today, piece_id)`. Ticking toggles that log entry (persisted);
Untick all removes today's entries for the session's pieces. Done
marks therefore survive reloads — unlike frequency mode, where they
are in-memory only. Regenerating the session after ticking drops the
ticked pieces: their last play is today, so they are no longer due.

## 6. Switching modes

Switching a program's mode converts every piece and clears the pinned
routine (a frequency routine is not a gap session and vice versa):

- Frequency → gap: `gap = round(num_days / k) − 1` where
  `k = round(perc × num_days / 100)`; `k = 0` (never scheduled) maps
  to `gap = 30` (the maximum).
- Gap → frequency: `k = round(num_days / (gap + 1))`;
  `perc = snapPerc(k / num_days × 100, num_days)`.

Conversion is lossy (a gap of 7 over 8 days becomes 12.5% ≈ 1 day in
8, which converts back to gap 7 — round trips are stable for the
common cases, but a perc that does not divide the cycle evenly will
shift by a day). The log is kept across switches, so a program that
goes gap → frequency → gap keeps its history.

**Cold start.** A program switched to gap mode with an empty log has
every piece never-played: the first session is the never-played units
in gap order, up to the cap. The pieces that do not fit are picked up
over the following days.

## 7. What gap mode does not do (v1)

- No per-piece "last played" manual entry (the log is built by
  ticking sessions). A program with no history starts cold (§6).
- No exact knapsack optimisation (§4.2).
- No weekday constraints (§1.4).
- No stats view over the log (the log exists for scheduling; a
  history/stats surface can read it later).
- The frequency-mode optimiser (simulated annealing, balance-by) is
  untouched and unused by gap mode.

## 8. Invariants (tested)

- Same inputs → same session (deterministic; no randomness).
- Session duration ≤ cap, always.
- At most one member of each exclusion group per session.
- Inclusion units are all-or-nothing in a session.
- Per-piece occurrence counts are irrelevant here — a piece appears
  at most once per session by construction.
- A ticked piece is never in the next session generated the same day
  (its last play is today).
- Pruning the log to 180 days never changes a session.
