// Synthetic stand-in for the user's "Mon Programme": 16 days, 68 pieces,
// 4 fixed odd/even exercises, mixed frequencies totalling 256 piece-days
// (mean exactly 16/day), 3 exclusion pairs. Mirrors the shape of the real
// program, whose greedy routine lands at 15-17 pieces per day.
import { readFileSync } from 'node:fs';

export function monLikeProgram() {
  const raw = JSON.parse(readFileSync(new URL('../data/default_routine.json', import.meta.url), 'utf8'));
  const pieces = raw.pieces.map((p, i) => ({
    ...p,
    id: `p${i}`,
    rank: i,
    day_pattern: null,
    // Deterministic varied durations (1-8 min, period 8) so the
    // duration-balance mode has something to flatten.
    duration_min: 1 + ((i * 5) % 8),
  }));
  const odd = [0, 2, 4, 6, 8, 10, 12, 14];
  const even = [1, 3, 5, 7, 9, 11, 13, 15];
  pieces[0].day_pattern = odd;
  pieces[1].day_pattern = even;
  pieces[2].day_pattern = odd;
  pieces[3].day_pattern = even;
  // Six more pieces fixed to skewed days: this is what makes the greedy
  // routine land at 15-17 (balance 4-8) instead of flat 16, as in the real
  // program. Three k=2 pieces become k=3 so the total stays 256 (mean 16).
  const skewed = [[0], [0, 1], [4], [4, 5], [8], [8, 9]];
  skewed.forEach((pat, i) => {
    pieces[36 + i].day_pattern = pat;
  });
  for (let i = 4; i < 12; i++) pieces[i].perc = 50; // k = 8
  for (let i = 12; i < 24; i++) pieces[i].perc = 30; // k = 5, ideal gap 3.2
  for (let i = 24; i < 36; i++) pieces[i].perc = 20; // k = 3, ideal gap 5.33
  for (let i = 36; i < 68; i++) pieces[i].perc = 12.5; // k = 2
  // Mixed-frequency exclusion pairs: the two members of a pair end up on
  // complementary day sets, which is what makes the greedy routine land at
  // 15-17 (balance 2-8) instead of flat 16, as in the real program.
  pieces[5].perc = 25; // k = 4
  pieces[7].perc = 20; // k = 3
  pieces[8].perc = 30; // k = 5
  pieces[9].perc = 30; // k = 5
  for (let i = 42; i < 60; i++) pieces[i].perc = 20; // k = 3 (keeps total 256)
  return {
    program: { num_days: 16, pieces },
    exclusionGroups: [
      [4, 5],
      [6, 7],
      [8, 9],
    ],
    inclusionGroups: [],
  };
}
