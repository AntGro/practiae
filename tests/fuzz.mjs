// State-based fuzz test for the Practiae demo (demo.html — demo storage
// key only, never the real local data or Drive).
//
// Model: at each step the fuzzer reads the app state (the document in
// localStorage + the DOM), draws a random action that is enabled in that
// state, states its prediction, executes it in the browser, then checks
// the new state against the prediction. Any mismatch, console error or
// page error is a failure and is logged with the step that caused it.
//
//   node tests/fuzz.mjs [seed] [steps] [--mobile] [--local]
//   node tests/fuzz.mjs 1 60            # desktop demo, seed 1, 60 steps
//   node tests/fuzz.mjs 7 100 --mobile  # phone viewport, seed 7
//   node tests/fuzz.mjs 2 60 --local    # desktop, app.html + real local key
//
// The run is deterministic for a given seed (mulberry32). The server is
// started by this script (node serve.mjs on :8000) and stopped at the end.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const DEMO_KEY = 'practiae-gdrive:demo:v1';
const LOCAL_KEY = 'practiae-gdrive:v1';
const CLIENT_KEY = 'practiae:client_id';
const seed = parseInt(process.argv[2] || '1', 10);
const STEPS = parseInt(process.argv[3] || '60', 10);
const MOBILE = process.argv.includes('--mobile');
// --local runs against app.html (real local key, Drive buttons visible
// but never clicked — no Google sign-in in the fuzzer). Default is the
// demo (demo.html + demo key), which cannot test Settings' client-id
// field: it is hidden in demo mode (drive-only).
const LOCAL = process.argv.includes('--local');
const PAGE = LOCAL ? 'app.html' : 'demo.html';
const STORAGE_KEY = LOCAL ? LOCAL_KEY : DEMO_KEY;

// --- seeded RNG (mulberry32) ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(seed);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
const word = () => pick(WORDS) + '-' + rint(1, 99);

const failures = [];
const consoleErrors = [];
const pageErrors = [];
let lastDialog = null;
let pendingDialog = null; // { value } — what the next prompt/confirm should accept

function log(step, msg) { console.log(`[${String(step).padStart(3, '0')}] ${msg}`); }
function fail(step, msg) { failures.push({ step, msg }); console.log(`  ✗ FAIL: ${msg}`); }

// The app's pinned highlight (module-level `pinnedPiece`) survives
// re-renders — only the DOM classes are lost — and clicking the same
// cell again unpins it. The fuzzer tracks it to predict the toggle.
let pinnedLabel = null;

// --- state snapshot ---
async function snapshot(page) {
  return page.evaluate(([key, mobile]) => {
    const doc = JSON.parse(localStorage.getItem(key) || 'null');
    const prog = doc?.programs.find((p) => p.id === doc.current_program_id) || doc?.programs[0];
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    return {
      doc,
      settingsFieldVisible: (() => { const el = q('#setting-client-id'); return el ? el.offsetParent !== null : false; })(),
      programs: doc?.programs.length || 0,
      currentId: doc?.current_program_id,
      currentName: prog?.name,
      pieces: prog?.pieces.length || 0,
      pieceIds: (prog?.pieces || []).map((p) => p.id),
      numDays: prog?.num_days,
      dayNames: prog?.day_names || [],
      excl: prog?.exclusion_groups?.length || 0,
      incl: prog?.inclusion_groups?.length || 0,
      routine: !!prog?.pinned_routine,
      routineCols: prog?.pinned_routine?.columns.length || 0,
      routineRows: prog?.pinned_routine?.data.length || 0,
      visibleRows: mobile ? qa('#pieces-cards .piece-card').length
        : qa('#pieces-body tr[data-piece-id]').length,
      visiblePieceIds: mobile ? qa('#pieces-cards .piece-card').map((c) => c.dataset.pieceId)
        : qa('#pieces-body tr[data-piece-id]').map((tr) => tr.dataset.pieceId),
      visibleCards: qa('#pieces-cards .piece-card').length,
      tags: [...new Set((prog?.pieces || []).flatMap((p) => p.tags || []))],
      search: q('#search-pieces')?.value || '',
      hideZero: q('#hide-zero')?.checked || false,
      filterTags: qa('[data-filter-tag]:checked').map((c) => c.dataset.filterTag),
      groupDraftOpen: !q('#group-draft')?.hidden,
      daysDialogOpen: q('#days-dialog')?.open || false,
      notesDialogOpen: q('#notes-dialog')?.open || false,
      settingsOpen: q('#settings-dialog')?.open || false,
      chartCols: qa('#tag-chart .tag-dist-col').length,
      chartTotals: qa('#tag-chart .tag-dist-col-total').map((el) => el.textContent.trim()),
      routineDay: parseInt(q('.day-chip.active')?.dataset.day ?? '-1', 10),
      dayListCount: qa('#routine-mobile .day-list li').length,
      saveStatus: q('#save-status')?.textContent || '',
      modeBadge: q('#mode-badge')?.textContent || '',
      clientId: localStorage.getItem('practiae:client_id') || null,
    };
  }, [STORAGE_KEY, MOBILE]);
}
// Chrome falls back to "download" for non-ASCII blob filenames — the app
// sanitises them in utils.download; mirror that here for expectations.
const safeFilename = (name) => (name.replace(/\s+/g, '_') + '.json')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_');
const progOf = (snap) => snap.doc.programs.find((p) => p.id === snap.currentId) || snap.doc.programs[0];
const pieceOf = (snap, id) => progOf(snap).pieces.find((p) => p.id === id);
// Rows the pieces table should show, given the combined filters
// (search + hide-zero + tag filters all apply at once).
function visibleCount(pieces, { search, hideZero, filterTags }) {
  return pieces.filter((p) =>
    (!hideZero || (p.perc || 0) > 0)
    && filterTags.every((t) => (p.tags || []).includes(t))
    && (!search || `${p.title} ${p.composer} ${(p.tags || []).join(' ')}`.toLowerCase().includes(search))).length;
}
// The Generate button exists twice (desktop + sticky mobile bar);
// the visible one depends on the viewport.
const genBtn = (page) => page.locator('[data-action="generate"]').nth(MOBILE ? 1 : 0);
// A piece's row: a <tr> on desktop, a .piece-card on mobile. Both carry
// the same data-field / data-action attributes, so one selector works.
const rowPrefix = (id) => MOBILE ? `.piece-card[data-piece-id="${id}"]`
  : `#pieces-body tr[data-piece-id="${id}"]`;
const fieldSel = (id, field) => `${rowPrefix(id)} [data-field="${field}"]`;
const btnSel = (id, action) => `${rowPrefix(id)} [data-action="${action}"]`;
// Inline edit: double-click on desktop, single tap on touch.
const editTap = (loc) => MOBILE ? loc.click() : loc.dblclick();

// After a failed step, close any modal dialog the step left open: an
// open modal blocks every later click, so one failure would cascade
// into timeouts on all following steps.
async function cleanup(page) {
  pendingDialog = null;
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())).catch(() => {});
}

// Settle: let persist() finish (save-status leaves 'Saving…').
async function settle(page) {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => {
    const el = document.querySelector('#save-status');
    return el && !el.textContent.startsWith('Saving');
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(50);
}

// --- actions ---
// Each: { id, when(snap) => bool, run(page, snap) => { predict, verify(before, after) } }
// verify returns null on success or a failure string.
const ACTIONS = [
  { id: 'generate', when: (s) => s.pieces > 0,
    async run(page) {
      await genBtn(page).click();
      await page.waitForSelector('.routine-table', { state: 'attached', timeout: 5000 });
      return { predict: 'routine pinned, table + chart with num_days columns',
        verify: (b, a) => !a.routine ? 'no pinned routine after Generate'
          : a.routineCols !== a.numDays ? `chart/table columns ${a.routineCols} != num_days ${a.numDays}`
          : a.chartCols !== (a.tags.length ? a.numDays : 0) ? `chart has ${a.chartCols} columns, expected ${a.tags.length ? a.numDays : 0} (tags: ${a.tags.length})`
          : a.routineDay !== 0 && a.routineDay !== -1 ? `routineDay ${a.routineDay}, expected 0` : null };
    } },
  { id: 'generate-double', when: (s) => s.pieces > 0,
    async run(page) {
      await page.evaluate((mobile) => {
        const b = document.querySelectorAll('[data-action="generate"]')[mobile ? 1 : 0];
        b.click(); b.click();
      }, MOBILE);
      await page.waitForSelector('.routine-table', { state: 'attached', timeout: 5000 });
      return { predict: 'double-click Generate: one routine, no error (guard)',
        verify: (b, a) => !a.routine ? 'no routine after double Generate' : null };
    } },
  { id: 'freq-random', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const v = rint(0, 20) * 5;
      await page.evaluate(([pid, val]) => {
        const s = document.querySelector(`[data-piece-slider="${pid}"]`);
        s.value = String(val);
        s.dispatchEvent(new Event('input', { bubbles: true }));
      }, [id, v]);
      return { predict: `piece freq -> ${v}%`,
        verify: (b, a) => { const pc = pieceOf(a, id); return pc?.perc !== v ? `freq is ${pc?.perc}, expected ${v}` : null; } };
    } },
  { id: 'rename-title', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const name = 'Fuzz ' + word();
      const cell = page.locator(fieldSel(id, 'title')).first();
      await editTap(cell);
      await page.locator('.inline-edit').fill(name);
      await page.keyboard.press('Enter');
      return { predict: `title -> "${name}"`,
        verify: (b, a) => pieceOf(a, id)?.title !== name ? `title is "${pieceOf(a, id)?.title}", expected "${name}"` : null };
    } },
  { id: 'rename-title-cancel', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const before = pieceOf(snap, id)?.title;
      const cell = page.locator(fieldSel(id, 'title')).first();
      await editTap(cell);
      await page.locator('.inline-edit').fill('Should not stick');
      await page.keyboard.press('Escape');
      return { predict: 'Esc cancels the edit, title unchanged',
        verify: (b, a) => pieceOf(a, id)?.title !== before ? `title changed to "${pieceOf(a, id)?.title}" after Esc` : null };
    } },
  { id: 'rename-composer', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const name = 'Composer ' + word();
      const cell = page.locator(fieldSel(id, 'composer')).first();
      await editTap(cell);
      await page.locator('.inline-edit').fill(name);
      await page.keyboard.press('Enter');
      return { predict: `composer -> "${name}"`,
        verify: (b, a) => pieceOf(a, id)?.composer !== name ? `composer is "${pieceOf(a, id)?.composer}"` : null };
    } },
  { id: 'edit-duration', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const raw = rnd() < 0.25 ? 'abc' : String(rint(1, 30)); // garbage -> 0
      const expected = raw === 'abc' ? 0 : parseInt(raw, 10);
      const cell = page.locator(fieldSel(id, 'duration_min')).first();
      await editTap(cell);
      await page.locator('.inline-edit').fill(raw);
      await page.keyboard.press('Enter');
      return { predict: `duration "${raw}" -> ${expected} min`,
        verify: (b, a) => pieceOf(a, id)?.duration_min !== expected ? `duration is ${pieceOf(a, id)?.duration_min}, expected ${expected}` : null };
    } },
  { id: 'edit-tags', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const tags = rnd() < 0.2 ? '' : [pick(WORDS), pick(WORDS)].join(', ');
      const expected = tags.split(',').map((t) => t.trim()).filter(Boolean);
      const cell = page.locator(btnSel(id, 'edit-tags')).first();
      await editTap(cell);
      await page.locator('.inline-edit').fill(tags);
      await page.keyboard.press('Enter');
      return { predict: `tags -> [${expected.join(', ')}]`,
        verify: (b, a) => JSON.stringify(pieceOf(a, id)?.tags || []) !== JSON.stringify(expected) ? `tags are ${JSON.stringify(pieceOf(a, id)?.tags)}` : null };
    } },
  { id: 'add-piece', when: () => true,
    async run(page) {
      await page.locator('[data-action="add-piece"]').click();
      return { predict: 'one more piece, titled "New piece"',
        verify: (b, a) => a.pieces !== b.pieces + 1 ? `pieces ${a.pieces}, expected ${b.pieces + 1}`
          : progOf(a).pieces.at(-1)?.title !== 'New piece' ? `new piece title is "${progOf(a).pieces.at(-1)?.title}"` : null };
    } },
  { id: 'delete-piece', when: (s) => s.pieces > 1 && s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const groupsBefore = snap.excl + snap.incl;
      pendingDialog = { value: '' };
      await page.locator(btnSel(id, 'delete-piece')).first().click();
      return { predict: 'confirm accepted -> piece gone, groups pruned to >= 2 members',
        verify: (b, a) => pieceOf(a, id) ? 'piece still present after confirmed delete'
          : a.pieces !== b.pieces - 1 ? `pieces ${a.pieces}, expected ${b.pieces - 1}`
          : progOf(a).exclusion_groups.some((g) => g.length < 2) || progOf(a).inclusion_groups.some((g) => g.length < 2)
            ? 'a group with < 2 members survived the delete'
            : groupsBefore > a.excl + a.incl && lastDialog?.type !== 'confirm' ? 'delete ran without a confirm dialog' : null };
    } },
  { id: 'switch-program', when: (s) => s.programs > 1,
    async run(page, snap) {
      const other = snap.doc.programs.find((p) => p.id !== snap.currentId);
      await page.locator(`[data-action="switch-program"][data-id="${other.id}"]`).click();
      return { predict: `current program -> "${other.name}"`,
        verify: (b, a) => a.currentId !== other.id ? `current is ${a.currentId}` : a.currentName !== other.name ? `title shows "${a.currentName}"` : null };
    } },
  { id: 'add-program', when: () => true,
    async run(page) {
      await page.locator('[data-action="add-program"]').click();
      return { predict: 'new empty program becomes current',
        verify: (b, a) => a.programs !== b.programs + 1 ? `programs ${a.programs}, expected ${b.programs + 1}`
          : a.pieces !== 0 ? `new program has ${a.pieces} pieces` : null };
    } },
  { id: 'duplicate-program', when: (s) => s.pieces > 0,
    async run(page, snap) {
      await page.locator('[data-action="duplicate-program"]').click();
      return { predict: 'copy with same pieces, new ids, groups remapped',
        verify: (b, a) => {
          if (a.programs !== b.programs + 1) return `programs ${a.programs}`;
          const copy = progOf(a);
          if (copy.pieces.length !== b.pieces) return `copy has ${copy.pieces.length} pieces, expected ${b.pieces}`;
          if (copy.pieces.some((pc) => b.pieceIds.includes(pc.id))) return 'copy reuses original piece ids';
          if (copy.name !== `${b.currentName} (copy)`) return `copy name is "${copy.name}"`;
          return null;
        } };
    } },
  { id: 'rename-program', when: () => true,
    async run(page, snap) {
      const name = 'Program ' + word();
      pendingDialog = { value: name };
      await page.locator('[data-action="rename-program"]').click();
      return { predict: `program renamed -> "${name}" (prompt accepted)`,
        verify: (b, a) => a.currentName !== name ? `program name is "${a.currentName}"` : null };
    } },
  { id: 'delete-program', when: (s) => s.programs > 1,
    async run(page, snap) {
      pendingDialog = { value: '' };
      await page.locator('[data-action="delete-program"]').click();
      return { predict: 'confirm accepted -> one fewer program, current switches',
        verify: (b, a) => a.programs !== b.programs - 1 ? `programs ${a.programs}, expected ${b.programs - 1}`
          : a.currentId === b.currentId ? 'current program id unchanged after delete' : null };
    } },
  { id: 'num-days', when: () => true,
    async run(page, snap) {
      const raw = pick([1, 3, 8, 14, 31, 0, 99]);
      const expected = Math.max(1, Math.min(31, raw));
      await page.evaluate((v) => {
        const el = document.querySelector('#num-days');
        el.value = String(v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, raw);
      return { predict: `num_days ${raw} -> ${expected} (clamped 1-31)`,
        verify: (b, a) => a.numDays !== expected ? `num_days is ${a.numDays}, expected ${expected}`
          : a.dayNames.length !== expected ? `day_names has ${a.dayNames.length} entries` : null };
    } },
  { id: 'day-names', when: () => true,
    async run(page, snap) {
      const names = Array.from({ length: snap.numDays }, (_, i) => `D${i + 1}-${word()}`);
      await page.locator('#day-names').fill(names.join(', '));
      await page.locator('#day-names').dispatchEvent('change');
      return { predict: `day names -> ${names[0]}, … (${names.length})`,
        verify: (b, a) => JSON.stringify(a.dayNames) !== JSON.stringify(names) ? `day names are ${JSON.stringify(a.dayNames)}` : null };
    } },
  { id: 'search', when: (s) => s.pieces > 0,
    async run(page, snap) {
      const pc = pick(progOf(snap).pieces);
      const q = rnd() < 0.3 ? 'zzz-no-such-piece' : pc.title.slice(0, 4).toLowerCase();
      await page.locator('#search-pieces').fill(q);
      const expected = visibleCount(progOf(snap).pieces, { search: q, hideZero: snap.hideZero, filterTags: snap.filterTags });
      return { predict: `search "${q}" -> ${expected} visible rows`,
        verify: (b, a) => a.visibleRows !== expected ? `visible rows ${a.visibleRows}, expected ${expected}` : null };
    } },
  { id: 'clear-search', when: (s) => s.search !== '',
    async run(page, snap) {
      await page.locator('#search-pieces').fill('');
      const expected = visibleCount(progOf(snap).pieces, { search: '', hideZero: snap.hideZero, filterTags: snap.filterTags });
      return { predict: `search cleared -> ${expected} visible rows (other filters still apply)`,
        verify: (b, a) => a.visibleRows !== expected ? `visible ${a.visibleRows}, expected ${expected}` : null };
    } },
  { id: 'hide-zero', when: () => true,
    async run(page, snap) {
      const want = !snap.hideZero;
      await page.locator('#hide-zero').setChecked(want);
      const expected = visibleCount(progOf(snap).pieces, { search: snap.search, hideZero: want, filterTags: snap.filterTags });
      return { predict: `hide-zero ${want ? 'on' : 'off'} -> ${expected} visible rows`,
        verify: (b, a) => a.visibleRows !== expected ? `visible ${a.visibleRows}, expected ${expected}` : null };
    } },
  { id: 'filter-tag', when: (s) => s.tags.length > 0,
    async run(page, snap) {
      const tag = pick(snap.tags);
      const was = snap.filterTags.includes(tag);
      const next = was ? snap.filterTags.filter((t) => t !== tag) : [...snap.filterTags, tag];
      await page.locator(`[data-filter-tag="${tag}"]`).setChecked(!was);
      const expected = visibleCount(progOf(snap).pieces, { search: snap.search, hideZero: snap.hideZero, filterTags: next });
      return { predict: `tag filter ${was ? 'removes' : 'adds'} "${tag}" -> ${expected} visible rows`,
        verify: (b, a) => a.visibleRows !== expected ? `visible ${a.visibleRows}, expected ${expected}` : null };
    } },
  { id: 'days-dialog', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      await page.locator(btnSel(id, 'edit-days')).first().click();
      await page.waitForSelector('#days-dialog[open]');
      const days = [...new Set(Array.from({ length: rint(0, 3) }, () => rint(0, snap.numDays - 1)))];
      await page.evaluate((ds) => {
        document.querySelectorAll('#days-grid input').forEach((c) => { c.checked = ds.includes(+c.value); });
      }, days);
      await page.locator('#days-save').click();
      return { predict: `custom days -> [${days.join(', ')}]${days.length ? '' : ' (none -> null)'}`,
        verify: (b, a) => {
          const got = pieceOf(a, id)?.custom_days;
          const exp = days.length ? [...days].sort((x, y) => x - y) : null;
          return JSON.stringify(got) !== JSON.stringify(exp) ? `custom_days is ${JSON.stringify(got)}, expected ${JSON.stringify(exp)}` : null;
        } };
    } },
  { id: 'notes-dialog', when: (s) => s.visiblePieceIds.length > 0,
    async run(page, snap) {
      const id = pick(snap.visiblePieceIds);
      const text = 'Note ' + word();
      await page.locator(btnSel(id, 'edit-notes')).first().click();
      await page.waitForSelector('#notes-dialog[open]');
      await page.locator('#notes-text').fill(text);
      await page.locator('#notes-save').click();
      return { predict: `notes -> "${text}"`,
        verify: (b, a) => pieceOf(a, id)?.notes !== text ? `notes are "${pieceOf(a, id)?.notes}"` : null };
    } },
  { id: 'group-save', when: (s) => s.pieces >= 2,
    async run(page, snap) {
      const kind = pick(['exclusion_groups', 'inclusion_groups']);
      const ids = [...snap.pieceIds].sort(() => rnd() - 0.5).slice(0, rint(2, 3));
      await page.locator(`[data-action="start-group"][data-kind="${kind}"]`).click();
      for (const id of ids) await page.locator(`[data-draft-piece="${id}"]`).check();
      await page.locator('[data-action="save-group"]').click();
      return { predict: `${kind} gains a group of ${ids.length} pieces`,
        verify: (b, a) => {
          const g = progOf(a)[kind];
          const before = progOf(b)[kind];
          if (g.length !== before.length + 1) return `${kind} has ${g.length} groups, expected ${before.length + 1}`;
          if (JSON.stringify([...g.at(-1)].sort()) !== JSON.stringify([...ids].sort())) return `saved group is ${JSON.stringify(g.at(-1))}`;
          return null;
        } };
    } },
  { id: 'group-too-few', when: (s) => s.pieces >= 1,
    async run(page, snap) {
      const kind = pick(['exclusion_groups', 'inclusion_groups']);
      const id = pick(snap.pieceIds); // the draft lists every piece, filtered or not
      await page.locator(`[data-action="start-group"][data-kind="${kind}"]`).click();
      await page.locator(`[data-draft-piece="${id}"]`).check();
      pendingDialog = { value: '' };
      await page.locator('[data-action="save-group"]').click();
      const alertShown = lastDialog?.type === 'alert';
      await page.locator('[data-action="cancel-group"]').click();
      return { predict: 'saving 1-piece group -> alert, no group added',
        verify: (b, a) => progOf(a)[kind].length !== progOf(b)[kind].length ? 'a group was added despite < 2 pieces'
          : !alertShown ? 'no alert was shown for a 1-piece group' : null };
    } },
  { id: 'delete-group', when: (s) => s.excl + s.incl > 0,
    async run(page, snap) {
      const kind = snap.excl > 0 ? 'exclusion_groups' : 'inclusion_groups';
      await page.locator(`[data-action="delete-group"][data-kind="${kind}"]`).first().click();
      return { predict: `${kind} loses one group`,
        verify: (b, a) => progOf(a)[kind].length !== progOf(b)[kind].length - 1 ? `${kind} has ${progOf(a)[kind].length} groups` : null };
    } },
  { id: 'chart-toggle', when: (s) => s.routine && s.tags.length > 0,
    async run(page, snap) {
      const wantDuration = snap.chartTotals[0] ? !/min$/.test(snap.chartTotals[0]) : true;
      await page.locator('#tag-dist-mode').setChecked(wantDuration);
      return { predict: `chart -> ${wantDuration ? 'Duration (totals in min)' : 'Pieces (totals are counts)'}`,
        verify: (b, a) => {
          if (!a.chartTotals.length) return 'chart totals vanished after toggle';
          const isMin = /min$/.test(a.chartTotals[0]);
          return isMin !== wantDuration ? `totals are "${a.chartTotals[0]}", expected ${wantDuration ? 'minutes' : 'counts'}` : null;
        } };
    } },
  { id: 'routine-cell-pin', when: (s) => s.routine && !MOBILE,
    async run(page, snap) {
      const cell = page.locator('.routine-table td[data-piece]').first();
      const label = await cell.getAttribute('data-piece');
      const occurrences = await page.evaluate((lbl) =>
        [...document.querySelectorAll(`.routine-table td[data-piece="${CSS.escape(lbl)}"]`)].length, label);
      const expected = pinnedLabel === label ? 0 : occurrences; // click toggles the pin
      await cell.click();
      pinnedLabel = pinnedLabel === label ? null : label;
      return { predict: `click ${pinnedLabel ? 'pins' : 'unpins'} highlight on "${label}" (${expected} cells)`,
        verify: async (b, a) => {
          const n = await page.locator('.routine-table td.piece-highlight').count();
          return n !== expected ? `${n} highlighted cells, expected ${expected}` : null;
        } };
    } },
  { id: 'routine-day-next', when: (s) => s.routine && MOBILE,
    async run(page, snap) {
      const next = Math.min(snap.routineDay + 1, snap.numDays - 1);
      await page.locator('.day-chip.active').evaluate((el) => el.parentElement.children[next]?.click?.());
      return { predict: `day view -> day ${next + 1}`,
        verify: async (b, a) => {
          const n = await page.evaluate(() => document.querySelectorAll('#routine-mobile .day-list li').length);
          const exp = progOf(a).pinned_routine.data.map((row) => row[next]).filter(Boolean).length;
          return a.routineDay !== next ? `routineDay ${a.routineDay}, expected ${next}`
            : n !== exp ? `day list has ${n} items, expected ${exp}` : null;
        } };
    } },
  { id: 'unpin', when: (s) => s.routine,
    async run(page) {
      await page.locator('[data-action="unpin"]').click();
      return { predict: 'routine unpinned, placeholder text returns',
        verify: (b, a) => a.routine ? 'routine still pinned' : null };
    } },
  { id: 'copy-routine', when: (s) => s.routine,
    async run(page) {
      await page.locator('[data-action="copy-routine"]').click();
      // The label is set after the async clipboard write resolves.
      await page.waitForFunction(
        () => document.querySelector('[data-action="copy-routine"]')?.textContent.trim() === 'Copied',
        { timeout: 3000 }).catch(() => {});
      const text = await page.locator('[data-action="copy-routine"]').textContent();
      return { predict: 'button reads "Copied" right after clicking',
        verify: () => text !== 'Copied' ? `button reads "${text}"` : null };
    } },
  { id: 'export-json', when: () => true,
    async run(page, snap) {
      const expected = safeFilename(snap.currentName);
      const dl = page.waitForEvent('download', { timeout: 5000 });
      await page.locator('[data-action="export-json"]').click();
      const download = await dl;
      return { predict: `download of ${expected}`,
        verify: () => download.suggestedFilename() !== expected ? `downloaded "${download.suggestedFilename()}", expected "${expected}"` : null };
    } },
  // Regression for the swallowed-click bug (fuzzer seed 1, step 28):
  // typing in #day-names then clicking a button used to lose the click,
  // because the blur fired `change` -> full render -> the button under
  // the cursor was replaced between mousedown and mouseup.
  { id: 'day-names-then-generate', when: (s) => s.pieces > 0,
    async run(page, snap) {
      const names = Array.from({ length: snap.numDays }, (_, i) => `D${i + 1}-${word()}`);
      await page.locator('#day-names').fill(names.join(', '));
      await page.locator('#day-names').dispatchEvent('change');
      await genBtn(page).click();
      await page.waitForSelector('.routine-table', { state: 'attached', timeout: 5000 });
      return { predict: 'edit day names, then click Generate -> routine generates (click not swallowed)',
        verify: (b, a) => !a.routine ? 'no routine: the Generate click was swallowed after the day-names edit' : null };
    } },
  { id: 'import-valid', when: () => true,
    async run(page, snap) {
      const mod = JSON.parse(JSON.stringify(snap.doc));
      const cur = mod.programs.find((p) => p.id === mod.current_program_id);
      cur.name = 'Imported ' + word();
      await page.setInputFiles('#import-file', {
        name: 'practiae.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(mod)),
      });
      await page.waitForTimeout(300);
      return { predict: `import replaces the doc, program renamed -> "${cur.name}"`,
        verify: (b, a) => a.currentName !== cur.name ? `program name is "${a.currentName}"` : null };
    } },
  { id: 'import-invalid', when: () => true,
    async run(page, snap) {
      pendingDialog = { value: '' };
      await page.setInputFiles('#import-file', {
        name: 'bad.json', mimeType: 'application/json',
        buffer: Buffer.from('this is not json {'),
      });
      await page.waitForTimeout(300);
      const alertShown = lastDialog?.type === 'alert';
      return { predict: 'invalid import -> alert, document unchanged',
        verify: (b, a) => JSON.stringify(a.doc) !== JSON.stringify(b.doc) ? 'document changed after invalid import'
          : !alertShown ? 'no alert was shown for invalid JSON' : null };
    } },
  { id: 'settings-save', when: () => LOCAL,
    async run(page, snap) {
      const original = snap.clientId;
      const fresh = `fuzz-${rint(1000, 9999)}.apps.googleusercontent.com`;
      await page.locator('[data-action="open-settings"]').click();
      await page.waitForSelector('#settings-dialog[open]');
      await page.locator('#setting-client-id').fill(fresh);
      await page.locator('[data-action="save-settings"]').click();
      const saved = await page.evaluate((key) => localStorage.getItem(key), CLIENT_KEY);
      // Restore the original id so later steps (and the user) are unaffected.
      await page.locator('[data-action="open-settings"]').click();
      await page.locator('#setting-client-id').fill(original || '');
      await page.locator('[data-action="save-settings"]').click();
      return { predict: `client id saved as "${fresh}", then restored`,
        verify: () => saved !== fresh ? `stored client id is "${saved}"` : null };
    } },
  { id: 'settings-demo', when: () => !LOCAL,
    async run(page, snap) {
      await page.locator('[data-action="open-settings"]').click();
      await page.waitForSelector('#settings-dialog[open]');
      const visible = await page.locator('#setting-client-id').isVisible();
      await page.locator('#settings-dialog .row .btn:not(.primary):not(.drive-only)').click();
      return { predict: 'in demo the client-id field is hidden (drive-only) and the dialog closes',
        verify: (b, a) => visible ? 'client-id field is visible in demo mode'
          : a.settingsOpen ? 'settings dialog did not close' : null };
    } },
  { id: 'reload', when: () => true,
    async run(page, snap) {
      pinnedLabel = null; // a reload resets the app's module state
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector(MOBILE ? '#pieces-cards' : '#pieces-body tr', { state: 'attached', timeout: 10000 });
      return { predict: 'reload: document identical, UI state reset (search cleared)',
        verify: (b, a) => JSON.stringify(a.doc) !== JSON.stringify(b.doc) ? 'document changed across reload'
          : a.search !== '' ? `search still "${a.search}" after reload` : null };
    } },
];

// --- main ---
async function main() {
  const server = spawn('node', ['serve.mjs'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch {} };
  process.on('exit', stop);
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://localhost:8000/${PAGE}`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: MOBILE,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  page.on('dialog', async (d) => {
    lastDialog = { type: d.type(), message: d.message() };
    const v = pendingDialog?.value;
    pendingDialog = null;
    if (d.type() === 'prompt') await d.accept(v ?? 'Fuzz ' + word());
    else await d.accept();
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return; // sandbox has no internet
    consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // Fresh seed data for this run.
  await page.goto(`http://localhost:8000/${PAGE}`, { waitUntil: 'networkidle' });
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector(MOBILE ? '#pieces-cards .piece-card' : '#pieces-body tr', { timeout: 10000 });
  console.log(`fuzz run — seed ${seed}, ${STEPS} steps, ${MOBILE ? 'mobile 390px' : 'desktop 1280px'}, ${LOCAL ? 'local mode' : 'demo mode'}`);
  const startSnap = await snapshot(page);
  console.log(`start: ${startSnap.pieces} pieces, ${startSnap.programs} programs`);

  let ran = 0;
  for (let step = 1; step <= STEPS; step++) {
    lastDialog = null;
    const before = await snapshot(page);
    const enabled = ACTIONS.filter((a) => { try { return a.when(before); } catch { return false; } });
    if (!enabled.length) { console.log(`[${step}] no enabled actions — stopping`); break; }
    const action = pick(enabled);
    let outcome;
    try {
      outcome = await action.run(page, before);
    } catch (e) {
      fail(step, `${action.id}: threw ${e.message.split('\n').slice(0, 6).join(' | ')}`);
      log(step, `${action.id} — THREW (see failure)`);
      await cleanup(page);
      continue;
    }
    await settle(page);
    const after = await snapshot(page);
    log(step, `${action.id} — predicted: ${outcome.predict}`);
    let err = null;
    try { err = await outcome.verify(before, after); } catch (e) { err = `verify threw: ${e.message}`; }
    if (err) { fail(step, `${action.id}: ${err}`); await cleanup(page); }
    else console.log('  ✓ ok');
    ran++;
  }
  if (consoleErrors.length) failures.push({ step: 0, msg: `console errors: ${[...new Set(consoleErrors)].join(' | ')}` });
  if (pageErrors.length) failures.push({ step: 0, msg: `page errors: ${[...new Set(pageErrors)].join(' | ')}` });

  console.log(`\n=== ${ran} steps, ${failures.length} failure(s) ===`);
  for (const f of failures) console.log(`  step ${f.step}: ${f.msg}`);
  await browser.close();
  stop();
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
