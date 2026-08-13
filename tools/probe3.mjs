// probe3.mjs — browser check that the card subtitle's "peaks ~" agrees with the
// readout's "peak" (they used to be raw label Tmax vs the felt curve's peak —
// two different quantities under one word). Adds Vyvanse, then Dexedrine, and
// diffs subtitle peak against (readout peak − dose time) for each.
// Usage: node tools/probe3.mjs [port]
import { chromium } from 'playwright';

const port = process.argv[2] || '8000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 20000 });

async function add(q) {
  await page.fill('.searchbar__input', q);
  const opt = await page.waitForSelector('.searchbar__option', { timeout: 8000 }).catch(() => null);
  if (!opt) { console.log(`add(${q}): no search option appeared`); return; }
  await opt.click();
  await page.waitForTimeout(1500);
}

const parseH = (s, re) => {
  const m = s.match(re);
  if (!m) return null;
  return m[2] === 'min' ? Number(m[1]) / 60 : Number(m[1]);
};

async function check(label) {
  const cards = await page.$$eval('.card', (els) =>
    els.map((e) => ({
      sub: e.querySelector('.card__sub')?.textContent || '',
      time: e.querySelector('.doserows__time')?.value || '',
    })));
  const rows = await page.$$eval('.readout__row', (els) => els.map((e) => e.innerText.replace(/\n+/g, ' ')));
  for (let i = 0; i < cards.length; i++) {
    const subPeakH = parseH(cards[i].sub, /peaks ~([\d.]+) (h|min)/);
    const peakClock = (rows[i] || '').match(/peak\s+(\d{2}):(\d{2})/i);
    const [dh, dm] = cards[i].time.split(':').map(Number);
    let ok = '??';
    if (subPeakH != null && peakClock && cards[i].time) {
      const readoutPeakH = ((Number(peakClock[1]) * 60 + Number(peakClock[2]) - (dh * 60 + dm) + 1440) % 1440) / 60;
      ok = Math.abs(readoutPeakH - subPeakH) <= 0.11 ? 'MATCH' : `MISMATCH (readout says +${readoutPeakH.toFixed(2)}h)`;
    }
    console.log(`${label} card ${i}: [${cards[i].sub}] dose@${cards[i].time} :: ${rows[i] || '-'}\n  -> ${ok}`);
  }
}

await add('lisdexamfetamine');
await check('lisdex');
await add('dextroamphetamine');
await check('both  ');

// dextroamphetamine has 3 routes — flip its route select to XR, subtitle must follow
for (const sel of await page.$$('.chip--select')) {
  const hasXR = await sel.$$eval('option', (os) => os.some((o) => o.value === 'oral_XR'));
  if (!hasXR) continue;
  await sel.selectOption('oral_XR');
  await page.waitForTimeout(1200);
  await check('XR    ');
  break;
}

await page.screenshot({ path: 'tools/shot-peak-match.png' });
console.log('\nCONSOLE:', logs.length ? logs.join('\n  ') : 'clean');
await browser.close();
