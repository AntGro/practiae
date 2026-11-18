// Routine generation — direct port of routine_render/utils.py
// (Routine.generate_routine, spaced_ones_indices, _enforce_exclusions,
// _enforce_inclusions, _compute_tag_distribution, tag_color, Piece.__str__).
// Behaviour is intentionally identical, including the quirks:
//  - pieces are placed least-loaded-day first, lowest perc first
//  - fixed day_pattern pieces are placed first and never moved
//  - k = round(perc * num_days / 100) occurrences per piece
//  - a piece never appears twice on the same day
// The only deliberate change: randomness uses Math.random instead of numpy.

export const TAG_COLORS = {
  'Chap. I.': '#000301',
  'Chap. II.': '#7A4212',
  'Chap. III.': '#5A178A',
  'Chap. IV.': '#FF40FE',
  'Chap. V.': '#FB3300',
  'Chap. VI.': '#F28712',
};

export function tagColor(tag) {
  for (const [name, color] of Object.entries(TAG_COLORS)) {
    if (tag.includes(name)) return color;
  }
  return '#17a2b8';
}

/** Display string for a piece, as in Piece.__str__. */
export function pieceLabel(piece) {
  let s = '';
  for (const tag of piece.tags || []) {
    if (tag.startsWith('Chap.') && tag.includes('Mod.')) {
      const parts = tag.split('. ');
      // "Chap. III. Mod. 1" -> ["Chap", "III", "Mod", "1"]
      if (parts.length === 4) { s += `[${parts[1]}. ${parseInt(parts[3], 10)}] `; break; }
    }
    if (tag === 'Répertoire') { s += '[Rép] '; }
  }
  s += piece.title || '';
  if (piece.composer) s += `, ${piece.composer}`;
  return s;
}

function spacedOnesIndices(k, n, startPool) {
  if (k <= 0 || n <= 0) return [];
  const pool = startPool && startPool.length ? startPool : Array.from({ length: n }, (_, i) => i);
  const start = pool[Math.floor(Math.random() * pool.length)];
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(((Math.round((i / k) * n + start)) % n + n) % n);
  }
  return out;
}

function daysOf(piece, routineList) {
  const days = new Set();
  routineList.forEach((day, i) => { if (day.includes(piece)) days.add(i); });
  return days;
}

function enforceExclusions(routineList, pieces, exclusionGroups, perDay) {
  const numDays = routineList.length;
  const byRank = new Map(pieces.map((p) => [p.rank, p]));
  const maxPasses = numDays * exclusionGroups.length * 5;
  for (let pass = 0; pass < maxPasses; pass++) {
    let anyMoved = false;
    for (const groupRanks of exclusionGroups) {
      const groupPieces = groupRanks.map((r) => byRank.get(r)).filter(Boolean);
      if (groupPieces.length < 2) continue;
      const groupRankSet = new Set(groupPieces.map((p) => p.rank));
      for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
        const dayList = routineList[dayIdx];
        const conflicting = dayList.filter((p) => groupRankSet.has(p.rank));
        if (conflicting.length <= 1) continue;
        for (const pieceToMove of conflicting.slice(1)) {
          if (pieceToMove.day_pattern != null) continue;
          let moved = false;
          const candidateDays = Array.from({ length: numDays }, (_, d) => d)
            .sort((a, b) => perDay[a] - perDay[b]);
          for (const targetDay of candidateDays) {
            if (targetDay === dayIdx) continue;
            const target = routineList[targetDay];
            const targetRanks = new Set(target.map((p) => p.rank));
            if (targetRanks.has(pieceToMove.rank)) continue;
            if ([...groupRankSet].some((r) => targetRanks.has(r))) continue;
            dayList.splice(dayList.indexOf(pieceToMove), 1);
            target.push(pieceToMove);
            perDay[dayIdx]--; perDay[targetDay]++;
            moved = true; anyMoved = true; break;
          }
          if (!moved) {
            for (const targetDay of candidateDays) {
              if (targetDay === dayIdx) continue;
              const target = routineList[targetDay];
              const targetRanks = new Set(target.map((p) => p.rank));
              if ([...groupRankSet].some((r) => targetRanks.has(r))) continue;
              for (const swap of [...target]) {
                if (swap.day_pattern != null) continue;
                if (groupRankSet.has(swap.rank)) continue;
                dayList.splice(dayList.indexOf(pieceToMove), 1);
                target.splice(target.indexOf(swap), 1);
                dayList.push(swap); target.push(pieceToMove);
                moved = true; anyMoved = true; break;
              }
              if (moved) break;
            }
          }
        }
      }
    }
    if (!anyMoved) break;
  }
}

function enforceInclusions(routineList, pieces, inclusionGroups, perDay) {
  const numDays = routineList.length;
  const byRank = new Map(pieces.map((p) => [p.rank, p]));
  for (const groupRanks of inclusionGroups) {
    const groupPieces = groupRanks.map((r) => byRank.get(r)).filter(Boolean);
    if (groupPieces.length < 2) continue;
    const pieceDays = new Map();
    for (const p of groupPieces) pieceDays.set(p.rank, daysOf(p, routineList));
    const movable = groupPieces.filter((p) => p.day_pattern == null);
    const candidates = movable.length ? movable : groupPieces;
    const anchor = candidates.reduce((a, b) =>
      (pieceDays.get(b.rank).size > pieceDays.get(a.rank).size ? b : a));
    const anchorDays = pieceDays.get(anchor.rank);
    for (const p of groupPieces) {
      if (p.rank === anchor.rank || p.day_pattern != null) continue;
      const pDays = pieceDays.get(p.rank);
      for (const dayIdx of [...anchorDays]) {
        if (pDays.has(dayIdx)) continue;
        const nonAnchor = [...pDays].filter((d) => !anchorDays.has(d));
        const donor = nonAnchor.sort((a, b) => perDay[b] - perDay[a])[0];
        if (donor !== undefined) {
          routineList[donor].splice(routineList[donor].indexOf(p), 1);
          perDay[donor]--; pDays.delete(donor);
        }
        routineList[dayIdx].push(p); perDay[dayIdx]++; pDays.add(dayIdx);
      }
      for (const dayIdx of [...pDays].filter((d) => !anchorDays.has(d))) {
        routineList[dayIdx].splice(routineList[dayIdx].indexOf(p), 1);
        perDay[dayIdx]--; pDays.delete(dayIdx);
      }
    }
  }
}

export function computeTagDistribution(routineList) {
  const allTags = new Set();
  for (const day of routineList) for (const p of day) for (const t of p.tags || []) allTags.add(t);
  const tags = [...allTags].sort();
  const numDays = routineList.length;
  const byCount = Object.fromEntries(tags.map((t) => [t, Array(numDays).fill(0)]));
  const byDuration = Object.fromEntries(tags.map((t) => [t, Array(numDays).fill(0)]));
  routineList.forEach((day, i) => {
    for (const p of day) for (const t of p.tags || []) {
      byCount[t][i] += 1;
      byDuration[t][i] += p.duration_min || 0;
    }
  });
  return { tags, by_count: byCount, by_duration: byDuration,
    tag_colors: Object.fromEntries(tags.map((t) => [t, tagColor(t)])) };
}

/**
 * Generate a routine for one program.
 * @param {object} program — { num_days, pieces: [{rank,title,composer,perc,tags,day_pattern,notes,duration_min}] }
 * @param {number[][]} exclusionGroups — lists of piece ranks that must not co-occur
 * @param {number[][]} inclusionGroups — lists of piece ranks that must co-occur
 * @returns {{ days: object[][], tagDistribution: object }}
 *   days[d] is the list of pieces on day d, sorted by rank.
 */
export function generateRoutine(program, exclusionGroups = [], inclusionGroups = []) {
  const numDays = program.num_days;
  const pieces = [...program.pieces].sort((a, b) => a.rank - b.rank);
  const routineList = Array.from({ length: numDays }, () => []);
  const perDay = Array(numDays).fill(0);
  const selected = pieces.filter((p) => (p.perc || 0) > 0);

  // Fixed day patterns first — never moved afterwards.
  for (const piece of selected) {
    const dp = piece.day_pattern;
    if (dp == null) continue;
    const days = Array.isArray(dp) ? dp : [];
    for (const d of days) {
      if (d >= 0 && d < numDays) { routineList[d].push(piece); perDay[d]++; }
    }
  }

  const auxFilter = Array.from({ length: numDays }, (_, i) => i);
  for (const piece of [...selected].sort((a, b) => a.perc - b.perc)) {
    if (piece.day_pattern != null) continue;
    const k = Math.round((piece.perc * numDays) / 100);
    const minLoad = Math.min(...perDay);
    const startPool = auxFilter.filter((d) => perDay[d] === minLoad);
    const indices = spacedOnesIndices(k, numDays, startPool);
    const pieceInds = new Set();
    for (let ind of indices) {
      let trial = 0;
      let indFiltr = new Set(auxFilter.filter((d) => perDay[d] === Math.min(...perDay)).filter((d) => !pieceInds.has(d)));
      while (!indFiltr.has(ind)) {
        ind = (ind + 1) % numDays;
        trial++;
        if (trial > numDays) throw new Error('generate: could not place piece');
        indFiltr = new Set(auxFilter.filter((d) => perDay[d] === Math.min(...perDay)).filter((d) => !pieceInds.has(d)));
      }
      routineList[ind].push(piece);
      perDay[ind]++;
      pieceInds.add(ind);
    }
  }

  if (exclusionGroups?.length) enforceExclusions(routineList, pieces, exclusionGroups, perDay);
  if (inclusionGroups?.length) enforceInclusions(routineList, pieces, inclusionGroups, perDay);

  const days = routineList.map((day) => [...day].sort((a, b) => a.rank - b.rank));
  return { days, tagDistribution: computeTagDistribution(days) };
}

/** Normalise a day-pattern input: "0,2,6" / "1-3" / "" -> list | null. Port of parse_day_pattern_any. */
export function parseDayPattern(value, numDays) {
  if (value == null || String(value).trim() === '') return null;
  const days = new Set();
  for (const part of String(value).split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      for (let d = +m[1]; d <= +m[2]; d++) days.add(d);
    } else if (/^\d+$/.test(part)) {
      days.add(+part);
    }
  }
  const list = [...days].filter((d) => d >= 0 && d < numDays).sort((a, b) => a - b);
  return list.length ? list : null;
}
