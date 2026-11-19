// Node tests for the front-only Practiae port. Run: node tests/tests.js
// Generation is randomised (random start day, as in utils.py), so tests
// assert invariants that hold on every run, over several repetitions.
import assert from 'node:assert/strict';
import { generateRoutine, pieceLabel, parseDayPattern, computeTagDistribution } from '../js/generate.js';
import { optimizeRoutine, analyseRoutine, generateOptimizedRoutine } from '../js/optimize.js';
import { monLikeProgram } from './mon-like-program.mjs';
import { normaliseDoc, normaliseProgram, blankProgram, seedFromDefault, groupsAsRanks } from '../js/store.js';
import { formatDuration, parseDuration } from '../js/utils.js';
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

console.log(`\n${passed} tests passed`);
