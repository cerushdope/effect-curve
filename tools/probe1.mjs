import { chromium } from 'playwright';
const url = 'http://localhost:8000';
const query = process.argv[2] || 'cardiac';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.fill('.searchbar__input', query);
await page.waitForTimeout(450);
const opt = await page.$('.searchbar__option');
if (opt) await opt.click();
await page.waitForTimeout(900);
const info = await page.evaluate(() => ({
  card: document.querySelector('.card__title')?.textContent,
  sub: document.querySelector('.card__sub')?.textContent,
  offset: [...document.querySelectorAll('.readout__stat')].map((e) => e.textContent).join(' | '),
}));
console.log(query, '->', JSON.stringify(info));
console.log('LOGS:', logs.join(' | ') || '(none)');
await page.screenshot({ path: `tools/shot-q-${query}.png` });
await browser.close();
