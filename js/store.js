// Data model + persistence orchestration.
// Practiae's data is one document: { schema_version, programs[], current_program_id }.
// That maps to ONE Drive file (practiae.json) — unlike DeLaClaw's per-table
// files, because a Practiae program (pieces + groups + pinned routine) is
// edited as a unit and is small. Adapters only know load/save of that
// document; all program/piece logic lives here, adapter-agnostic.
//
// Piece shape (ported from routine_render DbPiece + utils.Piece):
//   { id, rank, title, composer, perc, tags[], custom_days|null,
//     notes, duration_min }
// Program shape (ported from routine_render Program):
//   { id, name, num_days, day_names[], order_index, is_current,
//     pieces[], exclusion_groups[[pieceId]], inclusion_groups[[pieceId]],
//     pinned_routine|null, is_routine_pinned }
// Groups store piece *ids* here (Flask stored ranks — fragile on
// reorder/delete). They are converted to ranks only at generation time,
// and converted back from ranks on Flask import.

import { SCHEMA_VERSION } from './config.js';
import { uid } from './utils.js';

export function blankPiece(over = {}) {
  return { id: uid(), rank: 0, title: '', composer: '', perc: 0, tags: [],
    custom_days: null, notes: '', duration_min: 0, ...over };
}
export function blankProgram(over = {}) {
  return { id: uid(), name: 'New program', num_days: 8,
    day_names: Array.from({ length: 8 }, (_, i) => `Jour ${i + 1}`),
    order_index: 0, is_current: false, pieces: [],
    exclusion_groups: [], inclusion_groups: [],
    pinned_routine: null, is_routine_pinned: false, ...over };
}

export function normaliseProgram(raw, orderIndex = 0) {
  const p = blankProgram({ ...raw, order_index: orderIndex });
  p.num_days = Math.max(1, Math.min(31, +p.num_days || 8));
  if (!Array.isArray(p.day_names) || p.day_names.length !== p.num_days) {
    p.day_names = Array.from({ length: p.num_days }, (_, i) =>
      (Array.isArray(raw?.day_names) && raw.day_names[i]) || `Jour ${i + 1}`);
  }
  p.pieces = (Array.isArray(raw?.pieces) ? raw.pieces : []).map((piece, i) => {
    const dp = piece.day_pattern ?? piece.custom_days ?? null;
    return blankPiece({ ...piece, rank: i,
      custom_days: Array.isArray(dp) ? [...dp].sort((a, b) => a - b) : null,
      tags: Array.isArray(piece.tags) ? [...piece.tags] : [],
      perc: Math.max(0, Math.min(100, +piece.perc || 0)),
      duration_min: +piece.duration_min || 0 });
  });
  // Flask rank-groups -> id-groups, when the group entries are numbers.
  const rankToId = new Map(p.pieces.map((pc) => [pc.rank, pc.id]));
  for (const key of ['exclusion_groups', 'inclusion_groups']) {
    p[key] = (Array.isArray(raw?.[key]) ? raw[key] : [])
      .map((g) => (Array.isArray(g) ? g : [])
        .map((v) => (typeof v === 'number' ? rankToId.get(v) : v))
        .filter((id) => p.pieces.some((pc) => pc.id === id)))
      .filter((g) => g.length >= 2);
  }
  return p;
}

export function normaliseDoc(raw) {
  if (!raw || typeof raw !== 'object') return { schema_version: SCHEMA_VERSION, programs: [], current_program_id: null };
  // Flask single-program JSON: { name, pieces[] } -> one program.
  if (Array.isArray(raw.pieces) && !Array.isArray(raw.programs)) {
    const p = normaliseProgram(raw, 0);
    return { schema_version: SCHEMA_VERSION, programs: [p], current_program_id: p.id };
  }
  const programs = (Array.isArray(raw.programs) ? raw.programs : []).map((p, i) => normaliseProgram(p, i));
  let current = raw.current_program_id;
  if (!programs.some((p) => p.id === current)) current = programs[0]?.id ?? null;
  programs.forEach((p) => { p.is_current = p.id === current; });
  return { schema_version: SCHEMA_VERSION, programs, current_program_id: current };
}

export function seedFromDefault(defaultRoutine) {
  const p = normaliseProgram({ ...defaultRoutine, num_days: defaultRoutine.num_days || 8 }, 0);
  // The bundled default has no num_days; Flask defaults to 8.
  p.num_days = 8;
  p.day_names = Array.from({ length: 8 }, (_, i) => `Jour ${i + 1}`);
  return { schema_version: SCHEMA_VERSION, programs: [p], current_program_id: p.id };
}

export function currentProgram(doc) {
  return doc.programs.find((p) => p.id === doc.current_program_id) || doc.programs[0] || null;
}
export function renumber(program) {
  program.pieces.sort((a, b) => a.rank - b.rank);
  program.pieces.forEach((p, i) => { p.rank = i; });
}
export function groupsAsRanks(program) {
  const idToRank = new Map(program.pieces.map((p) => [p.id, p.rank]));
  const conv = (groups) => groups
    .map((g) => g.map((id) => idToRank.get(id)).filter((r) => r !== undefined))
    .filter((g) => g.length >= 2);
  return { exclusion: conv(program.exclusion_groups), inclusion: conv(program.inclusion_groups) };
}
/** Pieces in generation shape: day_pattern derived from custom_days. */
export function generationPieces(program) {
  return program.pieces.map((p) => ({ ...p, day_pattern: p.custom_days }));
}
export function piecesPerDay(program) {
  return program.pieces.reduce((sum, p) => sum + (p.perc || 0), 0) / 100;
}
