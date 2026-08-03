// render.mjs — build every Chrome Web Store asset.
//
//   node store-assets/render.mjs
//
// Same shape as the deja-vu store-assets folder: one standalone HTML per asset
// at exact pixel dimensions, rendered to out/, with a -24 copy flattened onto
// white because some Web Store slots reject an alpha channel.
//
// The one difference: the curves in these images are not drawn by hand. They
// are computed by the shipping engine from the live database and injected as
// SVG paths, so a marketing image cannot claim a shape the product doesn't
// produce. If the model changes, re-run this and the screenshots change with it.

import { chromium } from "playwright";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeSeries, applyPkFix, DEFAULT_CONDITIONS } from "../frontend/src/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const SUPABASE = "https://qzjvwxuwghegkfxmmseh.supabase.co";
const KEY = "sb_publishable_SVnNGLJnxTy2-nz0nOYDMw_9sgAg6UH";

// ---- real curves from the real engine -------------------------------------- //
async function record(id) {
  const res = await fetch(`${SUPABASE}/rest/v1/substances?id=eq.${id}&select=record`, { headers: { apikey: KEY } });
  const rows = await res.json();
  if (!rows.length) throw new Error(`no record for ${id}`);
  return applyPkFix(rows[0].record);
}

const DOSE_AT = 480;
function run(facts, routeId, { hours = 14, conditions = {}, dose } = {}) {
  const route = facts.routes.find((r) => r.id === routeId) || facts.routes[0];
  const sub = {
    id: facts.id, name: facts.name, facts, routeId: route.id, color: "#2E8B8B", muted: false,
    conditions: { ...DEFAULT_CONDITIONS, ...conditions },
    doses: [{ id: "d1", dose_mg: dose ?? route.dose_ref, time_min: DOSE_AT }],
  };
  const win = { start: 360, end_min: 360 + hours * 60, step_min: 5 };
  const { grid_min, series } = computeSeries([sub], win);
  return { grid: grid_min, s: series[0], win };
}

/** Map a series onto an SVG path inside a w x h box, given a fixed value range. */
function path(grid, values, win, w, h, lo, hi, { close = false } = {}) {
  const x = (t) => ((t - win.start) / (win.end_min - win.start)) * w;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  let d = "";
  for (let i = 0; i < grid.length; i++) {
    d += (i ? " L " : "M ") + x(grid[i]).toFixed(1) + "," + y(values[i]).toFixed(1);
  }
  if (close) d += ` L ${w},${y(lo).toFixed(1)} L 0,${y(lo).toFixed(1)} Z`;
  return d;
}

console.log("computing curves from the live engine…");
const [diazepam, mph, dex, levo] = await Promise.all(
  ["diazepam", "methylphenidate", "dextroamphetamine", "levothyroxine"].map(record),
);

// 1. felt vs blood — the whole thesis, in one drug
const dz = run(diazepam, "oral_IR", { hours: 26 });
const dzPeakC = Math.max(...dz.s.concentration);
// 2. fitted to published duration — Concerta's 12 h
const xr = run(mph, "oral_XR", { hours: 17 });
// 3. the crash
const cr = run(dex, "oral_IR", { hours: 20, conditions: { tolerance: "daily" } });
const crLo = Math.min(...cr.s.felt_effect, 0);
// 4. conditions change the shape
const fasted = run(mph, "oral_IR", { hours: 12 });
const fed = run(mph, "oral_IR", { hours: 12, conditions: { food: "food" } });

const VARS = {
  // shot1: felt (0..100) and blood (0..peak) on one 900x330 box
  DZ_FELT: path(dz.grid, dz.s.felt_effect, dz.win, 900, 330, 0, 100),
  DZ_FELT_AREA: path(dz.grid, dz.s.felt_effect, dz.win, 900, 330, 0, 100, { close: true }),
  DZ_BLOOD: path(dz.grid, dz.s.concentration, dz.win, 900, 330, 0, dzPeakC),
  DZ_LASTS: fmtDur(dz.s.landmarks.offset_min - dz.s.landmarks.onset_min),

  XR_FELT: path(xr.grid, xr.s.felt_effect, xr.win, 820, 300, 0, 100),
  XR_AREA: path(xr.grid, xr.s.felt_effect, xr.win, 820, 300, 0, 100, { close: true }),
  XR_LASTS: fmtDur(xr.s.landmarks.offset_min - xr.s.landmarks.onset_min),
  XR_ONSET: clock(xr.s.landmarks.onset_min),
  XR_PEAK: clock(xr.s.landmarks.peak_min),

  CR_FELT: path(cr.grid, cr.s.felt_effect, cr.win, 820, 300, crLo, 100),
  CR_AREA: path(cr.grid, cr.s.felt_effect, cr.win, 820, 300, crLo, 100, { close: true }),
  CR_ZERO: (300 - ((0 - crLo) / (100 - crLo)) * 300).toFixed(1),
  CR_DEPTH: Math.round(cr.s.landmarks.rebound_value ?? 0),
  CR_AT: clock(cr.s.landmarks.rebound_min),
  // The dip is real but shallow — about 8 points under a peak of 70, which is
  // what the product itself draws. Marking it beats rescaling the axis to make
  // it look bigger than it is.
  CR_X: (((cr.s.landmarks.rebound_min - cr.win.start) / (cr.win.end_min - cr.win.start)) * 820).toFixed(1),
  CR_Y: (300 - (((cr.s.landmarks.rebound_value ?? 0) - crLo) / (100 - crLo)) * 300).toFixed(1),

  FASTED: path(fasted.grid, fasted.s.felt_effect, fasted.win, 760, 260, 0, 100),
  FED: path(fed.grid, fed.s.felt_effect, fed.win, 760, 260, 0, 100),

  // marquee / tile use the Concerta shape, scaled to their boxes
  MQ_CURVE: path(xr.grid, xr.s.felt_effect, xr.win, 520, 190, 0, 100),
  MQ_AREA: path(xr.grid, xr.s.felt_effect, xr.win, 520, 190, 0, 100, { close: true }),
  TILE_CURVE: path(xr.grid, xr.s.felt_effect, xr.win, 360, 96, 0, 100),
  TILE_AREA: path(xr.grid, xr.s.felt_effect, xr.win, 360, 96, 0, 100, { close: true }),
};

function fmtDur(m) { return m == null ? "—" : m < 90 ? `${Math.round(m)} min` : `${+(m / 60).toFixed(1)} h`; }
function clock(m) {
  if (m == null) return "—";
  const t = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

console.log(`  diazepam felt lasts ${VARS.DZ_LASTS} (blood: days)`);
console.log(`  concerta ${VARS.XR_ONSET} -> ${VARS.XR_PEAK}, lasts ${VARS.XR_LASTS}`);
console.log(`  crash ${VARS.CR_DEPTH} at ${VARS.CR_AT}`);

// ---- render ----------------------------------------------------------------- //
const SIZES = {
  "icon.html": [128, 128],
  "tile-small.html": [440, 280],
  "marquee.html": [1400, 560],
  "shot1.html": [1280, 800],
  "shot2.html": [1280, 800],
  "shot3.html": [1280, 800],
  "shot4.html": [1280, 800],
  "shot5.html": [1280, 800],
};
const NAME = {
  "icon.html": "icon128", "tile-small.html": "tile-small", "marquee.html": "marquee",
  "shot1.html": "screenshot1", "shot2.html": "screenshot2", "shot3.html": "screenshot3",
  "shot4.html": "screenshot4", "shot5.html": "screenshot5",
};

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const css = await readFile(join(here, "style.css"), "utf8");

console.log("rendering:");
for (const [file, [w, h]] of Object.entries(SIZES)) {
  let html = await readFile(join(here, file), "utf8");
  html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in VARS ? VARS[k] : m));
  html = html.replace("</head>", `<style>${css}</style></head>`);

  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: join(out, `${NAME[file]}.png`) });

  // Flattened, no alpha — some Web Store slots reject transparency outright.
  await page.addStyleTag({ content: "html{background:#fff}" });
  await page.screenshot({ path: join(out, `${NAME[file]}-24.png`), omitBackground: false });
  await page.close();
  console.log(`  ${NAME[file]}.png  ${w}x${h}`);
}
await browser.close();

// ---- copy the extension icons from the same source -------------------------- //
console.log("\nout/ contains:", (await readdir(out)).join(", "));
console.log("\nUpload: icon128, screenshot1-5 (1280x800), tile-small (440x280), marquee (1400x560).");
console.log("Listing copy is in listing.md; the store description is description.txt.");
