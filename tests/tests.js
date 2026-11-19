// Node tests for the front-only Practiae port. Run: node tests/tests.js
// Generation is randomised (random start day, as in utils.py), so tests
// assert invariants that hold on every run, over several repetitions.
import assert from 'node:assert/strict';
import { generateRoutine, pieceLabel, parseDayPattern, computeTagDistribution } from '../js/generate.js';
import { normaliseDoc, seedFromDefault, groupsAsRanks } from '../js/store.js';
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

console.log(`\n${passed} tests passed`);
