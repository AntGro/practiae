// Gap scheduling — build one practice session from target gaps and the
// play history. See docs/gap-scheduling.md for the full formalisation.
// Pure functions, no DOM: every input is explicit, so the session is
// deterministic for a given (program, today).

import { pieceLabel, computeTagDistribution } from './generate.js';

export const MAX_GAP = 30; // gap input range 0–30 days
export const PLAY_LOG_DAYS = 180; // log window (see docs/gap-scheduling.md §1.3)
export const FILL_WITHIN_DAYS = 1; // phase 2 only pulls in pieces due within 1 day

/** Local 'YYYY-MM-DD' for a Date (default: now). */
export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Day number for a 'YYYY-MM-DD' (UTC, DST-proof); NaN for garbage. */
export function dayNumber(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
}

/** Whole days from a to b (b − a). */
export function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Fri 20 Nov' for a 'YYYY-MM-DD'. */
export function formatDayLabel(dateStr) {
  const n = dayNumber(dateStr);
  if (!Number.isFinite(n)) return dateStr;
  const d = new Date(n * 86400000);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Latest log date per piece id. */
export function lastPlayedById(playLog) {
  const m = new Map();
  for (const e of playLog || []) {
    if (!e || typeof e.date !== 'string' || typeof e.piece_id !== 'string') continue;
    const cur = m.get(e.piece_id);
    if (!cur || e.date > cur) m.set(e.piece_id, e.date);
  }
  return m;
}

/** Piece ids played on one date. */
export function playedIdsOn(playLog, date) {
  const s = new Set();
  for (const e of playLog || []) if (e?.date === date) s.add(e.piece_id);
  return s;
}

/**
 * Due status of one piece for a day.
 * @returns {{since:number, dueIn:number, overdue:number, never:boolean}}
 *   since = days since last play (Infinity if never); dueIn = days until
 *   next due (≤ 0 means due); overdue = days past due (Infinity if never).
 */
export function pieceStatus(piece, lastDate, today) {
  const period = Math.max(0, piece.gap || 0) + 1;
  if (!lastDate) return { since: Infinity, dueIn: -Infinity, overdue: Infinity, never: true };
  const since = daysBetween(lastDate, today);
  const dueIn = period - since;
  return { since, dueIn, overdue: Math.max(0, -dueIn), never: false };
}

/** Short due label for the piece list: 'never played', 'due today', 'overdue 3d', 'due in 2d'. */
export function dueLabel(piece, lastDate, today) {
  const s = pieceStatus(piece, lastDate, today);
  if (s.never) return 'never played';
  if (s.dueIn <= 0) return s.overdue === 0 ? 'due today' : `overdue ${s.overdue}d`;
  return `due in ${s.dueIn}d`;
}

function unitName(unit) {
  return unit.members.map((m) => pieceLabel(m)).join(' + ');
}

// Inclusion groups collapse into units (union-find: a piece in several
// inclusion groups merges them into one unit).
function buildUnits(pieces, inclusionGroups) {
  const parent = new Map(pieces.map((p) => [p.id, p.id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let y = x;
    while (parent.get(y) !== r) { const nxt = parent.get(y); parent.set(y, r); y = nxt; }
    return r;
  };
  for (const g of inclusionGroups || []) {
    const ids = (g || []).filter((id) => parent.has(id));
    for (let i = 1; i < ids.length; i++) {
      const ra = find(ids[0]);
      const rb = find(ids[i]);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const byRoot = new Map();
  for (const p of pieces) {
    const r = find(p.id);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(p);
  }
  return [...byRoot.values()];
}

/**
 * Build today's session for a program in gap mode.
 * @param {object} program — { pieces: [{id,rank,gap,duration_min,...}], exclusion_groups, inclusion_groups, session_minutes, play_log }
 * @param {string} today — 'YYYY-MM-DD' (default: today, local)
 * @returns {{ date, columns, indices, data, ids, tag_distribution, totalMinutes, pickedIds, warnings }}
 *   data/ids are slot rows like the frequency routine's (one column),
 *   so the table, the mobile day view and the tag chart just work.
 */
export function buildSession(program, today = todayStr()) {
  const pieces = [...(program.pieces || [])].sort((a, b) => a.rank - b.rank);
  const lastById = lastPlayedById(program.play_log);
  const cap = Math.max(0, +program.session_minutes || 0);
  const status = new Map(pieces.map((p) => [p.id, pieceStatus(p, lastById.get(p.id), today)]));

  const units = buildUnits(pieces, program.inclusion_groups).map((members) => ({
    members,
    duration: members.reduce((s, m) => s + (+m.duration_min || 0), 0),
    never: members.some((m) => status.get(m.id).never),
    overdue: Math.max(...members.map((m) => status.get(m.id).overdue)),
    dueIn: Math.min(...members.map((m) => status.get(m.id).dueIn)),
    since: Math.min(...members.map((m) => status.get(m.id).since)),
    gap: Math.min(...members.map((m) => Math.max(0, m.gap || 0))),
  }));

  // Exclusion: piece id -> the exclusion groups it belongs to.
  const exclOf = new Map();
  (program.exclusion_groups || []).forEach((g, gi) => {
    for (const id of g || []) {
      if (!exclOf.has(id)) exclOf.set(id, new Set());
      exclOf.get(id).add(gi);
    }
  });
  const unitExcl = (u) => {
    const s = new Set();
    for (const m of u.members) for (const gi of exclOf.get(m.id) || []) s.add(gi);
    return s;
  };

  const warnings = [];
  const candidates = [];
  for (const u of units) {
    // Unsatisfiable: one unit holding two members of one exclusion group.
    const seen = new Set();
    let bad = false;
    for (const m of u.members) {
      for (const gi of exclOf.get(m.id) || []) {
        if (seen.has(gi)) { bad = true; break; }
        seen.add(gi);
      }
      if (bad) break;
    }
    if (bad) {
      warnings.push(`"${unitName(u)}" can never be scheduled: its members must never share a day, but must always share one. Split one of the groups.`);
      continue;
    }
    if (u.duration > cap) {
      warnings.push(`"${unitName(u)}" (${u.duration} min) is longer than the session cap (${cap} min) and can never be scheduled.`);
      continue;
    }
    candidates.push(u);
  }

  // Phase 1: never-played first (gap asc, then duration asc), then due
  // (overdue desc, then duration asc — shorter first packs better).
  const rankPhase1 = (a, b) => {
    if (a.never !== b.never) return a.never ? -1 : 1;
    return a.never
      ? (a.gap - b.gap) || (a.duration - b.duration)
      : (b.overdue - a.overdue) || (a.duration - b.duration);
  };
  const phase1 = candidates.filter((u) => u.never || u.dueIn <= 0).sort(rankPhase1);
  // Phase 2: fill with pieces due within a day that were not played
  // today (a piece played today is due tomorrow but must not be
  // replayed the same day just because the session has spare time).
  const phase2 = candidates
    .filter((u) => !u.never && u.dueIn > 0 && u.dueIn <= FILL_WITHIN_DAYS && u.since > 0)
    .sort((a, b) => (a.dueIn - b.dueIn) || (a.duration - b.duration));

  const picked = [];
  const pickedExcl = new Set();
  let remaining = cap;
  const tryPick = (u) => {
    if (u.duration > remaining) return false;
    const ex = unitExcl(u);
    for (const gi of ex) if (pickedExcl.has(gi)) return false;
    picked.push(u);
    for (const gi of ex) pickedExcl.add(gi);
    remaining -= u.duration;
    return true;
  };
  for (const u of phase1) tryPick(u);
  for (const u of phase2) tryPick(u);

  if (!picked.length && !units.some((u) => u.never || u.dueIn <= 0)) {
    warnings.push('Nothing due today — enjoy the rest, or lower a gap.');
  }

  const pickedPieces = picked.flatMap((u) => u.members).sort((a, b) => a.rank - b.rank);
  return {
    date: today,
    columns: [formatDayLabel(today)],
    indices: pickedPieces.map((_, i) => `${i + 1}.`),
    data: pickedPieces.map((p) => [pieceLabel(p)]),
    ids: pickedPieces.map((p) => [p.id]),
    tag_distribution: computeTagDistribution([pickedPieces]),
    totalMinutes: pickedPieces.reduce((s, p) => s + (+p.duration_min || 0), 0),
    pickedIds: pickedPieces.map((p) => p.id),
    warnings,
  };
}
