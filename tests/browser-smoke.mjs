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
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
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
  check('slider edit persists across reload', firstPerc?.trim() === '50%', `got ${firstPerc}`);
  const stored = await page.evaluate(() => localStorage.getItem('practiae-gdrive:demo:v1'));
  check('demo key used in localStorage', !!stored && stored.includes('Toutes les pièces'));
  const realKey = await page.evaluate(() => localStorage.getItem('practiae-gdrive:v1'));
  check('real local key untouched', realKey === null);

  // Generate (desktop button in the filters row; the sticky mobile bar
  // has a second one, hidden on desktop).
  await page.click('.filters [data-action="generate"]');
  await page.waitForSelector('.routine-table', { timeout: 10000 });
  const cols = await page.locator('.routine-table thead th').count();
  check('routine table has 8 day columns + row header', cols === 9, `got ${cols}`);
  check('tag chart rendered', (await page.locator('#tag-chart .chart-row').count()) === 8);
  const saved = await page.textContent('#save-status');
  check('save status shows saved/demo', /Demo|Saved/i.test(saved || ''));

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
    (await mob.locator('.piece-card .perc-val').first().textContent())?.trim() === '25%');
  // Tap-to-edit on a card title (no double-click on touch).
  await mob.locator('.card-title').first().click();
  await mob.waitForSelector('.piece-card .inline-edit', { timeout: 5000 });
  await mob.locator('.piece-card .inline-edit').fill('Mobile edit test');
  await mob.keyboard.press('Enter');
  await mob.waitForTimeout(300);
  check('mobile: tap title edits it',
    (await mob.locator('.card-title').first().textContent())?.includes('Mobile edit test'));
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
