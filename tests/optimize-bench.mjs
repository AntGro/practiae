// Bench the routine optimizer on a Mon-Programme-like program.
// Run: node tests/optimize-bench.mjs
// Prints greedy vs optimized per-day counts, balance/gap scores, runtime,
// and verifies every hard constraint still holds.
import { generateRoutine } from '../js/generate.js';
import { optimizeRoutine, analyseRoutine } from '../js/optimize.js';
import { monLikeProgram } from './mon-like-program.mjs';

function checkConstraints(program, before, after, exclusionGroups) {
  const problems = [];
  const countOf = (days) => {
    const m = new Map();
    for (const day of days) for (const p of day) m.set(p.rank, (m.get(p.rank) || 0) + 1);
    return m;
  };
  const cb = countOf(before);
  const ca = countOf(after);
  for (const [rank, k] of cb) {
    if (ca.get(rank) !== k) problems.push(`piece ${rank} count changed ${k} -> ${ca.get(rank)}`);
  }
  for (const day of after) {
    if (new Set(day.map((p) => p.rank)).size !== day.length) problems.push('piece twice on one day');
  }
  for (const p of program.pieces) {
    if (p.day_pattern == null) continue;
    const days = after.map((d, i) => (d.some((x) => x.rank === p.rank) ? i : -1)).filter((i) => i >= 0);
    if (JSON.stringify(days) !== JSON.stringify(p.day_pattern)) {
      problems.push(`fixed piece ${p.rank} moved off ${JSON.stringify(p.day_pattern)}`);
    }
  }
  for (const [a, b] of exclusionGroups) {
    for (const day of after) {
      if (day.some((p) => p.rank === a) && day.some((p) => p.rank === b)) {
        problems.push(`excluded pair ${a}/${b} shares a day`);
      }
    }
  }
  return problems;
}

const { program, exclusionGroups, inclusionGroups } = monLikeProgram();
const { days: greedy } = generateRoutine(program, exclusionGroups, inclusionGroups);
const before = analyseRoutine(greedy, program, exclusionGroups, inclusionGroups);
console.log('greedy counts :', before.counts.join(' '));
console.log(`greedy balance: ${before.balance.toFixed(1)}  gap: ${before.gap.toFixed(1)}`);

for (const seed of [1, 2, 3]) {
  const { days, stats } = optimizeRoutine(program, greedy, exclusionGroups, inclusionGroups, { seed });
  const problems = checkConstraints(program, greedy, days, exclusionGroups);
  console.log(`\nseed ${seed} (${stats.runtimeMs}ms, ${stats.acceptedMoves} accepted moves)`);
  console.log('  counts after:', stats.countsAfter.join(' '));
  console.log(`  balance: ${stats.balanceBefore.toFixed(1)} -> ${stats.balanceAfterPhase1.toFixed(1)} (phase 1) -> ${stats.balanceAfter.toFixed(1)}`);
  console.log(`  gap:     ${stats.gapBefore.toFixed(1)} -> ${stats.gapAfterPhase1.toFixed(1)} (phase 1) -> ${stats.gapAfter.toFixed(1)}`);
  console.log('  constraints:', problems.length ? `BROKEN: ${problems.join('; ')}` : 'all hold');
}

// Duration mode: same greedy start, but flatten minutes per day instead
// of piece counts. Minutes per day use the same loads array (loads ==
// counts in pieces mode, minutes in duration mode).
const beforeDur = analyseRoutine(greedy, program, exclusionGroups, inclusionGroups, { balanceBy: 'duration' });
console.log('\ngreedy minutes:', beforeDur.loads.join(' '));
console.log(`greedy duration-balance: ${beforeDur.balance.toFixed(1)}  gap: ${beforeDur.gap.toFixed(1)}`);
for (const seed of [1, 2, 3]) {
  const { days, stats } = optimizeRoutine(program, greedy, exclusionGroups, inclusionGroups, { seed, balanceBy: 'duration' });
  const problems = checkConstraints(program, greedy, days, exclusionGroups);
  const mins = stats.loadsAfter;
  console.log(`\nseed ${seed} duration mode (${stats.runtimeMs}ms, ${stats.acceptedMoves} accepted moves)`);
  console.log('  minutes after:', mins.map((m) => Math.round(m)).join(' '), `(spread ${Math.round(Math.max(...mins) - Math.min(...mins))} min, greedy spread ${Math.round(Math.max(...beforeDur.loads) - Math.min(...beforeDur.loads))})`);
  console.log('  counts after: ', stats.countsAfter.join(' '));
  console.log(`  duration-balance: ${stats.balanceBefore.toFixed(1)} -> ${stats.balanceAfterPhase1.toFixed(1)} (phase 1) -> ${stats.balanceAfter.toFixed(1)}`);
  console.log(`  gap: ${stats.gapBefore.toFixed(1)} -> ${stats.gapAfterPhase1.toFixed(1)} (phase 1) -> ${stats.gapAfter.toFixed(1)}`);
  console.log('  constraints:', problems.length ? `BROKEN: ${problems.join('; ')}` : 'all hold');
}
