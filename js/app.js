// Practiae (front-only) — UI. Vanilla JS, ES modules, no build.
// All user strings rendered through esc(). Inline edits save only on
// Enter / explicit Save; blur / Esc cancels (same rule as DeLaClaw).
// Mutations go through mutate() -> persist (adapter.save) -> render().
// One document-level click handler (data-action) — no per-element onclick.

import { esc, uid, guard, download, clamp, formatDuration, parseDuration, freqStep, freqDays, snapPerc, freqLabel } from './utils.js';
import { resolveClientId, saveClientId, driveFolderName } from './config.js';
import { blankPiece, blankProgram, normaliseDoc, seedFromDefault, currentProgram,
  renumber, groupsAsRanks, generationPieces, piecesPerDay } from './store.js';
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

function pieceRow(p, numDays) {
  const daysLabel = p.custom_days?.length ? `Days ${p.custom_days.map((d) => d + 1).join(', ')}` : 'Any day';
  const tags = (p.tags || []).map((t) => `<span class="tag" style="--tag-color:${esc(tagColor(t))}">${esc(t)}</span>`).join(' ');
  return `<tr data-piece-id="${esc(p.id)}">
    <td class="rank">${p.rank + 1}</td>
    <td class="editable" data-action="edit-text" data-field="title" data-id="${esc(p.id)}" title="Double-click to edit">${esc(p.title) || '<span class="muted">Untitled</span>'}</td>
    <td class="editable" data-action="edit-text" data-field="composer" data-id="${esc(p.id)}" title="Double-click to edit">${esc(p.composer)}</td>
    <td><span class="perc-wrap"><input type="range" min="0" max="100" step="${freqStep(numDays)}" value="${p.perc}" data-piece-slider="${esc(p.id)}" aria-label="Frequency in days">
        <span class="perc-val">${freqLabel(p.perc, numDays)}</span></span></td>
    <td class="editable" data-action="edit-tags" data-id="${esc(p.id)}" title="Double-click to edit tags">${tags || '<span class="muted">—</span>'}</td>
    <td class="editable" data-action="edit-text" data-field="duration_min" data-id="${esc(p.id)}" title="Double-click to edit">${formatDuration(p.duration_min)}</td>
    <td><button class="btn small" data-action="edit-days" data-id="${esc(p.id)}">${esc(daysLabel)}</button></td>
    <td><button class="btn small" data-action="edit-notes" data-id="${esc(p.id)}">${p.notes ? 'Notes…' : 'Add note'}</button></td>
    <td><button class="btn small danger" data-action="delete-piece" data-id="${esc(p.id)}" aria-label="Delete piece">Delete</button></td>
  </tr>`;
}

// Mobile card for one piece — same data-actions as the desktop table row,
// so one delegated handler serves both. On a phone the table is hidden
// and these cards are shown instead: big title, full-width slider,
// tap-to-edit (no double-click on touch), actions in one thumb row.
function pieceCard(p, numDays) {
  const daysLabel = p.custom_days?.length ? `Days ${p.custom_days.map((d) => d + 1).join(', ')}` : 'Any day';
  const tags = (p.tags || []).map((t) => `<span class="tag" style="--tag-color:${esc(tagColor(t))}">${esc(t)}</span>`).join(' ');
  return `<article class="piece-card" data-piece-id="${esc(p.id)}">
    <div class="card-head">
      <div class="card-titles">
        <div class="card-title editable" data-action="edit-text" data-field="title" data-id="${esc(p.id)}">${esc(p.title) || '<span class="muted">Untitled</span>'}</div>
        <div class="card-composer editable" data-action="edit-text" data-field="composer" data-id="${esc(p.id)}">${esc(p.composer) || '<span class="muted">No composer</span>'}</div>
      </div>
      <span class="card-rank">#${p.rank + 1}</span>
    </div>
    <label class="card-freq"><span class="perc-wrap"><input type="range" min="0" max="100" step="${freqStep(numDays)}" value="${p.perc}" data-piece-slider="${esc(p.id)}" aria-label="Frequency in days">
      <span class="perc-val">${freqDays(p.perc, numDays)}</span></span><span class="card-freq-hint">of days</span></label>
    ${tags ? `<div class="card-tags editable" data-action="edit-tags" data-id="${esc(p.id)}">${tags}</div>` : ''}
    <div class="card-meta"><button class="btn small" data-action="edit-text" data-field="duration_min" data-id="${esc(p.id)}">${formatDuration(p.duration_min) || 'Add duration'}</button></div>
    <div class="card-actions">
      <button class="btn" data-action="edit-days" data-id="${esc(p.id)}">${esc(daysLabel)}</button>
      <button class="btn" data-action="edit-notes" data-id="${esc(p.id)}">${p.notes ? 'Notes…' : 'Add note'}</button>
      <button class="btn danger" data-action="delete-piece" data-id="${esc(p.id)}" aria-label="Delete piece">Delete</button>
    </div>
  </article>`;
}

function renderPieces() {
  const p = prog();
  if (!p) { $('#pieces-body').innerHTML = ''; $('#pieces-cards').innerHTML = ''; return; }
  let pieces = [...p.pieces].sort((a, b) => a.rank - b.rank);
  if (hideZero) pieces = pieces.filter((x) => (x.perc || 0) > 0);
  if (filterTags.length) pieces = pieces.filter((x) => filterTags.every((t) => (x.tags || []).includes(t)));
  if (searchQuery) pieces = pieces.filter((x) =>
    `${x.title} ${x.composer} ${(x.tags || []).join(' ')}`.toLowerCase().includes(searchQuery));
  $('#pieces-body').innerHTML = pieces.map((x) => pieceRow(x, p.num_days)).join('') ||
    `<tr><td colspan="9" class="empty">No pieces match. Add one below, or clear the filter.</td></tr>`;
  $('#pieces-cards').innerHTML = pieces.map((x) => pieceCard(x, p.num_days)).join('') ||
    `<p class="empty">No pieces match. Add one below, or clear the filter.</p>`;
  const perDay = `≈ ${piecesPerDay(p).toFixed(2)} pieces / day`;
  $('#pieces-per-day').textContent = perDay;
  $('#mobile-pieces-per-day').textContent = pieces.length === p.pieces.length
    ? `${p.pieces.length} pieces · ≈ ${piecesPerDay(p).toFixed(0)}/day`
    : `${pieces.length} of ${p.pieces.length} pieces · ≈ ${piecesPerDay(p).toFixed(0)}/day`;
  $('#pieces-count').textContent = pieces.length === p.pieces.length ? '' : `${pieces.length} of ${p.pieces.length} pieces shown`;
  $('#program-title').textContent = p.name;
  $('#num-days').value = p.num_days;
  $('#balance-by').value = p.balance_by || 'pieces';
  $('#day-names').value = (p.day_names || []).join(', ');
  const allTags = [...new Set(p.pieces.flatMap((x) => x.tags || []))].sort();
  $('#filter-tags').innerHTML = allTags.map((t) =>
    `<label class="filter-tag"><input type="checkbox" data-filter-tag="${esc(t)}" ${filterTags.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
}

// Update the visible frequency sliders in place (step, value, label) after
// the day count changed — that path does not re-render (see the num-days
// handler), so the sliders would otherwise keep the old grid.
function syncFreqSliders() {
  const p = prog(); if (!p) return;
  const step = freqStep(p.num_days);
  $$('[data-piece-slider]').forEach((s) => {
    const piece = p.pieces.find((x) => x.id === s.dataset.pieceSlider);
    if (!piece) return;
    s.step = String(step);
    s.value = String(piece.perc);
    const val = s.closest('.perc-wrap')?.querySelector('.perc-val');
    if (val) val.textContent = s.closest('.piece-card')
      ? String(freqDays(piece.perc, p.num_days))
      : freqLabel(piece.perc, p.num_days);
  });
}

function renderRoutine() {
  const p = prog();
  const box = $('#routine-box');
  const mob = $('#routine-mobile');
  if (!p?.pinned_routine) {
    box.innerHTML = `<p class="muted">No routine generated yet for this program. Set frequencies, then Generate.</p>`;
    mob.innerHTML = `<p class="muted">No routine generated yet. Set frequencies, then tap Generate below.</p>`;
    $('#tag-chart').innerHTML = '';
    return;
  }
  const r = p.pinned_routine;
  // Mobile day-by-day view: one day at a time beats an 8-column table
  // squeezed onto a phone. The desktop table is hidden on mobile.
  const day = Math.max(0, Math.min(routineDay, r.columns.length - 1));
  routineDay = day;
  const items = r.data.map((row) => row[day]).filter(Boolean);
  mob.innerHTML = `<div class="day-nav">
      <button class="btn" data-action="routine-day" data-day="${day - 1}" ${day === 0 ? 'disabled' : ''} aria-label="Previous day">←</button>
      <div class="day-chips">${r.columns.map((c, i) => `<button class="day-chip ${i === day ? 'active' : ''}" data-action="routine-day" data-day="${i}">${esc(c)}</button>`).join('')}</div>
      <button class="btn" data-action="routine-day" data-day="${day + 1}" ${day === r.columns.length - 1 ? 'disabled' : ''} aria-label="Next day">→</button>
    </div>
    <p class="muted">${items.length} piece${items.length === 1 ? '' : 's'} · ${esc(r.columns[day])}</p>
    <ol class="day-list">${items.map((cell) => `<li>${esc(cell)}</li>`).join('')}</ol>`;
  const maxRows = r.data.length;
  // data-piece on each non-empty cell powers the hover/click highlighting
  // below (same attribute the Flask app used).
  box.innerHTML = `<table class="routine-table"><thead><tr><th></th>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${r.data.map((row, i) => `<tr><th>${esc(r.indices[i] || '')}</th>${row.map((cell) => cell ? `<td data-piece="${esc(cell)}" data-action="routine-cell">${esc(cell)}</td>` : '<td></td>').join('')}</tr>`).join('')}</tbody></table>
    <p class="muted">${maxRows} rows · pinned ${p.is_routine_pinned ? 'yes' : 'no'} · hover a piece to see it across all days (click to pin)</p>`;
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
  // The duration cell displays m:ss, so the edit box must too — showing the
  // raw float ("2.3333333333333335") would be the bug all over again, and
  // typing "2:20" into a parseFloat box would silently save 2 minutes.
  const old = field === 'duration_min' ? formatDuration(piece.duration_min) : String(piece[field] || '');
  const originalHTML = cell.innerHTML; // restore on cancel (no full render — see below)
  cell.innerHTML = `<input class="inline-edit" value="${esc(old)}" ${field === 'duration_min' ? 'placeholder="m:ss"' : ''} aria-label="Edit ${field}">`;
  const input = cell.querySelector('input');
  input.focus(); input.select();
  let done = false;
  const save = () => { if (done) return; done = true;
    const v = input.value.trim();
    mutate(() => {
      if (field === 'duration_min') piece.duration_min = parseDuration(v);
      else piece[field] = v;
    });
  };
  // Cancel runs on blur — a full render here would replace the element
  // under the cursor between mousedown and mouseup and swallow the click
  // that caused the blur, so just put the cell back as it was.
  const cancel = () => { if (done) return; done = true; cell.innerHTML = originalHTML; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); e.stopPropagation(); });
  input.addEventListener('blur', cancel);
}
function startTagsEdit(cell, id) {
  const p = prog(); const piece = p.pieces.find((x) => x.id === id);
  if (!piece || cell.querySelector('input')) return;
  const originalHTML = cell.innerHTML; // restore on cancel (no full render — see startTextEdit)
  cell.innerHTML = `<input class="inline-edit" value="${esc((piece.tags || []).join(', '))}" placeholder="tag1, tag2" aria-label="Edit tags">`;
  const input = cell.querySelector('input');
  input.focus(); input.select();
  let done = false;
  const save = () => { if (done) return; done = true;
    mutate(() => { piece.tags = input.value.split(',').map((t) => t.trim()).filter(Boolean); }); };
  const cancel = () => { if (done) return; done = true; cell.innerHTML = originalHTML; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); e.stopPropagation(); });
  input.addEventListener('blur', cancel);
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
    const { exclusion, inclusion } = groupsAsRanks(p);
    const gen = generateOptimizedRoutine({ num_days: p.num_days, pieces: generationPieces(p) }, exclusion, inclusion, { balanceBy: p.balance_by || 'pieces' });
    generated = gen;
    const maxRows = Math.max(0, ...gen.days.map((d) => d.length));
    const data = Array.from({ length: maxRows }, (_, r) =>
      gen.days.map((day) => (day[r] ? pieceLabel(day[r]) : '')));
    routineDay = 0; // new routine opens on day 1 in the mobile day view
    mutate(() => {
      p.pinned_routine = { columns: p.day_names, indices: Array.from({ length: maxRows }, (_, i) => `${i + 1}.`), data, tag_distribution: gen.tagDistribution };
      p.is_routine_pinned = true;
    });
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
      if (e.detail === 2 || (tap && e.detail === 1)) startTagsEdit(el, id); break; }
    case 'routine-day': { const d = +el.dataset.day;
      const r = prog()?.pinned_routine; if (!r || Number.isNaN(d)) break;
      routineDay = Math.max(0, Math.min(d, r.columns.length - 1)); renderRoutine(); break; }
    case 'routine-cell': { const piece = el.dataset.piece;
      pinnedPiece = pinnedPiece === piece ? null : piece; applyHighlight(pinnedPiece); break; }
    case 'edit-days': openDaysDialog(id); break;
    case 'edit-notes': openNotesDialog(id); break;
    case 'generate': await doGenerate(el); break;
    case 'unpin': mutate(() => { p.pinned_routine = null; p.is_routine_pinned = false; }); break;
    case 'copy-routine': { if (!p.pinned_routine) break;
      const text = p.pinned_routine.columns.map((c, d) => `${c}:\n${p.pinned_routine.data.map((row) => row[d]).filter(Boolean).map((x) => `  - ${x}`).join('\n')}`).join('\n');
      await navigator.clipboard.writeText(text); el.textContent = 'Copied'; setTimeout(render, 1200); break; }
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
    piece.perc = +slider.value;
    // Both copies of the slider (table row + mobile card) show the same
    // value, so update every visible one for this piece. The row label
    // shows "N days"; the card shows the bare number ("of days" follows).
    $$(`[data-piece-slider="${slider.dataset.pieceSlider}"]`).forEach((s) => {
      s.value = slider.value;
      const val = s.closest('.perc-wrap')?.querySelector('.perc-val');
      if (val) val.textContent = s.closest('.piece-card')
        ? String(freqDays(piece.perc, p.num_days))
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
