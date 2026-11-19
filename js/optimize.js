// js/optimize.js — Local-search optimizer for generated routines (prototype).
//
// Post-processes the greedy routine from js/generate.js in two phases:
//   1. balance — flatten per-day piece counts towards the mean;
//   2. spacing — maximize the gaps between repeats of the same piece
//      (cyclic gaps: the routine repeats, so the gap from the last
//      occurrence wraps round to the first occurrence of the next cycle).
//
// Hard constraints are never broken: fixed-day pieces never move, a piece
// never appears twice on a day, exclusion groups never share a day,
// inclusion groups always share the same days, and every piece keeps
// exactly the occurrence count the greedy routine gave it.
//
// Search is simulated annealing over two move types (relocate a unit to
// another day; swap two units between days), plus an improving-only
// hill-climb polish. A "unit" is one movable piece, or a whole movable
// inclusion group (its members always move together). Phase 2 only uses
// swaps, so per-day counts — fixed by phase 1 — cannot change.
//
// Deterministic for a given seed (mulberry32). The greedy generator
// itself still uses Math.random, so the same program can start from
// different draws; the optimizer's output for a fixed input is stable.

import { generateRoutine, computeTagDistribution } from './generate.js';

/** Tiny seeded PRNG (mulberry32): deterministic runs for a given seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function copyDays(days) {
  return days.map((d) => [...d]);
}

function sortDays(days) {
  return days.map((d) => [...d].sort((a, b) => a.rank - b.rank));
}

/**
 * Score a routine. balance = sum of squared deviations of per-day counts
 * from the mean (0 iff every day has the same count, when the total
 * divides evenly). gap = sum over movable pieces with >= 2 occurrences
 * of squared deviations of each cyclic gap from that piece's ideal gap
 * (numDays / occurrences). Fixed-day pieces are constants, so they are
 * excluded from the gap term.
 */
function analyse(days, ctx) {
  const counts = new Array(ctx.numDays).fill(0);
  const byRank = new Map();
  days.forEach((day, d) => {
    counts[d] = day.length;
    for (const p of day) {
      let list = byRank.get(p.rank);
      if (!list) {
        list = [];
        byRank.set(p.rank, list);
      }
      list.push(d);
    }
  });
  const mean = ctx.total / ctx.numDays;
  let balance = 0;
  for (const c of counts) balance += (c - mean) * (c - mean);
  let gap = 0;
  for (const rank of ctx.movable) {
    const ds = byRank.get(rank);
    if (!ds || ds.length < 2) continue;
    const ideal = ctx.numDays / ds.length;
    for (let i = 0; i < ds.length; i++) {
      const g = i + 1 < ds.length ? ds[i + 1] - ds[i] : ds[0] + ctx.numDays - ds[i];
      gap += (g - ideal) * (g - ideal);
    }
  }
  return { counts, byRank, balance, gap };
}

function buildContext(program, days, exclusionGroups, inclusionGroups) {
  const numDays = program.num_days;
  const byRank = new Map(program.pieces.map((p) => [p.rank, p]));
  const fixed = new Set();
  for (const p of program.pieces) if (p.day_pattern != null) fixed.add(p.rank);

  // Occurrence counts come from the greedy routine and are preserved.
  const counts = new Map();
  let total = 0;
  for (const day of days) {
    for (const p of day) {
      counts.set(p.rank, (counts.get(p.rank) || 0) + 1);
      total++;
    }
  }

  // Exclusion partners, both directions.
  const partners = new Map();
  const addPair = (a, b) => {
    if (!partners.has(a)) partners.set(a, new Set());
    if (!partners.has(b)) partners.set(b, new Set());
    partners.get(a).add(b);
    partners.get(b).add(a);
  };
  for (const g of exclusionGroups || []) {
    const rs = g.filter((r) => byRank.has(r));
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) addPair(rs[i], rs[j]);
    }
  }

  // Inclusion groups (kept only if >= 2 members actually occur). A piece
  // is assumed to belong to at most one group, as in generate.js.
  const groupOf = new Map();
  const groups = [];
  for (const g of inclusionGroups || []) {
    const rs = g.filter((r) => byRank.has(r) && (counts.get(r) || 0) > 0);
    if (rs.length < 2) continue;
    const idx = groups.length;
    groups.push(rs);
    for (const r of rs) if (!groupOf.has(r)) groupOf.set(r, idx);
  }
  // A group containing a fixed piece is pinned: the fixed member's days
  // anchor the whole group, so no member moves.
  const pinnedGroups = new Set();
  groups.forEach((rs, i) => {
    if (rs.some((r) => fixed.has(r))) pinnedGroups.add(i);
  });

  // Ranks whose gaps count in the score: movable, occurring pieces.
  const movable = new Set();
  for (const rank of counts.keys()) {
    if (fixed.has(rank)) continue;
    const gi = groupOf.get(rank);
    if (gi !== undefined && pinnedGroups.has(gi)) continue;
    movable.add(rank);
  }

  // Move units: single movable pieces, plus one unit per movable group.
  const units = [];
  const unitOf = new Map();
  for (const rank of movable) {
    if (groupOf.has(rank)) continue;
    unitOf.set(rank, units.length);
    units.push({ ranks: [rank] });
  }
  groups.forEach((rs, i) => {
    if (pinnedGroups.has(i)) return;
    const idx = units.length;
    for (const r of rs) unitOf.set(r, idx);
    units.push({ ranks: rs });
  });

  return { numDays, total, byRank, fixed, counts, partners, groupOf, groups, pinnedGroups, movable, units, unitOf };
}

/** Public scoring helper (bench/tests): { balance, gap, counts }. */
export function analyseRoutine(days, program, exclusionGroups = [], inclusionGroups = []) {
  const ctx = buildContext(program, days, exclusionGroups, inclusionGroups);
  const { balance, gap, counts } = analyse(days, ctx);
  return { balance, gap, counts };
}

function canPlace(ranks, day, days, ignore, ctx) {
  const present = days[day];
  const rankSet = new Set(ranks);
  for (const r of ranks) {
    if (present.some((p) => p.rank === r)) return false;
    const ps = ctx.partners.get(r);
    if (!ps) continue;
    for (const q of ps) {
      if (rankSet.has(q)) continue; // moves together with the unit
      if (ignore && ignore.has(q)) continue; // leaves the day in a swap
      if (present.some((p) => p.rank === q)) return false;
    }
  }
  return true;
}

function unitDays(unit, byRank) {
  return byRank.get(unit.ranks[0]) || [];
}

function proposeRelocate(days, analysis, ctx, rng) {
  if (!ctx.units.length) return null;
  const unit = ctx.units[Math.floor(rng() * ctx.units.length)];
  const ds = unitDays(unit, analysis.byRank);
  if (!ds.length) return null;
  const a = ds[Math.floor(rng() * ds.length)];
  const b = Math.floor(rng() * ctx.numDays);
  if (b === a) return null;
  if (!canPlace(unit.ranks, b, days, null, ctx)) return null;
  return { kind: 'relocate', ranks: unit.ranks, from: a, to: b };
}

function proposeSwap(days, analysis, ctx, rng) {
  if (!ctx.units.length) return null;
  const unit = ctx.units[Math.floor(rng() * ctx.units.length)];
  const ds = unitDays(unit, analysis.byRank);
  if (!ds.length) return null;
  const a = ds[Math.floor(rng() * ds.length)];
  const b = Math.floor(rng() * ctx.numDays);
  if (b === a) return null;
  const onB = new Set();
  for (const p of days[b]) {
    const ui = ctx.unitOf.get(p.rank);
    if (ui !== undefined) onB.add(ui);
  }
  const candidates = [...onB].filter((ui) => ctx.units[ui] !== unit);
  if (!candidates.length) return null;
  const other = ctx.units[candidates[Math.floor(rng() * candidates.length)]];
  if (!canPlace(unit.ranks, b, days, new Set(other.ranks), ctx)) return null;
  if (!canPlace(other.ranks, a, days, new Set(unit.ranks), ctx)) return null;
  return { kind: 'swap', u: unit.ranks, v: other.ranks, a, b };
}

function takeRanks(day, ranks) {
  const out = [];
  for (let i = day.length - 1; i >= 0; i--) {
    if (ranks.includes(day[i].rank)) out.push(day.splice(i, 1)[0]);
  }
  return out;
}

function applyMove(days, move) {
  const saved = {};
  if (move.kind === 'relocate') {
    saved.from = [...days[move.from]];
    saved.to = [...days[move.to]];
    const pieces = takeRanks(days[move.from], move.ranks);
    days[move.to].push(...pieces);
  } else {
    saved.a = [...days[move.a]];
    saved.b = [...days[move.b]];
    const uPieces = takeRanks(days[move.a], move.u);
    const vPieces = takeRanks(days[move.b], move.v);
    days[move.a].push(...vPieces);
    days[move.b].push(...uPieces);
  }
  return saved;
}

function revertMove(days, move, saved) {
  if (move.kind === 'relocate') {
    days[move.from] = saved.from;
    days[move.to] = saved.to;
  } else {
    days[move.a] = saved.a;
    days[move.b] = saved.b;
  }
}

/**
 * One annealing run. key 'balance' or 'gap'; balanceCap (phase 2) rejects
 * any move that would push balance above the phase-1 best. Best state
 * seen is restored at the end. Phase 1 tracks best by (balance, gap)
 * lexicographically, so its output is the flattest state with the best
 * spacing found along the way.
 */
function anneal(days, ctx, rng, { iterations, t0, t1, key, balanceCap }) {
  let cur = analyse(days, ctx);
  let best = { balance: cur.balance, gap: cur.gap, days: copyDays(days) };
  let accepted = 0;
  for (let i = 0; i < iterations; i++) {
    const t = t0 * Math.pow(t1 / t0, i / Math.max(1, iterations - 1));
    const move =
      key === 'gap'
        ? proposeSwap(days, cur, ctx, rng)
        : rng() < 0.5
          ? proposeRelocate(days, cur, ctx, rng)
          : proposeSwap(days, cur, ctx, rng);
    if (!move) continue;
    const saved = applyMove(days, move);
    const next = analyse(days, ctx);
    const dKey = (key === 'balance' ? next.balance : next.gap) - (key === 'balance' ? cur.balance : cur.gap);
    const capOk = balanceCap === undefined || next.balance <= balanceCap;
    if (capOk && (dKey <= 0 || rng() < Math.exp(-dKey / t))) {
      cur = next;
      accepted++;
      const better =
        key === 'balance'
          ? next.balance < best.balance || (next.balance === best.balance && next.gap < best.gap)
          : next.gap < best.gap;
      if (better) best = { balance: next.balance, gap: next.gap, days: copyDays(days) };
    } else {
      revertMove(days, move, saved);
    }
  }
  for (let d = 0; d < days.length; d++) days[d] = [...best.days[d]];
  return { accepted };
}

/** Improving-only hill climb (swaps): accept a move only if the gap score drops. */
function polish(days, ctx, rng, { tries, balanceCap }) {
  let cur = analyse(days, ctx);
  let fails = 0;
  while (fails < tries) {
    const move = proposeSwap(days, cur, ctx, rng);
    if (!move) {
      fails++;
      continue;
    }
    const saved = applyMove(days, move);
    const next = analyse(days, ctx);
    if ((balanceCap === undefined || next.balance <= balanceCap) && next.gap < cur.gap) {
      cur = next;
      fails = 0;
    } else {
      revertMove(days, move, saved);
      fails++;
    }
  }
  return cur;
}

/**
 * Optimize a greedy routine.
 * @param {object} program — { num_days, pieces: [{rank, day_pattern}] }
 * @param {object[][]} greedyDays — days[d] is the list of pieces on day d
 * @param {number[][]} exclusionGroups — lists of piece ranks
 * @param {number[][]} inclusionGroups — lists of piece ranks
 * @param {object} opts — { seed, iterations } (iterations per phase)
 * @returns {{ days, stats }} — days sorted by rank within each day.
 */
export function optimizeRoutine(program, greedyDays, exclusionGroups = [], inclusionGroups = [], opts = {}) {
  const started = Date.now();
  const rng = mulberry32(opts.seed ?? 1);
  const days = copyDays(greedyDays);
  const numDays = program.num_days;
  const ctx = buildContext(program, days, exclusionGroups, inclusionGroups);
  const before = analyse(days, ctx);
  const stats = {
    balanceBefore: before.balance,
    gapBefore: before.gap,
    countsBefore: [...before.counts],
  };
  const finish = (extra) => ({
    days: sortDays(days),
    stats: { ...stats, ...extra, runtimeMs: Date.now() - started },
  });
  // Nothing to optimize: a single day has no spacing, and with no movable
  // unit every placement is pinned.
  if (numDays < 2 || ctx.units.length === 0) {
    return finish({
      balanceAfterPhase1: before.balance,
      gapAfterPhase1: before.gap,
      balanceAfter: before.balance,
      gapAfter: before.gap,
      countsAfter: [...before.counts],
      iterations: 0,
      acceptedMoves: 0,
    });
  }
  const iterations = Math.min(opts.iterations ?? Math.max(4000, 60 * ctx.total), 40000);
  const p1 = anneal(days, ctx, rng, { iterations, t0: 1.5, t1: 0.02, key: 'balance' });
  const afterPhase1 = analyse(days, ctx);
  const p2 = anneal(days, ctx, rng, {
    iterations,
    t0: 4,
    t1: 0.02,
    key: 'gap',
    balanceCap: afterPhase1.balance,
  });
  polish(days, ctx, rng, { tries: 3000, balanceCap: afterPhase1.balance });
  const after = analyse(days, ctx);
  return finish({
    balanceAfterPhase1: afterPhase1.balance,
    gapAfterPhase1: afterPhase1.gap,
    balanceAfter: after.balance,
    gapAfter: after.gap,
    countsAfter: [...after.counts],
    iterations: iterations * 2,
    acceptedMoves: p1.accepted + p2.accepted,
  });
}

/**
 * The wired-up generation path (used by the Generate button): greedy
 * routine, then the optimizer, then a tag distribution recomputed from
 * the optimized days. Returns the same { days, tagDistribution } shape
 * as generateRoutine, plus the optimizer stats.
 */
export function generateOptimizedRoutine(program, exclusionGroups = [], inclusionGroups = [], opts = {}) {
  const gen = generateRoutine(program, exclusionGroups, inclusionGroups);
  const { days, stats } = optimizeRoutine(program, gen.days, exclusionGroups, inclusionGroups, opts);
  return { days, tagDistribution: computeTagDistribution(days), stats };
}
