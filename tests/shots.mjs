// Screenshots of the welcome page + the demo version after generating
// a routine, desktop + phone widths. Run with the server up: node tests/shots.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch();
// Welcome page, no interaction needed.
for (const [name, width] of [['welcome-desktop', 1400], ['welcome-mobile', 390]]) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.welcome-stat-card');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${name}.png`, fullPage: true });
  console.log(`saved ${name}.png`);
  await page.close();
}
for (const [name, width] of [['demo-desktop', 1400], ['demo-mobile', 390]]) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.goto('http://localhost:8000/demo.html', { waitUntil: 'networkidle' });
  // Desktop shows the table; mobile shows cards (the table is hidden).
  await page.waitForSelector(width > 800 ? '#pieces-body tr' : '.piece-card');
  // Two Generate buttons exist; only one is visible at each width.
  await page.click(width > 800 ? '.filters [data-action="generate"]' : '.mobile-bar [data-action="generate"]');
  await page.waitForSelector(width > 800 ? '.routine-table' : '.day-list li');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${name}.png`, fullPage: true });
  console.log(`saved ${name}.png`);
  await page.close();
}
await browser.close();
