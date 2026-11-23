// Practiae (front-only) — UI. Vanilla JS, ES modules, no build.
// All user strings rendered through esc(). Inline edits save only on
// Enter / explicit Save; blur / Esc cancels (same rule as DeLaClaw).
// Mutations go through mutate() -> persist (adapter.save) -> render().
// One document-level click handler (data-action) — no per-element onclick.

import { esc, uid, guard, download, clamp, formatDuration, freqDays, snapPerc, freqLabel, durationFromMinSec } from './utils.js';
import { resolveClientId, saveClientId, driveFolderName } from './config.js';
import { blankPiece, blankProgram, normaliseDoc, seedFromDefault, currentProgram,
  renumber, groupsAsRanks, generationPieces, piecesPerDay, convertMode } from './store.js';
import { buildSession, todayStr, dueLabel, lastPlayedById, playedIdsOn, formatDayLabel } from './session.js';
import { pieceLabel, tagColor, parseDayPattern } from './generate.js';
import { generateOptimizedRoutine } from './optimize.js';
import { createLocalAdapter, DEMO_KEY } from './adapters/local.js';
import { createDriveAdapter, getDriveToken, clearDriveToken } from './adapters/drive.js';
import { tagChartHTML, tagChartLegendHTML } from './chart.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Demo mode: no sign-in, no Drive, data only in localStorage under its own
// key (so demo edits never touch the real local data or Drive).
// Entered via demo.html (window.PRACTIAE_DEMO) or index.html?demo=1.
export const DEMO = window.PRACTIAE_DEMO === true
  || new URLSearchParams(location.search).get('demo') === '1';

let doc = null;
// The welcome page links here with ?drive=1 ("Connect Google Drive"):
// start straight in Drive mode (sign-in) instead of local.
const wantDrive = new URLSearchParams(location.search).get('drive') === '1';
let mode = DEMO ? 'local' : (wantDrive ? 'drive' : (localStorage.getItem('practiae:mode') || 'local'));
let adapter = DEMO ? createLocalAdapter(DEMO_KEY) : createLocalAdapter();
let clientId = resolveClientId();
let saveState = { state: 'saved', detail: '' };
let generated = null; // { days, tagDistribution } in memory for current program
let filterTags = [];
let hideZero = false;
let searchQuery = '';
let routineDay = 0; // mobile day-by-day routine view: which day is shown
let mobileView = 'pieces'; // phone view toggle: 'pieces' (edit) or 'routine' (day view)
let routineDone = new Set(); // mobile day view: items tapped done during a practice session (in-memory only; a new routine starts fresh)
const doneKey = (progId, day, label) => `${progId}::${day}::${label}`;
function clearDone(progId) { for (const k of [...routineDone]) if (k.startsWith(`${progId}::`)) routineDone.delete(k); }
function clearDoneDay(progId, day) { const prefix = `${progId}::${day}::`; for (const k of [...routineDone]) if (k.startsWith(prefix)) routineDone.delete(k); }
let chartMode = 'count'; // tag chart: 'count' (pieces) or 'duration' (minutes)
let pinnedPiece = null; // routine cell highlight pinned by click (touch)
let groupDraft = { kind: null, selected: new Set() };

function setStatus(state, detail = '') {
  saveState = { state, detail };
  const el = $('#save-status');
  if (el) { el.textContent = state === 'saving' ? 'Saving…' : state === 'error' ? `Save failed: ${detail}` : detail || 'Saved'; el.dataset.state = state; }
  const badge = $('#mode-badge');
  if (badge) badge.textContent = DEMO ? 'Demo · local only, no sign-in' : mode === 'drive' ? `Google Drive · ${driveFolderName()}/` : 'Local · this browser';
}

function persist() {
  if (!doc) return;
  setStatus('saving');
  Promise.resolve(adapter.save(doc)).then(() => {
    if (adapter.kind === 'local') setStatus('saved', 'Saved locally');
  }).catch((e) => setStatus('error', String(e.message || e)));
}
function mutate(fn) { fn(); renumber(currentProgram(doc)); persist(); render(); }
// State update without a render. Used by change handlers on plain inputs
// (#num-days, #day-names): a `change` event fires on blur, and a full
// render there would replace the element under the cursor between
// mousedown and mouseup — the click that follows never fires (the user
// has to click twice). The input already shows what was typed, so the
// handler syncs the affected input values directly instead; the next
// mutate() renders everything.
function mutateNoRender(fn) { fn(); renumber(currentProgram(doc)); persist(); }

function prog() { return currentProgram(doc); }

// ---------- rendering ----------
function renderPrograms() {
  $('#program-list').innerHTML = doc.programs.map((p) => `
    <li><button class="program-item ${p.id === prog()?.id ? 'active' : ''}" data-action="switch-program" data-id="${esc(p.id)}">
      <span class="program-name">${esc(p.name)}</span>
      <span class="program-meta">${p.pieces.length} pieces · ${p.num_days} days</span>
    </button></li>`).join('');
}

// Gap cell (gap mode): number input for the gap in days + "every N days"
// + the due status from the play log. The frequency slider is the
// frequency-mode equivalent (see pieceRow / pieceCard).
function gapCell(x, lastById) {
  const every = x.gap === 0 ? 'every day' : `every ${x.gap + 1} days`;
  const due = dueLabel(x, lastById.get(x.id), todayStr());
  return `<span class="gap-wrap"><input type="number" min="0" max="30" step="1" value="${x.gap}" data-piece-gap="${esc(x.id)}" aria-label="Gap in days">
    <span class="gap-val">${every} · ${esc(due)}</span></span>`;
}

function pieceRow(x, prog, lastById) {
  const daysLabel = x.custom_days?.length ? `Days ${x.custom_days.map((d) => d + 1).join(', ')}` : 'Any day';
  const tags = (x.tags || []).map((t) => `<span class="tag" style="--tag-color:${esc(tagColor(t))}">${esc(t)}</span>`).join(' ');
  const freqCell = prog.mode === 'gap' ? gapCell(x, lastById)
    : `<span class="perc-wrap"><input type="range" min="0" max="100" step="1" value="${x.perc}" data-piece-slider="${esc(x.id)}" aria-label="Frequency in days">
        <span class="perc-val">${freqLabel(x.perc, prog.num_days)}</span></span>`;
  // Fixed days are ignored in gap mode (a gap schedule has no fixed
  // program days), so the Days button is hidden there.
  const daysCell = prog.mode === 'gap' ? '<td></td>'
    : `<td><button class="btn small" data-action="edit-days" data-id="${esc(x.id)}">${esc(daysLabel)}</button></td>`;
  return `<tr data-piece-id="${esc(x.id)}">
    <td class="rank">${x.rank + 1}</td>
    <td class="editable" data-action="edit-text" data-field="title" data-id="${esc(x.id)}" title="Double-click to edit">${esc(x.title) || '<span class="muted">Untitled</span>'}</td>
    <td class="editable" data-action="edit-text" data-field="composer" data-id="${esc(x.id)}" title="Double-click to edit">${esc(x.composer)}</td>
    <td>${freqCell}</td>
    <td class="editable" data-action="edit-tags" data-id="${esc(x.id)}" title="Double-click to edit tags">${tags || '<span class="muted">—</span>'}</td>
    <td class="editable" data-action="edit-text" data-field="duration_min" data-id="${esc(x.id)}" title="Double-click to edit">${formatDuration(x.duration_min)}</td>
    ${daysCell}
    <td><button class="btn small" data-action="edit-notes" data-id="${esc(x.id)}">${x.notes ? 'Notes…' : 'Add note'}</button></td>
    <td><button class="btn small danger" data-action="delete-piece" data-id="${esc(x.id)}" aria-label="Delete piece">Delete</button></td>
  </tr>`;
}

// Mobile card for one piece — same data-actions as the desktop table row,
// so one delegated handler serves both. On a phone the table is hidden
// and these cards are shown instead: big title, full-width slider,
// tap-to-edit (no double-click on touch), actions in one thumb row.
function pieceCard(x, prog, lastById) {
  const daysLabel = x.custom_days?.length ? `Days ${x.custom_days.map((d) => d + 1).join(', ')}` : 'Any day';
  const tags = (x.tags || []).map((t) => `<span class="tag" style="--tag-color:${esc(tagColor(t))}">${esc(t)}</span>`).join(' ');
  const freqBlock = prog.mode === 'gap'
    ? `<div class="card-freq">${gapCell(x, lastById)}</div>`
    : `<label class="card-freq"><span class="perc-wrap"><input type="range" min="0" max="100" step="1" value="${x.perc}" data-piece-slider="${esc(x.id)}" aria-label="Frequency in days">
      <span class="perc-val">${freqDays(x.perc, prog.num_days)} / ${prog.num_days}</span></span><span class="card-freq-hint">days</span></label>`;
  const daysBtn = prog.mode === 'gap' ? ''
    : `<button class="btn" data-action="edit-days" data-id="${esc(x.id)}">${esc(daysLabel)}</button>`;
  return `<article class="piece-card" data-piece-id="${esc(x.id)}">
    <div class="card-head">
      <div class="card-titles">
        <div class="card-title editable" data-action="edit-text" data-field="title" data-id="${esc(x.id)}">${esc(x.title) || '<span class="muted">Untitled</span>'}</div>
        <div class="card-composer editable" data-action="edit-text" data-field="composer" data-id="${esc(x.id)}">${esc(x.composer) || '<span class="muted">No composer</span>'}</div>
      </div>
      <span class="card-rank">#${x.rank + 1}</span>
    </div>
    ${freqBlock}
    ${`<div class="card-tags editable" data-action="edit-tags" data-id="${esc(x.id)}">${tags || '<span class="muted">Add tags</span>'}</div>`}
    <div class="card-meta"><button class="btn small" data-action="edit-text" data-field="duration_min" data-id="${esc(x.id)}">${formatDuration(x.duration_min) || 'Add duration'}</button></div>
    <div class="card-actions">
      ${daysBtn}
      <button class="btn" data-action="edit-notes" data-id="${esc(x.id)}">${x.notes ? 'Notes…' : 'Add note'}</button>
      <button class="btn danger" data-action="delete-piece" data-id="${esc(x.id)}" aria-label="Delete piece">Delete</button>
    </div>
  </article>`;
}

function renderPieces() {
  const p = prog();
  if (!p) { $('#pieces-body').innerHTML = ''; $('#pieces-cards').innerHTML = ''; return; }
  const lastById = lastPlayedById(p.play_log);
  let pieces = [...p.pieces].sort((a, b) => a.rank - b.rank);
  if (hideZero && p.mode === 'frequency') pieces = pieces.filter((x) => (x.perc || 0) > 0);
  if (filterTags.length) pieces = pieces.filter((x) => filterTags.every((t) => (x.tags || []).includes(t)));
  if (searchQuery) pieces = pieces.filter((x) =>
    `${x.title} ${x.composer} ${(x.tags || []).join(' ')}`.toLowerCase().includes(searchQuery));
  $('#pieces-body').innerHTML = pieces.map((x) => pieceRow(x, p, lastById)).join('') ||
    `<tr><td colspan="9" class="empty">No pieces match. Add one below, or clear the filter.</td></tr>`;
  $('#pieces-cards').innerHTML = pieces.map((x) => pieceCard(x, p, lastById)).join('') ||
    `<p class="empty">No pieces match. Add one below, or clear the filter.</p>`;
  const perDay = p.mode === 'gap' ? `${p.pieces.length} pieces · ${p.session_minutes} min / session`
    : `≈ ${piecesPerDay(p).toFixed(2)} pieces / day`;
  $('#pieces-per-day').textContent = perDay;
  const mobileSummary = p.mode === 'gap' ? `${p.pieces.length} pieces · ${p.session_minutes} min / session`
    : `${p.pieces.length} pieces · ≈ ${piecesPerDay(p).toFixed(0)}/day`;
  $('#mobile-pieces-per-day').textContent = pieces.length === p.pieces.length ? mobileSummary
    : `${pieces.length} of ${p.pieces.length} pieces`;
  $('#pieces-count').textContent = pieces.length === p.pieces.length ? '' : `${pieces.length} of ${p.pieces.length} pieces shown`;
  $('#program-title').textContent = p.name;
  $('#num-days').value = p.num_days;
  $('#balance-by').value = p.balance_by || 'pieces';
  $('#day-names').value = (p.day_names || []).join(', ');
  syncModeUI(p);
  const allTags = [...new Set(p.pieces.flatMap((x) => x.tags || []))].sort();  $('#filter-tags').innerHTML = allTags.map((t) =>
    `<label class="filter-tag"><input type="checkbox" data-filter-tag="${esc(t)}" ${filterTags.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
}

// Mode-dependent controls: frequency mode shows the cycle settings
// (days, day names, Hide 0%, Balance by); gap mode shows the session cap
// instead. The Generate buttons say what they generate in each mode.
function syncModeUI(p) {
  const isGap = p.mode === 'gap';
  $('#num-days-wrap').hidden = isGap;
  $('#day-names-wrap').hidden = isGap;
  $('#hide-zero-wrap').hidden = isGap;
  $('#balance-by-wrap').hidden = isGap;
  $('#session-minutes-wrap').hidden = !isGap;
  $('#schedule-mode').value = p.mode;
  $('#session-minutes').value = p.session_minutes;
  $('#freq-header').textContent = isGap ? 'Gap' : 'Frequency';
  $('#pieces-hint').textContent = isGap
    ? 'Set the gap for each piece: 0 = every day, 1 = every other day. Generate builds today\'s session from the gaps and the play history, within the session cap.'
    : 'Double-click a cell — or tap it on a phone — to edit it (Enter saves, Esc cancels). Drag the frequency slider to set how often a piece appears: 100% = every day, 50% = every other day.';
  $$('[data-action="generate"]').forEach((b) => {
    b.textContent = isGap ? "Generate today's session" : 'Generate routine';
  });
}

// Update the visible frequency sliders in place (step, value, label) after
// the day count changed — that path does not re-render (see the num-days
// handler), so the sliders would otherwise keep the old grid.
function syncFreqSliders() {
  const p = prog(); if (!p) return;
  $$('[data-piece-slider]').forEach((s) => {
    const piece = p.pieces.find((x) => x.id === s.dataset.pieceSlider);
    if (!piece) return;
    s.step = '1'; // native step is 1% — the grid snaps in JS (see utils.js)
    s.value = String(piece.perc);
    const val = s.closest('.perc-wrap')?.querySelector('.perc-val');
    if (val) val.textContent = s.closest('.piece-card')
      ? `${freqDays(piece.perc, p.num_days)} / ${p.num_days}`
      : freqLabel(piece.perc, p.num_days);
  });
}

// Phone view toggle (Pieces edit vs Routine day view). CSS does the
// showing/hiding inside the ≤800px media query; on desktop the toggle is
// hidden and both views are always shown, so the class is inert there.
function setMobileView(view) {
  mobileView = view;
  document.body.classList.toggle('mobile-view-routine', view === 'routine');
  $$('.view-toggle-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
}

function renderRoutine() {
  const p = prog();
  const box = $('#routine-box');
  const mob = $('#routine-mobile');
  if (!p?.pinned_routine) {
    box.innerHTML = p?.mode === 'gap'
      ? `<p class="muted">No session generated yet for this program. Set the gaps, then Generate today's session.</p>`
      : `<p class="muted">No routine generated yet for this program. Set frequencies, then Generate.</p>`;
    mob.innerHTML = p?.mode === 'gap'
      ? `<p class="muted">No session generated yet. Set the gaps, then tap Generate below.</p>`
      : `<p class="muted">No routine generated yet. Set frequencies, then tap Generate below.</p>`;
    $('#tag-chart').innerHTML = '';
    return;
  }
  const r = p.pinned_routine;
  const isGap = p.mode === 'gap';
  const today = todayStr();
  // Gap mode: an item is done iff the play log has it for today (the log
  // is the record — unlike frequency mode, where done marks are in-memory
  // only). The session's ids rows give the piece id per cell.
  const playedToday = isGap ? playedIdsOn(p.play_log, today) : null;
  // Mobile day-by-day view: one day at a time beats an 8-column table
  // squeezed onto a phone. The desktop table is hidden on mobile.
  const day = Math.max(0, Math.min(routineDay, r.columns.length - 1));
  routineDay = day;
  const isDone = (item) => isGap
    ? (item.id ? playedToday.has(item.id) : false)
    : routineDone.has(doneKey(p.id, day, item.label));
  const items = r.data.map((row, rIdx) => ({ label: row[day], id: r.ids?.[rIdx]?.[day] || null })).filter((x) => x.label);
  const doneCount = items.reduce((n, item) => n + (isDone(item) ? 1 : 0), 0);
  // Gap mode: a session generated on another day is stale — the user
  // practices today, so the session should be today's.
  const staleNote = isGap && r.date && r.date !== today
    ? `<p class="muted">This session was generated for ${esc(formatDayLabel(r.date))}. Generate a new session for today.</p>` : '';
  const warningsHtml = isGap && r.warnings?.length
    ? r.warnings.map((w) => `<p class="muted">${esc(w)}</p>`).join('') : '';
  const minutes = isGap && r.totalMinutes != null ? ` · ${r.totalMinutes} min` : '';
  mob.innerHTML = `${staleNote}<div class="day-nav">
      <button class="btn" data-action="routine-day" data-day="${day - 1}" ${day === 0 ? 'disabled' : ''} aria-label="Previous day">←</button>
      <div class="day-chips">${r.columns.map((c, i) => `<button class="day-chip ${i === day ? 'active' : ''}" data-action="routine-day" data-day="${i}">${esc(c)}</button>`).join('')}</div>
      <button class="btn" data-action="routine-day" data-day="${day + 1}" ${day === r.columns.length - 1 ? 'disabled' : ''} aria-label="Next day">→</button>
    </div>
    <p class="muted">${items.length} piece${items.length === 1 ? '' : 's'} · ${esc(r.columns[day])}${minutes}</p>
    ${warningsHtml}
    <ol class="day-list">${items.map((item) => {
      const done = isDone(item);
      return `<li class="${done ? 'done' : ''}" data-action="routine-day-item" data-day="${day}" data-piece="${esc(item.label)}" data-piece-id="${esc(item.id || '')}"><span class="day-tick" aria-hidden="true">${done ? '✓' : ''}</span><span class="day-label">${esc(item.label)}</span></li>`;
    }).join('')}</ol>
    ${doneCount > 0 ? `<button class="btn small" data-action="routine-clear-done" data-day="${day}">Untick all</button>` : ''}
    <p class="muted small">Tap an item to mark it done; tap again to undo.</p>`;
  const maxRows = r.data.length;
  // data-piece on each non-empty cell powers the hover/click highlighting
  // below (same attribute the Flask app used).
  const footer = isGap
    ? `<p class="muted">${maxRows} piece${maxRows === 1 ? '' : 's'} · ${r.totalMinutes ?? 0} min · ${esc(r.columns[0] || '')}</p>${warningsHtml}`
    : `<p class="muted">${maxRows} rows · pinned ${p.is_routine_pinned ? 'yes' : 'no'} · hover a piece to see it across all days (click to pin)</p>`;
  box.innerHTML = `${staleNote}<table class="routine-table"><thead><tr><th></th>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${r.data.map((row, i) => `<tr><th>${esc(r.indices[i] || '')}</th>${row.map((cell) => cell ? `<td data-piece="${esc(cell)}" data-action="routine-cell">${esc(cell)}</td>` : '<td></td>').join('')}</tr>`).join('')}</tbody></table>
    ${footer}`;
  const td = r.tag_distribution;
  if (td?.tags?.length) {
    // Durations by label, for the Duration view of the chart.
    const durByLabel = new Map(p.pieces.map((pc) => [pieceLabel(pc), pc.duration_min || 0]));
    const dayTotals = r.columns.map((_, d) => {
      const labels = r.data.map((row) => row[d]).filter(Boolean);
      return { pieces: labels.length, minutes: labels.reduce((s, l) => s + (durByLabel.get(l) || 0), 0) };
    });
    $('#tag-chart').innerHTML = `<h3>Tag distribution</h3>
      <label class="chart-mode"><span>Pieces</span><input type="checkbox" id="tag-dist-mode" ${chartMode === 'duration' ? 'checked' : ''} aria-label="Show durations instead of piece counts"><span>Duration</span></label>
      ${tagChartHTML({ tagDistribution: td, columns: r.columns, mode: chartMode, dayTotals })}
      ${tagChartLegendHTML(td)}`;
  } else { $('#tag-chart').innerHTML = ''; }
}

// ---------- routine cell highlighting (port of the Flask app) ----------
// Hovering a routine cell highlights every cell with the same piece
// (blue), cells of pieces it must never share a day with (warm/red) and
// cells of pieces it must share days with (green) — from the program's
// exclusion/inclusion groups. Clicking pins the highlight (touch has no
// hover); Esc or clicking the same cell again clears the pin.
function groupLabelMaps(p) {
  const byId = new Map(p.pieces.map((pc) => [pc.id, pieceLabel(pc)]));
  const build = (groups) => {
    const m = new Map();
    for (const g of groups || []) {
      const labels = g.map((id) => byId.get(id)).filter(Boolean);
      for (const l of labels) m.set(l, new Set(labels.filter((x) => x !== l)));
    }
    return m;
  };
  return { exclusion: build(p.exclusion_groups), inclusion: build(p.inclusion_groups) };
}
let hovered = { piece: [], exclusion: [], inclusion: [] };
function applyHighlight(piece) {
  [...hovered.piece, ...hovered.exclusion, ...hovered.inclusion].forEach((el) =>
    el.classList.remove('piece-highlight', 'exclusion-highlight', 'inclusion-highlight'));
  hovered = { piece: [], exclusion: [], inclusion: [] };
  if (!piece) return;
  const table = document.querySelector('.routine-table');
  if (!table) return;
  const cells = (label) => [...table.querySelectorAll(`td[data-piece="${CSS.escape(label)}"]`)];
  hovered.piece = cells(piece);
  hovered.piece.forEach((el) => el.classList.add('piece-highlight'));
  const maps = groupLabelMaps(prog());
  for (const [kind, map] of [['exclusion', maps.exclusion], ['inclusion', maps.inclusion]]) {
    const others = map.get(piece);
    if (!others) continue;
    hovered[kind] = [...others].flatMap(cells);
    hovered[kind].forEach((el) => el.classList.add(kind === 'exclusion' ? 'exclusion-highlight' : 'inclusion-highlight'));
  }
}
document.addEventListener('mouseover', (e) => {
  const td = e.target.closest('.routine-table td[data-piece]');
  if (td) applyHighlight(td.dataset.piece);
});
document.addEventListener('mouseout', (e) => {
  const td = e.target.closest('.routine-table td[data-piece]');
  if (!td) return;
  if (e.relatedTarget?.closest?.('.routine-table td[data-piece]')) return;
  applyHighlight(pinnedPiece);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pinnedPiece) { pinnedPiece = null; applyHighlight(null); }
});

function renderGroups() {
  const p = prog();
  if (!p) return;
  const renderList = (key, title) => {
    const groups = p[key];
    return `<section><h3>${title}</h3>
      ${groups.length ? `<ul>${groups.map((g, i) => `<li>${g.map((id) => { const pc = p.pieces.find((x) => x.id === id); return esc(pc ? pieceLabel(pc) : id); }).join(' + ')}
        <button class="btn small danger" data-action="delete-group" data-kind="${key}" data-index="${i}">Delete</button></li>`).join('')}</ul>`
      : `<p class="muted">None yet.</p>`}
      <button class="btn small" data-action="start-group" data-kind="${key}">Add ${title.toLowerCase()}</button></section>`;
  };
  $('#groups-box').innerHTML = renderList('exclusion_groups', 'Exclusion groups') + renderList('inclusion_groups', 'Inclusion groups');
  if (groupDraft.kind) {
    const box = $('#group-draft');
    box.hidden = false;
    box.innerHTML = `<h3>New ${groupDraft.kind === 'exclusion_groups' ? 'exclusion' : 'inclusion'} group — tick at least 2 pieces, then Save</h3>
      ${p.pieces.map((pc) => `<label class="draft-piece"><input type="checkbox" data-draft-piece="${esc(pc.id)}" ${groupDraft.selected.has(pc.id) ? 'checked' : ''}> ${esc(pieceLabel(pc))}</label>`).join('')}
      <div class="row"><button class="btn primary" data-action="save-group">Save group</button>
      <button class="btn" data-action="cancel-group">Cancel</button></div>`;
  } else { $('#group-draft').hidden = true; $('#group-draft').innerHTML = ''; }
}

function render() {
  if (!doc) return;
  renderPrograms(); renderPieces(); renderRoutine(); renderGroups();
  $$('#mode-local, #mode-drive').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

// ---------- inline editing (Enter saves, blur/Esc cancels) ----------
function startTextEdit(cell, field, id) {
  const p = prog(); const piece = p.pieces.find((x) => x.id === id);
  if (!piece || cell.querySelector('input')) return;
  const originalHTML = cell.innerHTML; // restore on cancel (no full render — see below)
  let done = false;
  // Cancel runs on blur — a full render here would replace the element
  // under the cursor between mousedown and mouseup and swallow the click
  // that caused the blur, so just put the cell back as it was.
  const cancel = () => { if (done) return; done = true; cell.innerHTML = originalHTML; };
  if (field === 'duration_min') {
    // Two boxes (minutes + seconds), like Flask — a single "m:ss" text
    // entry was easy to mistype and awkward on a phone.
    const total = piece.duration_min || 0;
    const oldMin = total ? Math.floor(total) : '';
    const oldSec = total ? Math.round((total - Math.floor(total)) * 60) : '';
    cell.innerHTML = `<span class="duration-edit"><input type="number" class="inline-edit edit-duration-min" min="0" step="1" placeholder="min" value="${oldMin}" aria-label="Minutes"><span aria-hidden="true">min</span><input type="number" class="inline-edit edit-duration-sec" min="0" step="1" placeholder="sec" value="${oldSec}" aria-label="Seconds"><span aria-hidden="true">sec</span></span>`;
    const minInput = cell.querySelector('.edit-duration-min');
    const secInput = cell.querySelector('.edit-duration-sec');
    const save = () => { if (done) return; done = true;
      mutate(() => { piece.duration_min = durationFromMinSec(parseInt(minInput.value, 10), parseInt(secInput.value, 10)); });
    };
    // Enter in either box saves; Esc cancels. Blur cancels only when
    // focus leaves both boxes — tabbing min -> sec must not cancel.
    [minInput, secInput].forEach((input) => {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); e.stopPropagation(); });
    });
    cell.addEventListener('focusout', (e) => { if (!cell.contains(e.relatedTarget)) cancel(); });
    minInput.focus(); minInput.select();
    return;
  }
  const old = String(piece[field] || '');
  cell.innerHTML = `<input class="inline-edit" value="${esc(old)}" aria-label="Edit ${field}">`;
  const input = cell.querySelector('input');
  input.focus(); input.select();
  const save = () => { if (done) return; done = true;
    const v = input.value.trim();
    mutate(() => { piece[field] = v; });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); e.stopPropagation(); });
  input.addEventListener('blur', cancel);
}
// Tags editor (Notion-style): a dialog listing the program's tags with a
// search box. Tap a tag to toggle it on this piece; type a new name and
// tap "Create" (or Enter) to add it. Changes apply live — no Save step —
// so the dialog rebuilds its own content after every toggle while the
// background list re-renders behind it.
function openTagsDialog(id) {
  const dlg = $('#tags-dialog');
  dlg.dataset.pieceId = id;
  const piece = prog().pieces.find((x) => x.id === id);
  $('#tags-dialog-title').textContent = `Tags for ${piece?.title || 'piece'}`;
  $('#tags-search').value = '';
  renderTagsDialog();
  dlg.showModal();
}

function renderTagsDialog() {
  const dlg = $('#tags-dialog');
  const p = prog(); const piece = p?.pieces.find((x) => x.id === dlg.dataset.pieceId);
  if (!piece) return;
  const q = ($('#tags-search').value || '').trim();
  const qLower = q.toLowerCase();
  // Current tags as chips; × removes the tag from this piece only.
  $('#tags-chips').innerHTML = (piece.tags || []).map((t) =>
    `<span class="tag" style="--tag-color:${esc(tagColor(t))}">${esc(t)} <button class="tag-remove" data-tag-remove="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join('')
    || '<span class="muted small">No tags yet.</span>';
  // All program tags, filtered by the search; ticked when on this piece.
  const allTags = [...new Set(p.pieces.flatMap((x) => x.tags || []))].sort();
  const shown = allTags.filter((t) => !qLower || t.toLowerCase().includes(qLower));
  const createRow = q && !allTags.some((t) => t.toLowerCase() === qLower)
    ? `<button class="tag-option tag-create" data-tag-create="${esc(q)}">Create “${esc(q)}”</button>` : '';
  $('#tags-options').innerHTML = shown.map((t) =>
    `<button class="tag-option${(piece.tags || []).includes(t) ? ' selected' : ''}" data-tag-toggle="${esc(t)}"><span class="tag-tick" aria-hidden="true">${(piece.tags || []).includes(t) ? '✓' : ''}</span><span class="tag" style="--tag-color:${esc(tagColor(t))}">${esc(t)}</span></button>`).join('')
    + createRow || '<span class="muted small">No matching tag.</span>';
}

function createTagInDialog(name) {
  const piece = prog()?.pieces.find((x) => x.id === $('#tags-dialog').dataset.pieceId);
  if (!piece || !name) return;
  // Case-insensitive dedup: creating "chap. iii." must not spawn a second
  // tag next to the existing "Chap. III.".
  mutate(() => { if (!(piece.tags || []).some((t) => t.toLowerCase() === name.toLowerCase())) piece.tags = [...(piece.tags || []), name]; });
  $('#tags-search').value = '';
  renderTagsDialog();
  $('#tags-search').focus();
}
function openDaysDialog(id) {
  const p = prog(); const piece = p.pieces.find((x) => x.id === id);
  const dlg = $('#days-dialog');
  $('#days-dialog-title').textContent = `Days for ${piece.title || 'piece'} (1–${p.num_days})`;
  $('#days-grid').innerHTML = Array.from({ length: p.num_days }, (_, d) =>
    `<label><input type="checkbox" value="${d}" ${(piece.custom_days || []).includes(d) ? 'checked' : ''}> ${esc(p.day_names[d] || `Day ${d + 1}`)}</label>`).join('');
  dlg.dataset.pieceId = id;
  dlg.showModal();
}
function openNotesDialog(id) {
  const p = prog(); const piece = p.pieces.find((x) => x.id === id);
  $('#notes-text').value = piece.notes || '';
  $('#notes-dialog').dataset.pieceId = id;
  $('#notes-dialog').showModal();
}

// ---------- actions ----------
async function doGenerate(btn) {
  const p = prog(); if (!p) return;
  await guard(btn, async () => {
    routineDay = 0; // a new routine/session opens on day 1 in the mobile day view
    clearDone(p.id); // a new routine starts a fresh practice session
    if (p.mode === 'gap') {
      // Gap mode: one session for today, from the gaps and the play log.
      const session = buildSession(p, todayStr());
      mutate(() => { p.pinned_routine = session; p.is_routine_pinned = true; });
    } else {
      const { exclusion, inclusion } = groupsAsRanks(p);
      const gen = generateOptimizedRoutine({ num_days: p.num_days, pieces: generationPieces(p) }, exclusion, inclusion, { balanceBy: p.balance_by || 'pieces' });
      generated = gen;
      const maxRows = Math.max(0, ...gen.days.map((d) => d.length));
      const data = Array.from({ length: maxRows }, (_, r) =>
        gen.days.map((day) => (day[r] ? pieceLabel(day[r]) : '')));
      mutate(() => {
        p.pinned_routine = { columns: p.day_names, indices: Array.from({ length: maxRows }, (_, i) => `${i + 1}.`), data, tag_distribution: gen.tagDistribution };
        p.is_routine_pinned = true;
      });
    }
    // Take the user to the routine they just generated.
    document.getElementById('generated-routine')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // On a phone, switch to the routine view they just generated.
    if (window.matchMedia('(max-width: 800px)').matches) setMobileView('routine');
  });
}

async function switchMode(next) {
  if (DEMO) return; // demo has no Drive at all
  if (next === mode) return;
  if (next === 'drive') {
    try {
      setStatus('saving', 'Signing in to Google Drive…');
      const drive = createDriveAdapter(clientId,
        (ev) => setStatus(ev.state, ev.detail || ''),
        (remoteDoc) => { doc = normaliseDoc(remoteDoc); render(); setStatus('saved', 'Updated from Drive'); });
      const remote = await drive.load();
      if (remote) { doc = normaliseDoc(remote); }
      else { await drive.flush(doc); setStatus('saved', 'Created practiae.json in Drive'); }
      if (adapter.destroy) adapter.destroy();
      adapter = drive; mode = 'drive';
      localStorage.setItem('practiae:mode', 'drive');
      setStatus('saved', remote ? 'Loaded from Google Drive' : 'Created practiae.json in Drive');
    } catch (e) { setStatus('error', String(e.message || e)); return; }
  } else {
    if (adapter.destroy) adapter.destroy();
    adapter = createLocalAdapter(); mode = 'local';
    localStorage.setItem('practiae:mode', 'local');
    await adapter.save(doc);
    setStatus('saved', 'Saved locally');
  }
  render();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  const p = prog();
  switch (action) {
    // Switching programs clears the tag filter: tag checkboxes are built
    // from the current program's tags only, so a filter from another
    // program would keep filtering with no checkbox to clear it — the
    // list showed 0 pieces and even Add piece stayed invisible.
    case 'switch-program': filterTags = []; mutate(() => { doc.current_program_id = id; doc.programs.forEach((x) => { x.is_current = x.id === id; }); }); break;
    case 'add-program': { const np = blankProgram({ name: `Program ${doc.programs.length + 1}`, order_index: doc.programs.length });
      filterTags = []; mutate(() => { doc.programs.push(np); doc.current_program_id = np.id; }); break; }
    case 'rename-program': { const name = prompt('Program name', p.name); if (name?.trim()) mutate(() => { p.name = name.trim(); }); break; }
    case 'duplicate-program': { const copy = JSON.parse(JSON.stringify(p));
      copy.id = uid(); copy.name = `${p.name} (copy)`; copy.pieces.forEach((pc) => { pc.id = uid(); });
      // group ids must follow the new piece ids
      const oldToNew = new Map(p.pieces.map((pc, i) => [pc.id, copy.pieces[i].id]));
      for (const k of ['exclusion_groups', 'inclusion_groups']) copy[k] = p[k].map((g) => g.map((x) => oldToNew.get(x)).filter(Boolean));
      filterTags = []; mutate(() => { doc.programs.push(copy); doc.current_program_id = copy.id; }); break; }
    case 'delete-program': if (doc.programs.length > 1 && confirm(`Delete program “${p.name}” and its ${p.pieces.length} pieces?`)) {
      filterTags = []; mutate(() => { doc.programs = doc.programs.filter((x) => x.id !== p.id); doc.current_program_id = doc.programs[0].id; }); } break;
    case 'add-piece': mutate(() => { const np = blankPiece({ title: 'New piece', rank: p.pieces.length }); p.pieces.push(np); }); break;
    case 'delete-piece': if (confirm('Delete this piece?')) mutate(() => {
      p.pieces = p.pieces.filter((x) => x.id !== id);
      for (const k of ['exclusion_groups', 'inclusion_groups']) p[k] = p[k].map((g) => g.filter((x) => x !== id)).filter((g) => g.length >= 2);
    }); break;
    // Double-click to edit on desktop; single tap on touch (no double-tap
    // on a phone). `el` is the field itself — a table cell on desktop,
    // a card element on mobile.
    case 'edit-text': { const tap = window.matchMedia('(max-width: 800px)').matches;
      if (e.detail === 2 || (tap && e.detail === 1)) startTextEdit(el, el.dataset.field, id); break; }
    case 'edit-tags': { const tap = window.matchMedia('(max-width: 800px)').matches;
      if (e.detail === 2 || (tap && e.detail === 1)) openTagsDialog(id); break; }
    case 'routine-day': { const d = +el.dataset.day;
      const r = prog()?.pinned_routine; if (!r || Number.isNaN(d)) break;
      routineDay = Math.max(0, Math.min(d, r.columns.length - 1)); renderRoutine(); break; }
    case 'routine-day-item': {
      // Gap mode: ticking records the play in the log (persisted); the
      // done state reads the log, so it survives reloads. Frequency mode
      // keeps the in-memory done set.
      if (prog()?.mode === 'gap' && el.dataset.pieceId) {
        const id = el.dataset.pieceId;
        const today = todayStr();
        mutate(() => {
          const idx = p.play_log.findIndex((e) => e.date === today && e.piece_id === id);
          if (idx >= 0) p.play_log.splice(idx, 1);
          else p.play_log.push({ date: today, piece_id: id });
        });
      } else {
        const key = doneKey(prog()?.id, +el.dataset.day, el.dataset.piece);
        routineDone.has(key) ? routineDone.delete(key) : routineDone.add(key);
        renderRoutine();
      }
      break; }
    case 'routine-clear-done': {
      if (prog()?.mode === 'gap') {
        const today = todayStr();
        const ids = new Set((prog()?.pinned_routine?.ids || []).flat().filter(Boolean));
        mutate(() => { p.play_log = p.play_log.filter((e) => !(e.date === today && ids.has(e.piece_id))); });
      } else {
        clearDoneDay(prog()?.id, +el.dataset.day);
        renderRoutine();
      }
      break; }
    case 'switch-view': setMobileView(el.dataset.view); break;
    case 'routine-cell': { const piece = el.dataset.piece;
      pinnedPiece = pinnedPiece === piece ? null : piece; applyHighlight(pinnedPiece); break; }
    case 'edit-days': openDaysDialog(id); break;
    case 'edit-notes': openNotesDialog(id); break;
    case 'generate': await doGenerate(el); break;
    case 'unpin': clearDone(p.id); mutate(() => { p.pinned_routine = null; p.is_routine_pinned = false; }); break;
    case 'copy-routine': { if (!p.pinned_routine) break;
      // TSV, not a bullet list: pasting into Google Sheets / Excel splits
      // on tabs, so each day lands in its own column. First column is the
      // row number, matching the table's row headers; first row is the day
      // names. Labels are sanitized — a tab or newline inside a title
      // would break the grid.
      const r = p.pinned_routine;
      const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
      const lines = [['', ...r.columns].map(cell).join('\t'),
        ...r.data.map((row, i) => [r.indices?.[i] ?? `${i + 1}.`, ...row].map(cell).join('\t'))];
      await navigator.clipboard.writeText(lines.join('\n'));
      el.textContent = 'Copied'; setTimeout(render, 1200); break; }
    case 'export-json': download(`${p.name.replace(/\s+/g, '_')}.json`, JSON.stringify(doc, null, 2)); break;
    case 'import-json': $('#import-file').click(); break;
    case 'start-group': groupDraft = { kind: el.dataset.kind, selected: new Set() }; renderGroups(); break;
    case 'cancel-group': groupDraft = { kind: null, selected: new Set() }; renderGroups(); break;
    case 'save-group': if (groupDraft.selected.size < 2) { alert('Pick at least 2 pieces.'); break; }
      mutate(() => { p[groupDraft.kind].push([...groupDraft.selected]); groupDraft = { kind: null, selected: new Set() }; }); break;
    case 'delete-group': mutate(() => { p[el.dataset.kind].splice(+el.dataset.index, 1); }); break;
    case 'mode-local': await switchMode('local'); break;
    case 'mode-drive': await switchMode('drive'); break;
    case 'sign-out-drive': clearDriveToken(); if (mode === 'drive') await switchMode('local'); setStatus('saved', 'Signed out of Drive'); break;
    case 'open-settings': $('#settings-dialog').showModal(); break;
    // Dialog Close/Cancel buttons (no inline onclick — those are blocked
    // by the CSP, see the dialogs in app.html).
    case 'close-dialog': el.closest('dialog')?.close(); break;
    case 'save-settings': { const v = $('#setting-client-id').value.trim(); if (v) { saveClientId(v); clientId = v; } $('#settings-dialog').close(); break; }
  }
});

document.addEventListener('input', (e) => {
  const slider = e.target.closest('[data-piece-slider]');
  if (slider) {
    const p = prog(); const piece = p.pieces.find((x) => x.id === slider.dataset.pieceSlider);
    if (!piece) return;
    // The native step is 1% (see utils.js): the day grid is enforced
    // here, in JS, and both sliders are set to the snapped value.
    piece.perc = snapPerc(+slider.value, p.num_days);
    // Both copies of the slider (table row + mobile card) show the same
    // value, so update every visible one for this piece. The row label
    // shows "N days"; the card shows "N / M days".
    $$(`[data-piece-slider="${slider.dataset.pieceSlider}"]`).forEach((s) => {
      s.value = String(piece.perc);
      const val = s.closest('.perc-wrap')?.querySelector('.perc-val');
      if (val) val.textContent = s.closest('.piece-card')
        ? `${freqDays(piece.perc, p.num_days)} / ${p.num_days}`
        : freqLabel(piece.perc, p.num_days);
    });
    $('#pieces-per-day').textContent = `≈ ${piecesPerDay(p).toFixed(2)} pieces / day`;
    persist();
    return;
  }
  const ft = e.target.closest('[data-filter-tag]');
  if (ft) {
    filterTags = $$('[data-filter-tag]:checked').map((c) => c.dataset.filterTag);
    renderPieces();
    return;
  }
  const dp = e.target.closest('[data-draft-piece]');
  if (dp) { dp.checked ? groupDraft.selected.add(dp.dataset.draftPiece) : groupDraft.selected.delete(dp.dataset.draftPiece); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'search-pieces') { searchQuery = e.target.value.trim().toLowerCase(); renderPieces(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'hide-zero') { hideZero = e.target.checked; renderPieces(); }
  if (e.target.id === 'tag-dist-mode') { chartMode = e.target.checked ? 'duration' : 'count'; renderRoutine(); }
  if (e.target.id === 'schedule-mode') {
    const p = prog();
    // Switching modes converts every piece (perc <-> gap) and clears the
    // pinned routine; the play log is kept (see docs/gap-scheduling.md).
    mutate(() => { convertMode(p, e.target.value === 'gap' ? 'gap' : 'frequency'); clearDone(p.id); });
    e.target.value = p.mode;
  }
  if (e.target.id === 'session-minutes') {
    const p = prog();
    mutateNoRender(() => { p.session_minutes = Math.max(5, Math.min(480, Math.round(+e.target.value || 60))); });
    e.target.value = String(p.session_minutes);
    renderPieces(); // the session cap shows in the pieces-per-day badge
  }
  if (e.target.matches('[data-piece-gap]')) {
    const p = prog();
    const piece = p.pieces.find((x) => x.id === e.target.dataset.pieceGap);
    if (!piece) return;
    // Re-render: the "every N days" label and the due status update.
    mutate(() => { piece.gap = Math.max(0, Math.min(30, Math.round(+e.target.value || 0))); });
  }
  if (e.target.id === 'num-days') {
    // Empty input -> 8 (the default); 0 is clamped to 1, not to 8 —
    // `parseInt(...) || 8` used to send 0 to 8 as well.
    const p = prog(); const raw = parseInt(e.target.value, 10);
    const n = clamp(Number.isNaN(raw) ? 8 : raw, 1, 31);
    // No render here (see mutateNoRender): `change` fires on blur and a
    // render would swallow the click that caused the blur. The day grid
    // moved, so snap every frequency to it (Flask's updateSlider) and
    // update the visible sliders in place.
    mutateNoRender(() => {
      p.num_days = n;
      p.day_names = Array.from({ length: n }, (_, i) => p.day_names[i] || `Jour ${i + 1}`);
      p.pieces.forEach((pc) => { if (pc.custom_days) pc.custom_days = pc.custom_days.filter((d) => d < n); });
      p.pieces.forEach((pc) => { pc.perc = snapPerc(pc.perc, n); });
    });
    syncFreqSliders();
    e.target.value = String(n);
    $('#day-names').value = p.day_names.join(', ');
  }
  if (e.target.id === 'balance-by') {
    const p = prog();
    // Applies on the next Generate; the existing routine is untouched.
    mutateNoRender(() => { p.balance_by = e.target.value === 'duration' ? 'duration' : 'pieces'; });
    e.target.value = p.balance_by;
  }
  if (e.target.id === 'day-names') {
    const p = prog();
    mutateNoRender(() => { p.day_names = e.target.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, p.num_days);
      while (p.day_names.length < p.num_days) p.day_names.push(`Jour ${p.day_names.length + 1}`); });
    e.target.value = p.day_names.join(', ');
  }
  if (e.target.id === 'import-file' && e.target.files?.[0]) {
    const file = e.target.files[0];
    file.text().then((text) => {
      try { doc = normaliseDoc(JSON.parse(text)); filterTags = []; persist(); render(); }
      catch { alert('That file is not valid Practiae / Flask routine JSON.'); }
    });
    e.target.value = '';
  }
});

$('#days-save')?.addEventListener('click', () => {
  const dlg = $('#days-dialog'); const id = dlg.dataset.pieceId;
  const days = $$('#days-grid input:checked').map((c) => +c.value);
  mutate(() => { const piece = prog().pieces.find((x) => x.id === id); if (piece) piece.custom_days = days.length ? days : null; });
  dlg.close();
});
$('#notes-save')?.addEventListener('click', () => {
  const dlg = $('#notes-dialog'); const id = dlg.dataset.pieceId;
  mutate(() => { const piece = prog().pieces.find((x) => x.id === id); if (piece) piece.notes = $('#notes-text').value; });
  dlg.close();
});
// Tags dialog: live-apply toggles (a mutate() re-renders the background
// list; the dialog rebuilds its own content so it stays open and in sync).
$('#tags-dialog')?.addEventListener('click', (e) => {
  const piece = prog()?.pieces.find((x) => x.id === $('#tags-dialog').dataset.pieceId);
  if (!piece) return;
  const toggle = e.target.closest('[data-tag-toggle]');
  const remove = e.target.closest('[data-tag-remove]');
  const create = e.target.closest('[data-tag-create]');
  if (toggle) {
    const t = toggle.dataset.tagToggle;
    mutate(() => { piece.tags = (piece.tags || []).includes(t) ? piece.tags.filter((x) => x !== t) : [...(piece.tags || []), t]; });
    renderTagsDialog();
  } else if (remove) {
    const t = remove.dataset.tagRemove;
    mutate(() => { piece.tags = (piece.tags || []).filter((x) => x !== t); });
    renderTagsDialog();
  } else if (create) {
    createTagInDialog(create.dataset.tagCreate);
  }
});
$('#tags-search')?.addEventListener('input', () => renderTagsDialog());
$('#tags-search')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  const p = prog();
  if (p.pieces.flatMap((x) => x.tags || []).some((t) => t.toLowerCase() === q.toLowerCase())) return; // exact match exists — tap its row to toggle
  createTagInDialog(q);
});

// ---------- boot ----------
async function boot() {
  if (DEMO) document.body.classList.add('demo');
  $('#setting-client-id').value = clientId;
  $('#mode-label').textContent = DEMO ? 'demo (local only)' : mode;
  try {
    if (mode === 'drive' && !DEMO) {
      adapter = createDriveAdapter(clientId,
        (ev) => setStatus(ev.state, ev.detail || ''),
        (remoteDoc) => { doc = normaliseDoc(remoteDoc); render(); setStatus('saved', 'Updated from Drive'); });
      const remote = await adapter.load();
      doc = remote ? normaliseDoc(remote) : null;
    } else {
      doc = normaliseDoc(await adapter.load());
    }
  } catch (e) {
    // Drive unavailable (not signed in / origin not authorised): fall back
    // to local data rather than showing a blank page.
    setStatus('error', String(e.message || e));
    adapter = createLocalAdapter(); mode = 'local';
    doc = normaliseDoc(await adapter.load());
  }
  if (!doc || !doc.programs.length) {
    try {
      const res = await fetch('data/default_routine.json');
      doc = seedFromDefault(await res.json());
    } catch { doc = normaliseDoc({ programs: [blankProgram({ name: 'Toutes les pièces' })] }); }
    await adapter.save(doc);
  }
  setStatus('saved', DEMO ? 'Demo data, saved in this browser only' : mode === 'drive' ? 'Loaded from Google Drive' : 'Saved locally');
  render();
}
boot();
