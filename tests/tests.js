// Node tests for the front-only Practiae port. Run: node tests/tests.js
// Generation is randomised (random start day, as in utils.py), so tests
// assert invariants that hold on every run, over several repetitions.
import assert from 'node:assert/strict';
import { generateRoutine, pieceLabel, parseDayPattern, computeTagDistribution } from '../js/generate.js';
import { optimizeRoutine, analyseRoutine, generateOptimizedRoutine } from '../js/optimize.js';
import { monLikeProgram } from './mon-like-program.mjs';
import { normaliseDoc, normaliseProgram, blankProgram, seedFromDefault, groupsAsRanks, percToGap, gapToPerc, convertMode } from '../js/store.js';
import { buildSession, pieceStatus, dueLabel, todayStr, daysBetween, formatDayLabel, lastPlayedById, playedIdsOn } from '../js/session.js';
import { formatDuration, parseDuration, freqDays, snapPerc, freqLabel, durationFromMinSec } from '../js/utils.js';
import { readFileSync } from 'node:fs';

const mkPiece = (over) => ({ id: over.id ?? `p${over.rank}`, rank: over.rank, title: over.title ?? `Piece ${over.rank}`,
  composer: over.composer ?? '', perc: over.perc ?? 100, tags: over.tags ?? [], day_pattern: over.day_pattern ?? null,
  notes: '', duration_min: over.duration_min ?? 0 });
const mkProg = (pieces, numDays = 8) => ({ num_days: numDays, pieces });

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

// 100% pieces appear every day, 50% appear on ~half the days, 0% never.
check('frequency counts match perc', () => {
  for (let run = 0; run < 10; run++) {
    const pieces = [mkPiece({ rank: 0, perc: 100 }), mkPiece({ rank: 1, perc: 50 }), mkPiece({ rank: 2, perc: 0 })];
    const { days } = generateRoutine(mkProg(pieces));
    assert.equal(days.flat().filter((p) => p.rank === 0).length, 8);
    assert.equal(days.flat().filter((p) => p.rank === 1).length, 4);
    assert.equal(days.flat().filter((p) => p.rank === 2).length, 0);
    // never twice on the same day
    for (const day of days) assert.equal(new Set(day.map((p) => p.rank)).size, day.length);
  }
});

// Fixed day patterns are honoured exactly and never moved by groups.
check('fixed day_pattern honoured', () => {
  const pieces = [mkPiece({ rank: 0, perc: 100, day_pattern: [0, 2, 6] }), mkPiece({ rank: 1, perc: 100 })];
  const { days } = generateRoutine(mkProg(pieces));
  assert.deepEqual(days.map((d, i) => (d.some((p) => p.rank === 0) ? i : -1)).filter((i) => i >= 0), [0, 2, 6]);
});

// Exclusion: two movable pieces in a group never share a day.
check('exclusion groups separate movable pieces', () => {
  for (let run = 0; run < 10; run++) {
    const pieces = [mkPiece({ rank: 0, perc: 50 }), mkPiece({ rank: 1, perc: 50 }), mkPiece({ rank: 2, perc: 50 })];
    const { days } = generateRoutine(mkProg(pieces), [[0, 1]], []);
    for (const day of days) assert.ok(!(day.some((p) => p.rank === 0) && day.some((p) => p.rank === 1)), 'excluded pair co-occurred');
  }
});

// Inclusion: grouped pieces share exactly the same days.
check('inclusion groups share days', () => {
  for (let run = 0; run < 10; run++) {
    const pieces = [mkPiece({ rank: 0, perc: 50 }), mkPiece({ rank: 1, perc: 25 }), mkPiece({ rank: 2, perc: 100 })];
    const { days } = generateRoutine(mkProg(pieces), [], [[0, 1]]);
    const d0 = days.map((d, i) => (d.some((p) => p.rank === 0) ? i : -1)).filter((i) => i >= 0);
    const d1 = days.map((d, i) => (d.some((p) => p.rank === 1) ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(d0, d1);
  }
});

check('pieceLabel matches Piece.__str__ (Chap./Mod. + Répertoire)', () => {
  assert.equal(pieceLabel({ title: 'Étude', composer: 'Chopin', tags: ['Chap. III. Mod. 1'] }), '[III. 1] Étude, Chopin');
  assert.equal(pieceLabel({ title: 'X', composer: '', tags: ['Répertoire'] }), '[Rép] X');
  assert.equal(pieceLabel({ title: 'X', composer: 'Y', tags: [] }), 'X, Y');
});

check('parseDayPattern', () => {
  assert.deepEqual(parseDayPattern('0,2,6', 8), [0, 2, 6]);
  assert.deepEqual(parseDayPattern('1-3', 8), [1, 2, 3]);
  assert.equal(parseDayPattern('', 8), null);
  assert.deepEqual(parseDayPattern('0, 99', 8), [0]);
});

check('tag distribution sums to per-day piece counts', () => {
  const pieces = [mkPiece({ rank: 0, perc: 100, tags: ['A'], duration_min: 10 }), mkPiece({ rank: 1, perc: 100, tags: ['A', 'B'], duration_min: 5 })];
  const { days, tagDistribution } = generateRoutine(mkProg(pieces));
  assert.deepEqual(tagDistribution.tags, ['A', 'B']);
  days.forEach((_, d) => {
    assert.equal(tagDistribution.by_count.A[d], 2);
    assert.equal(tagDistribution.by_count.B[d], 1);
    assert.equal(tagDistribution.by_duration.A[d], 15);
  });
  assert.equal(computeTagDistribution(days).tags.length, 2);
});

check('store: Flask rank groups convert to id groups on import', () => {
  const doc = normaliseDoc({ programs: [{ name: 'P', num_days: 4, pieces: [
    { title: 'A', perc: 100 }, { title: 'B', perc: 100 } ],
    exclusion_groups: [[0, 1]], inclusion_groups: [] }] });
  const p = doc.programs[0];
  assert.equal(p.exclusion_groups.length, 1);
  assert.deepEqual(p.exclusion_groups[0], [p.pieces[0].id, p.pieces[1].id]);
  const { exclusion } = groupsAsRanks(p);
  assert.deepEqual(exclusion, [[0, 1]]);
});

check('store: bundled default routine seeds one program', () => {
  const raw = JSON.parse(readFileSync(new URL('../data/default_routine.json', import.meta.url), 'utf8'));
  const doc = seedFromDefault(raw);
  assert.equal(doc.programs.length, 1);
  assert.equal(doc.programs[0].pieces.length, 68);
  assert.equal(doc.programs[0].num_days, 8);
  assert.ok(doc.programs[0].pieces.every((p) => p.id && p.rank >= 0));
});

// Durations display as m:ss, as in the Flask routine table — never a raw
// float ("2.3333333333333335"). Seconds truncate, as the Flask template does.
// Frequency slider: the day grid snaps in JS (snapPerc), not via a native
// step — Chromium cannot hold 100/num_days as a native step (at 3 days it
// clamps the slider's max to 66.67%). Labels show days, not percent.
check('frequency snaps to the day grid', () => {
  assert.equal(freqDays(100, 8), 8);
  assert.equal(freqDays(50, 8), 4);
  assert.equal(freqDays(25, 8), 2);
  assert.equal(freqDays(30, 8), 2); // off-grid perc rounds like the generator's k
  assert.equal(freqDays(0, 8), 0);
  assert.equal(snapPerc(0, 8), 0); // 0 stays 0
  assert.equal(snapPerc(30, 8), 25);
  assert.equal(snapPerc(5, 8), 12.5); // at least one day
  assert.equal(snapPerc(90, 16), 87.5);
  assert.equal(snapPerc(100, 16), 100);
  assert.equal(snapPerc(100, 3), 100); // 100 must stay exactly 100, not 100.00000000000001
  assert.equal(freqLabel(100, 8), '8 days');
  assert.equal(freqLabel(12.5, 8), '1 day');
  assert.equal(freqLabel(0, 8), '0 days');
});

// Duration edit: two boxes (minutes + seconds) combine to a float.
check('durationFromMinSec combines min and sec', () => {
  assert.equal(durationFromMinSec(2, 20), 2 + 20 / 60);
  assert.equal(durationFromMinSec(0, 30), 0.5);
  assert.equal(durationFromMinSec(2, NaN), 2); // blank seconds
  assert.equal(durationFromMinSec(NaN, NaN), 0); // both blank
  assert.equal(durationFromMinSec(-1, 90), 1.5); // negatives clamp, seconds overflow normalises on display
});

check('formatDuration renders m:ss', () => {
  assert.equal(formatDuration(2), '2:00');
  assert.equal(formatDuration(2.3333333333333335), '2:20');
  assert.equal(formatDuration(0.5), '0:30');
  assert.equal(formatDuration(1.999), '1:59');
  assert.equal(formatDuration(65), '65:00');
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(undefined), '');
});

// The edit box shows m:ss and must read it back — a plain parseFloat
// would turn "2:20" into 2 minutes. A bare number is still minutes.
check('parseDuration reads m:ss and plain minutes', () => {
  assert.equal(parseDuration('2:20'), 2 + 20 / 60);
  assert.equal(parseDuration('2:00'), 2);
  assert.equal(parseDuration('0:30'), 0.5);
  assert.equal(parseDuration('2.5'), 2.5);
  assert.equal(parseDuration('2'), 2);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration('abc'), 0);
  assert.equal(parseDuration('-1'), 0);
  assert.equal(parseDuration(' 2:20 '), 2 + 20 / 60);
  assert.equal(formatDuration(parseDuration('2:20')), '2:20');
  assert.equal(formatDuration(parseDuration('2.5')), '2:30');
});

// --- Routine optimizer (js/optimize.js) ---

const optCountOf = (days) => {
  const m = new Map();
  for (const day of days) for (const p of day) m.set(p.rank, (m.get(p.rank) || 0) + 1);
  return m;
};
const optDaysOf = (days, rank) => days.map((d, i) => (d.some((p) => p.rank === rank) ? i : -1)).filter((i) => i >= 0);

check('optimizer: flattens Mon-like counts, keeps constraints, deterministic', () => {
  for (let run = 0; run < 3; run++) {
    const { program, exclusionGroups, inclusionGroups } = monLikeProgram();
    const { days: greedy } = generateRoutine(program, exclusionGroups, inclusionGroups);
    const before = analyseRoutine(greedy, program, exclusionGroups, inclusionGroups);
    assert.ok(before.balance > 0, 'greedy input should be unbalanced here');
    const { days, stats } = optimizeRoutine(program, greedy, exclusionGroups, inclusionGroups, { seed: 7 });
    const again = optimizeRoutine(program, greedy, exclusionGroups, inclusionGroups, { seed: 7 });
    assert.deepEqual(days, again.days, 'same input + seed must give the same routine');
    // Per-piece occurrence counts preserved, never twice on a day.
    assert.deepEqual(optCountOf(days), optCountOf(greedy));
    for (const day of days) assert.equal(new Set(day.map((p) => p.rank)).size, day.length);
    // Fixed-day pieces unmoved.
    for (const p of program.pieces) {
      if (p.day_pattern != null) assert.deepEqual(optDaysOf(days, p.rank), p.day_pattern);
    }
    // Exclusion pairs never share a day.
    for (const [a, b] of exclusionGroups) {
      for (const day of days) assert.ok(!(day.some((p) => p.rank === a) && day.some((p) => p.rank === b)));
    }
    // Balance flat (256 over 16 days = exactly 16/day) and gaps way down.
    assert.equal(stats.balanceAfter, 0);
    assert.deepEqual(stats.countsAfter, new Array(16).fill(16));
    assert.ok(stats.gapAfter < stats.gapBefore, `gap ${stats.gapAfter} should beat greedy ${stats.gapBefore}`);
    assert.ok(stats.gapAfter <= stats.gapAfterPhase1, 'phase 2 must not worsen gaps');
  }
});

check('optimizer: inclusion groups stay together', () => {
  const pieces = [
    mkPiece({ rank: 0, perc: 50 }),
    mkPiece({ rank: 1, perc: 50 }),
    mkPiece({ rank: 2, perc: 25 }),
    mkPiece({ rank: 3, perc: 25 }),
  ];
  for (let run = 0; run < 5; run++) {
    const { days: greedy } = generateRoutine(mkProg(pieces), [], [[0, 1]]);
    const { days } = optimizeRoutine(mkProg(pieces), greedy, [], [[0, 1]], { seed: 3 });
    assert.deepEqual(optDaysOf(days, 0), optDaysOf(days, 1), 'inclusion members must share days');
    assert.deepEqual(optCountOf(days), optCountOf(greedy));
  }
});

check('optimizer: small hand-built unbalanced routine gets flattened', () => {
  const [A, B, C] = [mkPiece({ rank: 0 }), mkPiece({ rank: 1 }), mkPiece({ rank: 2 })];
  const prog = mkProg([A, B, C], 4);
  const days = [[A, B, C], [A, B], [], [C]];
  const before = analyseRoutine(days, prog);
  assert.equal(before.balance, 5); // counts 3,2,0,1 vs mean 1.5
  assert.equal(before.gap, 6);
  const { days: out, stats } = optimizeRoutine(prog, days, [], [], { seed: 1 });
  assert.deepEqual([...stats.countsAfter].sort((a, b) => a - b), [1, 1, 2, 2]);
  assert.ok(stats.gapAfter < 6, `gap ${stats.gapAfter} should beat 6`);
  assert.deepEqual(optCountOf(out), new Map([[0, 2], [1, 2], [2, 2]]));
});

check('optimizer: duration mode balances minutes per day', () => {
  for (let run = 0; run < 3; run++) {
    const { program, exclusionGroups, inclusionGroups } = monLikeProgram();
    const { days: greedy } = generateRoutine(program, exclusionGroups, inclusionGroups);
    const before = analyseRoutine(greedy, program, exclusionGroups, inclusionGroups, { balanceBy: 'duration' });
    assert.ok(before.balance > 0, 'greedy minutes should be unbalanced here');
    const { days, stats } = optimizeRoutine(program, greedy, exclusionGroups, inclusionGroups, { seed: 7, balanceBy: 'duration' });
    assert.equal(stats.balanceBy, 'duration');
    // Same hard constraints as pieces mode.
    assert.deepEqual(optCountOf(days), optCountOf(greedy));
    for (const day of days) assert.equal(new Set(day.map((p) => p.rank)).size, day.length);
    for (const p of program.pieces) {
      if (p.day_pattern != null) assert.deepEqual(optDaysOf(days, p.rank), p.day_pattern);
    }
    for (const [a, b] of exclusionGroups) {
      for (const day of days) assert.ok(!(day.some((p) => p.rank === a) && day.some((p) => p.rank === b)));
    }
    // Minutes nearly flat (mean 73.3, so 73/74 is the floor) and gaps down.
    const mins = stats.loadsAfter;
    assert.ok(stats.balanceAfter < stats.balanceBefore, `duration balance ${stats.balanceBefore} -> ${stats.balanceAfter}`);
    assert.ok(Math.max(...mins) - Math.min(...mins) <= 2, `minute spread ${Math.max(...mins) - Math.min(...mins)}`);
    assert.ok(stats.gapAfter < stats.gapBefore, `gap ${stats.gapBefore} -> ${stats.gapAfter}`);
    // The wired path with the option: its own minutes flat, same shape.
    const wired = generateOptimizedRoutine(program, exclusionGroups, inclusionGroups, { seed: 7, balanceBy: 'duration' });
    assert.equal(wired.stats.balanceBy, 'duration');
    const wmins = wired.stats.loadsAfter;
    assert.ok(Math.max(...wmins) - Math.min(...wmins) <= 2, `wired minute spread ${Math.max(...wmins) - Math.min(...wmins)}`);
    assert.equal(wired.days.length, 16);
  }
});

check('store: balance_by defaults to pieces, validates on load', () => {
  assert.equal(blankProgram().balance_by, 'pieces');
  assert.equal(normaliseProgram({ name: 'X', pieces: [] }).balance_by, 'pieces');
  assert.equal(normaliseProgram({ name: 'X', pieces: [], balance_by: 'duration' }).balance_by, 'duration');
  assert.equal(normaliseProgram({ name: 'X', pieces: [], balance_by: 'weird' }).balance_by, 'pieces');
});

check('optimizer: generateOptimizedRoutine is the wired Generate path', () => {
  for (let run = 0; run < 3; run++) {
    const { program, exclusionGroups, inclusionGroups } = monLikeProgram();
    const { days, tagDistribution, stats } = generateOptimizedRoutine(program, exclusionGroups, inclusionGroups, { seed: 7 });
    // Same shape as generateRoutine: 16 days, flat 16/day, tags recomputed.
    assert.equal(days.length, 16);
    assert.deepEqual(days.map((d) => d.length), new Array(16).fill(16));
    assert.equal(stats.balanceAfter, 0);
    days.forEach((day, d) => {
      const expected = day.reduce((s, p) => s + (p.tags || []).length, 0);
      const actual = tagDistribution.tags.reduce((s, t) => s + tagDistribution.by_count[t][d], 0);
      assert.equal(actual, expected, `day ${d} tag occurrences`);
    });
  }
});

check('optimizer: single-day and all-fixed programs return unchanged', () => {
  const p1 = mkPiece({ rank: 0, perc: 100 });
  const { days: d1 } = generateRoutine(mkProg([p1], 1));
  assert.deepEqual(optimizeRoutine(mkProg([p1], 1), d1).days, d1);
  const f1 = mkPiece({ rank: 0, perc: 100, day_pattern: [0, 2] });
  const f2 = mkPiece({ rank: 1, perc: 100, day_pattern: [1, 3] });
  const { days: d2 } = generateRoutine(mkProg([f1, f2], 4));
  assert.deepEqual(optimizeRoutine(mkProg([f1, f2], 4), d2).days, d2);
});

// ---------- gap scheduling (docs/gap-scheduling.md) ----------
const T = '2026-11-20'; // fixed "today" so the tests are deterministic
const mkGapPiece = (over) => ({ id: over.id ?? `g${over.rank}`, rank: over.rank,
  title: over.title ?? `Piece ${over.rank}`, composer: '', gap: over.gap ?? 0,
  tags: over.tags ?? [], duration_min: over.duration_min ?? 10 });
const mkGapProg = (pieces, over = {}) => ({ mode: 'gap', num_days: 8, pieces,
  session_minutes: over.session_minutes ?? 60, play_log: over.play_log ?? [],
  exclusion_groups: over.exclusion_groups ?? [], inclusion_groups: over.inclusion_groups ?? [] });
const pickedTitles = (s) => s.data.flat();

check('gap: date helpers', () => {
  assert.equal(daysBetween('2026-11-18', '2026-11-20'), 2);
  assert.equal(daysBetween('2026-11-20', '2026-11-18'), -2);
  assert.equal(formatDayLabel('2026-11-20'), 'Fri 20 Nov');
  assert.equal(formatDayLabel('2026-11-21'), 'Sat 21 Nov');
  assert.equal(todayStr(new Date(2026, 10, 20, 12)), '2026-11-20');
  const last = lastPlayedById([{ date: '2026-11-18', piece_id: 'a' }, { date: '2026-11-19', piece_id: 'a' }, { date: '2026-11-17', piece_id: 'b' }]);
  assert.equal(last.get('a'), '2026-11-19');
  assert.equal(last.get('b'), '2026-11-17');
  assert.deepEqual([...playedIdsOn([{ date: '2026-11-20', piece_id: 'a' }, { date: '2026-11-19', piece_id: 'b' }], '2026-11-20')], ['a']);
});

check('gap: due/overdue math and labels', () => {
  const daily = mkGapPiece({ rank: 0, gap: 0 });
  assert.deepEqual(pieceStatus(daily, null, T), { since: Infinity, dueIn: -Infinity, overdue: Infinity, never: true });
  assert.equal(dueLabel(daily, null, T), 'never played');
  assert.equal(dueLabel(daily, '2026-11-20', T), 'due in 1d'); // played today, next due tomorrow
  assert.equal(dueLabel(daily, '2026-11-19', T), 'due today');
  assert.equal(dueLabel(daily, '2026-11-18', T), 'overdue 1d');
  const everyOther = mkGapPiece({ rank: 1, gap: 1 });
  assert.equal(dueLabel(everyOther, '2026-11-19', T), 'due in 1d'); // played yesterday, next due tomorrow
  assert.equal(dueLabel(everyOther, '2026-11-18', T), 'due today');
  assert.equal(dueLabel(everyOther, '2026-11-20', T), 'due in 2d');
  const weekly = mkGapPiece({ rank: 2, gap: 6 });
  assert.equal(dueLabel(weekly, '2026-11-19', T), 'due in 6d');
  assert.equal(dueLabel(weekly, '2026-11-13', T), 'due today'); // period 7, played 7 days ago
  assert.equal(dueLabel(weekly, '2026-11-10', T), 'overdue 3d');
});

check('gap: cold start picks never-played by gap order within the cap', () => {
  const pieces = [mkGapPiece({ rank: 0, gap: 2, duration_min: 30 }), mkGapPiece({ rank: 1, gap: 0, duration_min: 30 }), mkGapPiece({ rank: 2, gap: 1, duration_min: 30 })];
  const s = buildSession(mkGapProg(pieces, { session_minutes: 60 }), T);
  assert.deepEqual(pickedTitles(s), ['Piece 1', 'Piece 2']); // gap 0, then gap 1; gap 2 does not fit
  assert.equal(s.totalMinutes, 60);
  assert.equal(s.columns.length, 1);
  assert.equal(s.date, T);
  assert.deepEqual(s.pickedIds, ['g1', 'g2']);
  assert.deepEqual(s.ids, [['g1'], ['g2']]);
});

check('gap: most overdue first, cap respected, deterministic', () => {
  const log = [{ date: '2026-11-10', piece_id: 'g0' }, { date: '2026-11-18', piece_id: 'g1' }, { date: '2026-11-19', piece_id: 'g2' }];
  const pieces = [mkGapPiece({ rank: 0, gap: 0, duration_min: 40 }), mkGapPiece({ rank: 1, gap: 0, duration_min: 40 }), mkGapPiece({ rank: 2, gap: 0, duration_min: 40 })];
  // g0: 9 days overdue; g1: 1 day; g2: due today. Cap 60 fits only one 40-min piece.
  const s1 = buildSession(mkGapProg(pieces, { session_minutes: 60, play_log: log }), T);
  const s2 = buildSession(mkGapProg(pieces, { session_minutes: 60, play_log: log }), T);
  assert.deepEqual(pickedTitles(s1), ['Piece 0']);
  assert.deepEqual(s1, s2); // deterministic
  assert.ok(s1.totalMinutes <= 60);
});

check('gap: fill pulls in pieces due tomorrow, never pieces due later or played today', () => {
  const pieces = [mkGapPiece({ rank: 0, gap: 0, duration_min: 10 }), mkGapPiece({ rank: 1, gap: 1, duration_min: 10 }), mkGapPiece({ rank: 2, gap: 6, duration_min: 10 })];
  // g0 (gap 0, played yesterday): due today. g1 (gap 1, played yesterday):
  // due tomorrow — pulled in by the fill. g2 (gap 6): due in 6 days, never.
  const s = buildSession(mkGapProg(pieces, { session_minutes: 60,
    play_log: [{ date: '2026-11-19', piece_id: 'g0' }, { date: '2026-11-19', piece_id: 'g1' }, { date: '2026-11-19', piece_id: 'g2' }] }), T);
  assert.deepEqual(pickedTitles(s), ['Piece 0', 'Piece 1']);
  // Same, but g1 was played today: due in 2 days and played today, so the
  // fill must not pull it back in for a second play the same day.
  const s2 = buildSession(mkGapProg(pieces, { session_minutes: 60,
    play_log: [{ date: '2026-11-19', piece_id: 'g0' }, { date: '2026-11-20', piece_id: 'g1' }, { date: '2026-11-19', piece_id: 'g2' }] }), T);
  assert.deepEqual(pickedTitles(s2), ['Piece 0']);
});

check('gap: exclusion picks at most one member, inclusion is all-or-nothing', () => {
  const pieces = [mkGapPiece({ rank: 0, gap: 0, duration_min: 15 }), mkGapPiece({ rank: 1, gap: 0, duration_min: 15 }), mkGapPiece({ rank: 2, gap: 0, duration_min: 20 }), mkGapPiece({ rank: 3, gap: 0, duration_min: 20 })];
  const excl = buildSession(mkGapProg(pieces, { exclusion_groups: [['g0', 'g1']] }), T);
  assert.equal(pickedTitles(excl).filter((t) => t === 'Piece 0' || t === 'Piece 1').length, 1);
  assert.equal(pickedTitles(excl).length, 3); // g2, g3 plus one of g0/g1
  // Inclusion unit (g0+g1 = 30 min) fits in 70; both are picked together.
  const incl = buildSession(mkGapProg(pieces, { session_minutes: 70, inclusion_groups: [['g0', 'g1']] }), T);
  assert.ok(pickedTitles(incl).includes('Piece 0') && pickedTitles(incl).includes('Piece 1'));
  assert.equal(pickedTitles(incl).length, 4);
  // Inclusion unit (30 min) does not fit in 25 — neither is picked.
  const inclTight = buildSession(mkGapProg(pieces, { session_minutes: 25, inclusion_groups: [['g0', 'g1']] }), T);
  assert.ok(!pickedTitles(inclTight).includes('Piece 0') && !pickedTitles(inclTight).includes('Piece 1'));
  assert.deepEqual(pickedTitles(inclTight), ['Piece 2']); // 20 min fits; g3 does not fit after it
});

check('gap: warnings for too-long units, unsatisfiable units, and empty sessions', () => {
  const pieces = [mkGapPiece({ rank: 0, gap: 0, duration_min: 90 }), mkGapPiece({ rank: 1, gap: 0, duration_min: 10 })];
  const s = buildSession(mkGapProg(pieces, { session_minutes: 60 }), T);
  assert.deepEqual(pickedTitles(s), ['Piece 1']);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /longer than the session cap/);
  // Inclusion overlapping exclusion: the unit can never be scheduled.
  const bad = buildSession(mkGapProg(pieces, { session_minutes: 60, inclusion_groups: [['g0', 'g1']], exclusion_groups: [['g0', 'g1']] }), T);
  assert.equal(bad.warnings.filter((w) => /never be scheduled/.test(w)).length, 1);
  // Nothing due: all played recently with long gaps.
  const log = [{ date: '2026-11-20', piece_id: 'g0' }, { date: '2026-11-20', piece_id: 'g1' }];
  const rested = buildSession(mkGapProg(
    [mkGapPiece({ rank: 0, gap: 6, duration_min: 10 }), mkGapPiece({ rank: 1, gap: 6, duration_min: 10 })],
    { session_minutes: 60, play_log: log }), T);
  assert.deepEqual(pickedTitles(rested), []);
  assert.ok(rested.warnings.some((w) => /Nothing due today/.test(w)));
});

check('gap: a ticked piece is not in the next session the same day', () => {
  const pieces = [mkGapPiece({ rank: 0, gap: 0, duration_min: 10 }), mkGapPiece({ rank: 1, gap: 0, duration_min: 10 })];
  const prog = mkGapProg(pieces, { session_minutes: 60 });
  const s1 = buildSession(prog, T);
  assert.deepEqual(pickedTitles(s1), ['Piece 0', 'Piece 1']);
  // Tick Piece 0 today (as the day view does), then regenerate.
  prog.play_log.push({ date: T, piece_id: 'g0' });
  const s2 = buildSession(prog, T);
  assert.deepEqual(pickedTitles(s2), ['Piece 1']);
});

check('gap: perc <-> gap conversion round-trips the common cases', () => {
  assert.equal(percToGap(100, 8), 0);
  assert.equal(percToGap(50, 8), 1);
  assert.equal(percToGap(12.5, 8), 7);
  assert.equal(percToGap(0, 8), 30);
  assert.equal(gapToPerc(0, 8), 100);
  assert.equal(gapToPerc(1, 8), 50);
  assert.equal(gapToPerc(7, 8), 12.5);
  assert.equal(gapToPerc(30, 8), 0);
  // Mode switch converts every piece and clears the routine.
  const p = normaliseProgram({ name: 'P', num_days: 8, pieces: [{ title: 'A', perc: 50 }, { title: 'B', perc: 100 }], pinned_routine: { columns: ['x'] }, is_routine_pinned: true });
  convertMode(p, 'gap');
  assert.equal(p.mode, 'gap');
  assert.deepEqual(p.pieces.map((x) => x.gap), [1, 0]);
  assert.equal(p.pinned_routine, null);
  convertMode(p, 'frequency');
  assert.equal(p.mode, 'frequency');
  assert.deepEqual(p.pieces.map((x) => x.perc), [50, 100]);
});

check('gap: normalise defaults mode/gap/log and prunes the log', () => {
  const p = normaliseProgram({ name: 'P', pieces: [{ title: 'A' }] });
  assert.equal(p.mode, 'frequency');
  assert.equal(p.session_minutes, 60);
  assert.deepEqual(p.play_log, []);
  assert.equal(p.pieces[0].gap, 0);
  const old = '2020-01-01';
  const recent = todayStr();
  const p2 = normaliseProgram({ name: 'P', mode: 'gap', session_minutes: 45,
    pieces: [{ id: 'x', title: 'A' }],
    play_log: [{ date: old, piece_id: 'x' }, { date: recent, piece_id: 'x' }, { date: recent, piece_id: 'x' }, { date: recent, piece_id: 'ghost' }] });
  assert.equal(p2.mode, 'gap');
  assert.equal(p2.session_minutes, 45);
  assert.deepEqual(p2.play_log, [{ date: recent, piece_id: 'x' }]); // old pruned, duplicate + ghost dropped
});

console.log(`\n${passed} tests passed`);