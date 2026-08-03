// make-assets.mjs — extension icons + Chrome Web Store listing assets.
//
//   node tools/make-assets.mjs
//
// Renders SVG through the browser we already depend on for probes, so there is
// no image library and no design tool in the loop. Writes:
//
//   extension/icons/icon{16,48,128}.png   the extension itself (committed)
//   store/icon-128.png                    Web Store listing icon
//   store/promo-440x280.png               small promo tile
//   store/screenshot-1280x800.png         real app, real curve
//
// The icon is the app's own mark: a rise-peak-fall curve. At 16px everything
// but the silhouette is lost, so the curve is drawn thick and the plateau
// exaggerated — a literal miniature of the chart turns to mush at that size.

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INK = "#1A1D21";
const TEAL = "#2E4D54";
const ACCENT = "#3E8E8E";
const PAPER = "#F7F7F4";

/** The mark: a filled effect curve on a rounded tile. */
function iconSvg(size) {
  const s = size;
  const r = s * 0.22;              // corner radius
  const stroke = Math.max(1.5, s * 0.085);
  // Curve control points in a 100x100 space, then scaled.
  const p = (x, y) => `${(x / 100) * s},${(y / 100) * s}`;
  // Asymmetric on purpose: a quick rise, an early peak, and a long decay. A
  // symmetric hump reads as a lambda or a bell and says nothing about the app —
  // the lopsidedness IS the subject.
  const curve =
    `M ${p(10, 80)} ` +
    `C ${p(20, 80)} ${p(24, 22)} ${p(38, 21)} ` +   // rise to an early peak
    `C ${p(52, 20)} ${p(54, 56)} ${p(66, 66)} ` +   // fall away from it
    `C ${p(76, 74)} ${p(82, 77)} ${p(91, 78)}`;     // long tail to baseline
  const area = `${curve} L ${p(91, 84)} L ${p(10, 84)} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <rect width="${s}" height="${s}" rx="${r}" ry="${r}" fill="${TEAL}"/>
    <path d="${area}" fill="${PAPER}" fill-opacity="0.18"/>
    <path d="${curve}" fill="none" stroke="${PAPER}" stroke-width="${stroke}"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function promoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
    <rect width="440" height="280" fill="${PAPER}"/>
    <g transform="translate(36,44)">
      <rect width="52" height="52" rx="12" fill="${TEAL}"/>
      <path d="M 6,41 C 11,41 13,11 20,11 C 27,11 28,29 34,34 C 39,38 42,40 47,40"
            fill="none" stroke="${PAPER}" stroke-width="4.5"
            stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <text x="104" y="72" font-family="Inter,Helvetica,Arial,sans-serif" font-size="30"
          font-weight="700" fill="${INK}">Effect Curve</text>
    <text x="104" y="98" font-family="Inter,Helvetica,Arial,sans-serif" font-size="15"
          fill="#6A7078">Felt effect over time</text>
    <path d="M 36,216 C 72,216 82,130 124,126 C 168,122 180,186 232,202 C 288,219 348,214 404,213"
          fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round"/>
    <path d="M 36,216 C 72,216 82,130 124,126 C 168,122 180,186 232,202 C 288,219 348,214 404,213 L 404,232 L 36,232 Z"
          fill="${ACCENT}" fill-opacity="0.13"/>
    <line x1="36" y1="232" x2="404" y2="232" stroke="#E4E5E1" stroke-width="1.5"/>
  </svg>`;
}

// ---- tiny static server so the screenshot uses the real app ---------------- //
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
function serve(dir, port) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(req.url.split("?")[0]);
      const file = join(dir, path === "/" ? "index.html" : path);
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

// ---------------------------------------------------------------------------- //
await mkdir(join(root, "extension", "icons"), { recursive: true });
await mkdir(join(root, "store"), { recursive: true });

const browser = await chromium.launch();

async function renderSvg(svg, width, height, out) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;background:transparent">${svg}</body>`,
    { waitUntil: "load" },
  );
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
  console.log("  " + out.replace(root + "\\", "").replace(root + "/", ""));
}

console.log("icons:");
for (const size of [16, 48, 128]) {
  await renderSvg(iconSvg(size), size, size, join(root, "extension", "icons", `icon${size}.png`));
}
await renderSvg(iconSvg(128), 128, 128, join(root, "store", "icon-128.png"));

console.log("promo tile:");
await renderSvg(promoSvg(), 440, 280, join(root, "store", "promo-440x280.png"));

console.log("screenshot:");
const server = await serve(join(root, "frontend"), 8199);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:8199/", { waitUntil: "networkidle" });
await page.fill(".searchbar__input", "methylphenidate");
await page.waitForTimeout(1800);
const opt = await page.$(".searchbar__option");
if (opt) { await opt.click(); await page.waitForTimeout(2000); }
await page.screenshot({ path: join(root, "store", "screenshot-1280x800.png") });
console.log("  store/screenshot-1280x800.png");

await page.close();
server.close();
await browser.close();

console.log("\nWeb Store needs: the 128 icon, at least one 1280x800 screenshot. Promo tile is optional.");
