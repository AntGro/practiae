// Headless browser smoke test for the demo version.
// Run: node tests/browser-smoke.mjs
// Requires: playwright installed (npm i -D playwright; npx playwright install chromium)
// and the app served locally: node serve.mjs
// Checks, in a real Chromium on this machine: no sign-in, 68 pieces,
// slider edit persists across reload (localStorage demo key),
// Generate builds the routine table + tag chart, Add piece works.
// Exits non-zero on any failure; prints console/page errors.
import { chromium } from 'playwright';

const BASE = process.env.PRACTIAE_URL || 'http://localhost:8000/demo.html';
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch();
try {
  // ---- Welcome page (site root) ----
  const ROOT = BASE.replace(/demo\.html$/, '');
  const welcome = await browser.newPage();
  await welcome.goto(ROOT, { waitUntil: 'networkidle' });
  check('welcome: original logo reused', (await welcome.locator('img.welcome-logo-img[src="logo.svg"]').count()) === 1);
  check('welcome: Drive choice uses the Google Drive brand logo',
    (await welcome.locator('.choice-card[href="app.html?drive=1"] img[src="icons/brand/googledrive.svg"]').count()) === 1);
  check('welcome: demo choice links to demo.html',
    (await welcome.locator('.choice-card[href="demo.html"]').count()) === 1);
  check('welcome: Drive choice links to app.html?drive=1',
    (await welcome.locator('.choice-card[href="app.html?drive=1"]').count()) === 1);
  await welcome.waitForSelector('.welcome-stat-card', { timeout: 10000 });
  check('welcome: 4 live stat cards', (await welcome.locator('.welcome-stat-card').count()) === 4);
  check('welcome: tag chart rendered from the seed program',
    (await welcome.locator('#welcome-chart .tag-dist-col').count()) === 8);
  check('welcome: no emoji in the page', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(await welcome.content()));
  await welcome.click('.choice-card[href="demo.html"]');
  await welcome.waitForSelector('#pieces-body tr', { timeout: 10000 });
  check('welcome: demo choice opens the demo app',
    (await welcome.locator('#pieces-body tr').count()) === 68);

  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  // The VM's headless Chromium cannot reach the internet at all
  // (ERR_TUNNEL_CONNECTION_FAILED, even for example.com), so the
  // Google Fonts stylesheet fails to load here and falls back to the
  // system font stack. That is not an app error — ignore font-CDN
  // load failures, count everything else.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return;
    consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#pieces-body tr', { timeout: 10000 });

  check('badge says Demo, no sign-in', (await page.textContent('#mode-badge'))?.includes('Demo'));
  check('no Drive button visible', !(await page.locator('#mode-drive').isVisible()));
  check('program "Toutes les pièces" listed', (await page.textContent('#program-list'))?.includes('Toutes les pièces'));
  const rows = await page.locator('#pieces-body tr').count();
  check('68 piece rows', rows === 68, `got ${rows}`);

  // Edit: set first piece slider to 50, then reload and check persistence.
  const slider = page.locator('[data-piece-slider]').first();
  await slider.fill('50');
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#pieces-body tr');
  const firstPerc = await page.locator('.perc-val').first().textContent();
  check('slider edit persists across reload', firstPerc?.trim() === '4 days', `got ${firstPerc}`);
  // Frequency slider step is one day (100/num_days), like Flask's
  // updateSlider(); the label shows days, not percent.
  const firstStep = await page.locator('[data-piece-slider]').first().getAttribute('step');
  check('slider step is 100/num_days (12.5 at 8 days)', firstStep === '12.5', `got ${firstStep}`);
  await page.locator('#num-days').fill('16');
  await page.locator('#num-days').blur();
  await page.waitForTimeout(200);
  const step16 = await page.locator('[data-piece-slider]').first().getAttribute('step');
  const label16 = await page.locator('.perc-val').first().textContent();
  check('changing num-days re-steps sliders (6.25 at 16 days)', step16 === '6.25', `got ${step16}`);
  check('changing num-days re-labels in days (50% of 16 = 8 days)', label16?.trim() === '8 days', `got ${label16}`);
  await page.locator('#num-days').fill('8');
  await page.locator('#num-days').blur();
  await page.waitForTimeout(200);
  const step8 = await page.locator('[data-piece-slider]').first().getAttribute('step');
  check('changing num-days back restores the step', step8 === '12.5', `got ${step8}`);
  const stored = await page.evaluate(() => localStorage.getItem('practiae-gdrive:demo:v1'));
  check('demo key used in localStorage', !!stored && stored.includes('Toutes les pièces'));
  const realKey = await page.evaluate(() => localStorage.getItem('practiae-gdrive:v1'));
  check('real local key untouched', realKey === null);

  // Generate (desktop button in the filters row; the sticky mobile bar
  // has a second one, hidden on desktop).
  check('balance-by select defaults to Pieces',
    (await page.locator('#balance-by').inputValue()) === 'pieces');
  await page.click('.filters [data-action="generate"]');
  await page.waitForSelector('.routine-table', { timeout: 10000 });
  const cols = await page.locator('.routine-table thead th').count();
  check('routine table has 8 day columns + row header', cols === 9, `got ${cols}`);
  // Generate scrolls to the routine it just built.
  await page.waitForFunction(() => {
    const el = document.getElementById('generated-routine');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  }, { timeout: 5000 });
  check('Generate scrolls to the routine', true);
  check('tag chart rendered (vertical bars, one column per day)', (await page.locator('#tag-chart .tag-dist-col').count()) === 8);
  check('tag chart totals are pieces per day',
    /^\d+$/.test((await page.locator('#tag-chart .tag-dist-col-total').first().textContent())?.trim() || ''));
  // Pieces/Duration toggle (Flask feature).
  await page.check('#tag-dist-mode');
  await page.waitForTimeout(200);
  check('tag chart Duration view shows minutes',
    /min$/.test((await page.locator('#tag-chart .tag-dist-col-total').first().textContent())?.trim() || ''));
  await page.uncheck('#tag-dist-mode');
  // Balance-by Duration: switching the setting and regenerating still
  // produces a routine (the optimizer's duration mode runs in-page).
  await page.selectOption('#balance-by', 'duration');
  await page.click('.filters [data-action="generate"]');
  await page.waitForSelector('.routine-table', { timeout: 10000 });
  check('regenerate with Balance by Duration keeps the routine table',
    (await page.locator('.routine-table thead th').count()) === 9);
  check('balance-by setting persists across reload',
    await page.reload().then(async () => {
      await page.waitForSelector('.routine-table', { timeout: 10000 });
      return (await page.locator('#balance-by').inputValue()) === 'duration';
    }));
  await page.selectOption('#balance-by', 'pieces');
  // Routine cell highlighting (Flask feature): hover highlights the
  // same piece across all days; click pins it; Esc clears it.
  const firstCell = page.locator('.routine-table td[data-piece]').first();
  const piece = await firstCell.getAttribute('data-piece');
  await firstCell.hover();
  const hl = await page.evaluate((p) => {
    const els = [...document.querySelectorAll('.routine-table td.piece-highlight')];
    return { n: els.length, same: els.every((el) => el.dataset.piece === p) };
  }, piece);
  check('hovering a routine cell highlights the same piece everywhere',
    hl.n > 0 && hl.same, `${hl.n} cells`);
  await firstCell.click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  check('click pins the highlight after the mouse leaves',
    (await page.locator('.routine-table td.piece-highlight').count()) === hl.n);
  await page.keyboard.press('Escape');
  check('Esc clears the pinned highlight',
    (await page.locator('.routine-table td.piece-highlight').count()) === 0);
  const saved = await page.textContent('#save-status');
  check('save status shows saved/demo', /Demo|Saved/i.test(saved || ''));

  // Duration edit: two boxes (minutes + seconds), not one "m:ss" text entry.
  const durCell = page.locator('#pieces-body tr').first().locator('td[data-field="duration_min"]');
  await durCell.dblclick();
  await page.waitForSelector('.edit-duration-min', { timeout: 5000 });
  await page.locator('.edit-duration-min').fill('2');
  await page.locator('.edit-duration-sec').fill('20');
  await page.locator('.edit-duration-sec').press('Enter');
  await page.waitForTimeout(300);
  check('duration edit with min/sec boxes saves as 2:20',
    (await page.locator('#pieces-body tr').first().locator('td[data-field="duration_min"]').textContent())?.trim() === '2:20');

  // Tags dialog (Notion-style, live-apply): toggle a tag off, create a new
  // one, Done closes; the edits persist across reload. Chip/tag reads use
  // the data-* attributes, not substring matching: tag names are
  // hierarchical ("Chap. III." is a prefix of "Chap. III. Mod. 1").
  const chipTags = () => page.locator('#tags-chips [data-tag-remove]')
    .evaluateAll((els) => els.map((el) => el.dataset.tagRemove));
  const rowTags = () => page.locator('td[data-action="edit-tags"]:has(.tag)').first().locator('.tag')
    .evaluateAll((els) => els.map((el) => el.textContent.trim()));
  const tagsCell = page.locator('td[data-action="edit-tags"]:has(.tag)').first();
  await tagsCell.dblclick();
  await page.waitForSelector('#tags-dialog[open]', { timeout: 5000 });
  const removedTag = await page.locator('#tags-options .tag-option.selected').first().getAttribute('data-tag-toggle');
  await page.locator('#tags-options .tag-option.selected').first().click();
  await page.waitForTimeout(200);
  check('tags dialog toggles a tag off (live-apply)',
    !(await chipTags()).includes(removedTag));
  await page.fill('#tags-search', 'brand new tag');
  await page.waitForTimeout(200);
  await page.locator('[data-tag-create]').click();
  await page.waitForTimeout(200);
  check('tags dialog Create row adds the new tag as a chip',
    (await chipTags()).includes('brand new tag'));
  await page.locator('#tags-dialog [data-action="close-dialog"]').click();
  await page.waitForTimeout(200);
  check('Done closes the tags dialog', !(await page.locator('#tags-dialog').evaluate((d) => d.open)));
  const cellAfter = await rowTags();
  check('tags dialog edits are live on the row',
    cellAfter.includes('brand new tag') && !cellAfter.includes(removedTag));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#pieces-body tr');
  const cellPersisted = await rowTags();
  check('tags dialog edits persist across reload',
    cellPersisted.includes('brand new tag') && !cellPersisted.includes(removedTag));
  // Restore the removed tag: the regression checks below count the seed's
  // "Chap. III." pieces (22), so the test must leave the seed intact.
  await page.locator('td[data-action="edit-tags"]:has(.tag)').first().dblclick();
  await page.waitForSelector('#tags-dialog[open]', { timeout: 5000 });
  await page.locator(`#tags-options [data-tag-toggle="${removedTag}"]`).click();
  await page.waitForTimeout(200);
  await page.locator('#tags-dialog [data-action="close-dialog"]').click();
  await page.waitForTimeout(200);
  check('tags dialog toggles a tag back on',
    (await rowTags()).includes(removedTag));

  // Add a piece.
  await page.click('[data-action="add-piece"]');
  const rowsAfter = await page.locator('#pieces-body tr').count();
  check('add piece grows table to 69 rows', rowsAfter === 69, `got ${rowsAfter}`);
  // Wait for the debounced save to flush, then confirm the new piece
  // persisted — the mobile page below reads the same localStorage.
  await page.waitForTimeout(2500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#pieces-body tr');
  check('added piece persists across reload',
    (await page.locator('#pieces-body tr').count()) === 69);

  // Regression checks from the fuzz campaign (seed 1, Nov 18):
  // 1. A tag filter must not survive a program switch — its checkboxes
  //    are built from the current program's tags only, so a stale filter
  //    left the new program empty with no way to clear it.
  await page.locator('[data-filter-tag="Chap. III."]').check();
  check('tag filter narrows the list', (await page.locator('#pieces-body tr[data-piece-id]').count()) === 22);
  await page.click('[data-action="add-program"]');
  await page.waitForTimeout(200);
  check('tag filter is cleared on program switch',
    (await page.locator('[data-filter-tag]:checked').count()) === 0);
  await page.click('[data-action="add-piece"]');
  check('new program shows its pieces (no stale filter)',
    (await page.locator('#pieces-body tr[data-piece-id]').count()) === 1);
  // 2b. An untagged piece's card shows an "Add tags" affordance (the tags
  //     element used to render only when tags existed, so tags could not be
  //     added to an untagged piece on phone).
  check('untagged piece card shows Add tags',
    (await page.locator('.piece-card .card-tags').first().textContent())?.includes('Add tags'));
  // 2. Typing in #day-names then clicking a button must not swallow the
  //    click (blur fired `change` -> full render -> button replaced).
  await page.locator('#day-names').fill('Mon, Tue, Wed, Thu, Fri, Sat, Sun, Mon');
  await page.locator('#day-names').dispatchEvent('change');
  await page.click('[data-action="generate"]');
  await page.waitForSelector('.routine-table', { timeout: 5000 });
  check('day-names edit then Generate click is not swallowed',
    (await page.locator('.routine-table').count()) === 1);
  // 3. num-days 0 clamps to 1, not to the 8 default.
  await page.locator('#num-days').fill('0');
  await page.locator('#num-days').dispatchEvent('change');
  check('num-days 0 -> 1', (await page.locator('#num-days').inputValue()) === '1');
  // 4. Dialog Close buttons work (inline onclick was blocked by the CSP).
  await page.click('[data-action="open-settings"]');
  await page.waitForSelector('#settings-dialog[open]');
  await page.locator('#settings-dialog .row .btn:not(.primary):not(.drive-only)').click();
  check('settings dialog Close button closes it',
    !(await page.locator('#settings-dialog').evaluate((d) => d.open)));
  // 5. Export of the default program ("Toutes les pièces") downloads
  //    under an ASCII name — Chrome falls back to "download" for
  //    non-ASCII blob filenames.
  await page.click('[data-action="switch-program"]');
  const dl = page.waitForEvent('download', { timeout: 5000 });
  await page.click('[data-action="export-json"]');
  check('export filename is ASCII-sanitised',
    (await dl).suggestedFilename() === 'Toutes_les_pieces.json');

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // ---- Mobile (390px): cards, not tables ----
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const mobErrors = [];
  mob.on('pageerror', (e) => mobErrors.push(String(e)));
  await mob.goto(BASE, { waitUntil: 'networkidle' });
  await mob.waitForSelector('.piece-card', { timeout: 10000 });
  check('mobile: pieces table hidden, cards shown',
    !(await mob.locator('.pieces-table').isVisible()) && (await mob.locator('.piece-card').first().isVisible()));
  // Note: newPage() is a fresh browser context, so the mobile page reads
  // its own localStorage (the 68-piece seed), not the desktop page's.
  const cardCount = await mob.locator('.piece-card').count();
  const mobRows = await mob.locator('#pieces-body tr').count();
  check('mobile: one card per piece', cardCount === mobRows, `got ${cardCount} cards, ${mobRows} rows`);
  check('mobile: no horizontal page overflow',
    (await mob.evaluate(() => document.body.scrollWidth)) <= 391,
    `scrollWidth ${await mob.evaluate(() => document.body.scrollWidth)}`);
  check('mobile: sticky Generate bar visible',
    await mob.locator('.mobile-bar').isVisible());
  // Search narrows the cards.
  await mob.fill('#search-pieces', 'chop');
  await mob.waitForTimeout(200);
  const found = await mob.locator('.piece-card').count();
  check('mobile: search narrows cards', found > 0 && found < cardCount, `got ${found}`);
  await mob.fill('#search-pieces', '');
  await mob.waitForTimeout(200);
  // Card slider syncs to the (hidden) table slider.
  const cardSlider = mob.locator('.piece-card [data-piece-slider]').first();
  await cardSlider.fill('25');
  await mob.waitForTimeout(200);
  check('mobile: card slider updates its value',
    (await mob.locator('.piece-card .perc-val').first().textContent())?.trim() === '2 / 8'); // 25% of 8 days
  // Tap-to-edit on a card title (no double-click on touch).
  await mob.locator('.card-title').first().click();
  await mob.waitForSelector('.piece-card .inline-edit', { timeout: 5000 });
  await mob.locator('.piece-card .inline-edit').fill('Mobile edit test');
  await mob.keyboard.press('Enter');
  await mob.waitForTimeout(300);
  check('mobile: tap title edits it',
    (await mob.locator('.card-title').first().textContent())?.includes('Mobile edit test'));
  // Tap a card's tags to open the tags dialog (phone path: single tap).
  await mob.locator('.card-tags').first().click();
  await mob.waitForSelector('#tags-dialog[open]', { timeout: 5000 });
  const mobChipTags = () => mob.locator('#tags-chips [data-tag-remove]')
    .evaluateAll((els) => els.map((el) => el.dataset.tagRemove));
  const mobRemoved = await mob.locator('#tags-options .tag-option.selected').first().getAttribute('data-tag-toggle');
  await mob.locator('#tags-options .tag-option.selected').first().click();
  await mob.waitForTimeout(200);
  check('mobile: tags dialog toggles a tag off',
    !(await mobChipTags()).includes(mobRemoved));
  await mob.locator('#tags-dialog [data-action="close-dialog"]').click();
  await mob.waitForTimeout(200);
  check('mobile: Done closes the tags dialog', !(await mob.locator('#tags-dialog').evaluate((d) => d.open)));
  // Generate from the sticky bar, then day-by-day routine view.
  await mob.click('.mobile-bar [data-action="generate"]');
  await mob.waitForSelector('.day-list li', { timeout: 10000 });
  const day1 = await mob.locator('.day-list li').count();
  check('mobile: day view lists one day of pieces', day1 > 0, `got ${day1}`);
  check('mobile: routine table hidden, day view shown',
    !(await mob.locator('.routine-table').isVisible()) && (await mob.locator('.routine-mobile').isVisible()));
  await mob.locator('.day-chip[data-day="1"]').click();
  await mob.waitForTimeout(200);
  check('mobile: switching to day 2 keeps a non-empty list',
    (await mob.locator('.day-list li').count()) > 0 &&
    (await mob.locator('.day-chip[data-day="1"].active').count()) === 1);
  check('mobile: no page errors', mobErrors.length === 0, mobErrors.join(' | '));
} finally {
  await browser.close();
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nAll browser smoke checks passed');
