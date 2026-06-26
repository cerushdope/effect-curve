import { chromium } from 'playwright';

const url = 'http://localhost:8000';
const W = parseInt(process.argv[2] || '1366', 10);
const H = parseInt(process.argv[3] || '768', 10);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(300);

async function add(q) {
  await page.fill('.searchbar__input', q);
  await page.waitForTimeout(450);
  const opt = await page.$('.searchbar__option');
  if (opt) await opt.click();
  await page.waitForTimeout(800);
}
await add('stim');
await add('analgesic');

const rects = await page.$$eval('.readout__row', (els) =>
  els.map((e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  })
);
// detect overlap between any two rows
let overlap = false;
for (let i = 0; i < rects.length; i++)
  for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
    if (ox > 0 && oy > 0) overlap = true;
  }
const listRect = await page.$eval('.readout__list', (e) => {
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { w: Math.round(r.width), cols: cs.gridTemplateColumns };
});
const statsOverflow = await page.$$eval('.readout__stats', (els) =>
  els.map((e) => ({ scroll: e.scrollWidth, client: e.clientWidth, over: e.scrollWidth > e.clientWidth + 1 }))
);
console.log('statsOverflow', JSON.stringify(statsOverflow));
console.log('viewport', W + 'x' + H);
console.log('rows', JSON.stringify(rects));
console.log('OVERLAP:', overlap);
console.log('list width', listRect.w, 'cols:', listRect.cols);
console.log('LOGS:', logs.join(' | ') || '(none)');
await page.screenshot({ path: `tools/shot-readout-${W}.png` });
await browser.close();
