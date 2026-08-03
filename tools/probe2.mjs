// probe2.mjs — browser check for the PD rewrite.
// Adds a stimulant and a benzo, screenshots felt + plasma, flips the condition
// chips, and reports console errors. Usage: node tools/probe2.mjs [port]
import { chromium } from 'playwright';

const port = process.argv[2] || '8000';
const url = `http://localhost:${port}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

async function add(q) {
  await page.fill('.searchbar__input', q);
  await page.waitForTimeout(1600);
  const opt = await page.$('.searchbar__option');
  if (opt) await opt.click();
  await page.waitForTimeout(1200);
}

await add('adderall');
await page.screenshot({ path: 'tools/shot-felt-stim.png' });

const readout = async () => page.$$eval('.readout__row', (els) => els.map((e) => e.innerText.replace(/\n+/g, ' | ')));
console.log('FELT   :', (await readout()).join('\n         '));

// the condition chips
const chips = await page.$$eval('.chip', (els) => els.map((e) => e.textContent.trim()));
console.log('CHIPS  :', chips.join('  /  '));

// flip tolerance to daily -> expect a below-baseline start and a bigger crash
const tol = await page.$$('.chip');
if (tol.length) { await tol[tol.length - 1].click(); await page.waitForTimeout(1200); }
await page.screenshot({ path: 'tools/shot-felt-daily.png' });
console.log('DAILY  :', (await readout()).join('\n         '));

// plasma view
await page.click('#mode-plasma');
await page.waitForTimeout(1200);
await page.screenshot({ path: 'tools/shot-plasma.png' });
console.log('PLASMA :', (await readout()).join('\n         '));

await page.click('#mode-felt');
await add('diazepam');
await page.waitForTimeout(1200);
await page.screenshot({ path: 'tools/shot-two.png' });
console.log('BOTH   :', (await readout()).join('\n         '));
console.log('LEGEND :', await page.$eval('#chart-legend', (e) => e.textContent).catch(() => '-'));

console.log('\nCONSOLE:', logs.length ? logs.join('\n  ') : 'clean');
await browser.close();
