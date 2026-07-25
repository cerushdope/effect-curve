// effectChart.js — the signature <canvas> EffectChart for "Effect Curve".
//
// Pure presentation. No data fetching, no color choosing, no DOM outside the
// provided container. The app feeds it a fully-computed `state` (see update()).
//
// Aesthetic: "precise instrument meets lab notebook". Numbers/axes/readouts are
// rendered in a monospace stack; UI text in a grotesque stack. Colors always
// come from the caller (series[].color / doses[].color); the chart never picks.
//
// FROZEN PUBLIC INTERFACE
//   createEffectChart(container, options) -> {
//     update(state), setMode("felt"|"plasma"), destroy()
//   }
//   options = { onScrub(info|null), reducedMotion: boolean }
//
// See the bottom of this file for a commented inline self-test harness.

// --------------------------------------------------------------------------- //
// Design tokens (mirrored from the project brief; the chart owns its own ink). //
// --------------------------------------------------------------------------- //
const TOKENS = {
  paper: '#F7F7F4',
  ink: '#1A1D21',
  muted: '#6A7078',
  hairline: '#E4E5E1',
  accent: '#2E4D54',
};

const FONT_MONO =
  '"IBM Plex Mono", "Roboto Mono", ui-monospace, "SF Mono", Menlo, monospace';
const FONT_UI = 'Inter, "Helvetica Neue", system-ui, sans-serif';

// Plot insets (CSS px). Left gutter holds the y-axis labels; bottom holds the
// x-axis labels plus the dose-marker rail.
const PAD = { top: 18, right: 18, bottom: 46, left: 46 };
const RAIL_H = 14; // height reserved at the very bottom for dose ticks

const ANIM_MS = 600; // draw-on reveal duration

// --------------------------------------------------------------------------- //
// Small helpers.                                                               //
// --------------------------------------------------------------------------- //

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Parse a CSS color (hex or rgb[a]) into {r,g,b} for alpha compositing. */
function parseColor(css) {
  if (typeof css !== 'string') return { r: 46, g: 77, b: 84 };
  const s = css.trim();
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length >= 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      };
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0 };
  }
  return { r: 46, g: 77, b: 84 }; // accent fallback
}

const rgba = (c, a) => `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;

/** Format minutes as wall-clock "HH:MM" given a day-start offset. */
function fmtClock(totalMin) {
  let m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** Format elapsed minutes as "h:mm" (no zero-pad on hours). */
function fmtElapsed(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + ':' + String(mm).padStart(2, '0');
}

/** Multi-day clock label: "D1 08:00", "D2 06:00", … (day from window start). */
function fmtDay(totalMin) {
  const t = Math.max(0, Math.round(totalMin));
  return 'D' + (Math.floor(t / 1440) + 1) + ' ' + fmtClock(t);
}

/**
 * Linear interpolation of a value array sampled at grid_min positions, for an
 * arbitrary time (minutes). Returns null outside the grid or for empty data.
 */
function sampleAt(grid, values, t) {
  const n = grid.length;
  if (!n || !values || values.length !== n) return null;
  if (n === 1) return t === grid[0] ? values[0] : null;
  if (t <= grid[0]) return values[0];
  if (t >= grid[n - 1]) return values[n - 1];
  // grid is monotonic increasing — binary search the bracketing interval.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = grid[hi] - grid[lo] || 1;
  const f = (t - grid[lo]) / span;
  return lerp(values[lo], values[hi], f);
}

// --------------------------------------------------------------------------- //
// The factory.                                                                //
// --------------------------------------------------------------------------- //

/**
 * @param {HTMLElement} container  host element; a <canvas> is created inside it.
 * @param {{onScrub?:(info:object|null)=>void, reducedMotion?:boolean}} options
 * @returns {{update:Function, setMode:Function, destroy:Function}}
 */
export function createEffectChart(container, options = {}) {
  const onScrub = typeof options.onScrub === 'function' ? options.onScrub : null;
  let reducedMotion = !!options.reducedMotion;

  // ----- Canvas setup (HiDPI, fills container, no layout shift) ------------- //
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  // Touch: let us own horizontal scrubbing without the browser panning.
  canvas.style.touchAction = 'none';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Effect over time chart');
  // Keyboard-focusable so the focus ring (quality floor) is reachable.
  canvas.tabIndex = 0;
  canvas.style.outline = 'none';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  // ----- Internal state ----------------------------------------------------- //
  let state = null; // last state passed to update()
  let mode = 'felt'; // "felt" | "plasma"
  let cssW = 0;
  let cssH = 0;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  let scrub = null; // {x, y} in CSS px while pointer is over the plot, else null
  let focused = false; // keyboard-focus visual ring

  let animFrom = 0; // animation progress [0..1] at start
  let animStart = 0; // performance.now() when current anim began
  let animRAF = 0; // in-flight rAF id (0 = none)
  let reveal = 1; // current reveal fraction [0..1]

  let lastDataKey = null; // change-detection key for draw-on animation

  // Plot rectangle in CSS px, recomputed each render.
  let plot = { x: PAD.left, y: PAD.top, w: 0, h: 0 };

  // ----- Sizing ------------------------------------------------------------- //
  function resizeBackingStore() {
    const rect = container.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width));
    cssH = Math.max(1, Math.round(rect.height));
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    // Reset transform then scale so 1 unit == 1 CSS px for all drawing below.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function computePlot() {
    plot.x = PAD.left;
    plot.y = PAD.top;
    plot.w = Math.max(1, cssW - PAD.left - PAD.right);
    plot.h = Math.max(1, cssH - PAD.top - PAD.bottom);
  }

  // ----- Coordinate maps ---------------------------------------------------- //
  function timeDomain() {
    // Prefer the window bounds; fall back to grid extremes; finally to [0,1].
    if (state && state.window) {
      const a = state.window.start;
      const b = state.window.end_min;
      if (typeof a === 'number' && typeof b === 'number' && b > a) return [a, b];
    }
    const g = state && state.grid_min;
    if (g && g.length) {
      const a = g[0];
      const b = g[g.length - 1];
      if (b > a) return [a, b];
      return [a, a + 1]; // single grid point: give it a sliver of width
    }
    return [0, 1];
  }

  let curYMax = 100; // recomputed each render; the plasma axis auto-scales to data

  function niceCeil(x) {
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const t = Math.max(x, 1e-6) * 1.08; // ~8% headroom so the peak isn't glued to the top
    const pow = Math.pow(10, Math.floor(Math.log10(t)));
    const n = t / pow;
    let nice = 10;
    for (const s of steps) if (s >= n) { nice = s; break; }
    return nice * pow;
  }

  // Felt is always 0..100 (Emax-saturated). Plasma is linear/unbounded, so the
  // axis grows to fit the tallest visible curve instead of clipping it flat.
  function computeYMax() {
    if (mode !== 'plasma') return 100;
    let m = 0;
    if (state && state.series) {
      for (const s of state.series) {
        if (s.muted) continue;
        const v = s.concentration;
        if (v) for (const x of v) if (x > m) m = x;
      }
    }
    return niceCeil(m > 0 ? m : 1);
  }

  function tToX(t, dom) {
    const [a, b] = dom;
    return plot.x + ((t - a) / (b - a)) * plot.w;
  }
  function xToT(px, dom) {
    const [a, b] = dom;
    return a + ((px - plot.x) / plot.w) * (b - a);
  }
  function vToY(v) {
    return plot.y + plot.h * (1 - clamp(v, 0, curYMax) / curYMax);
  }

  function seriesValues(s) {
    return mode === 'plasma' ? s.concentration : s.felt_effect;
  }

  // --------------------------------------------------------------------------- //
  // Drawing.                                                                    //
  // --------------------------------------------------------------------------- //

  function clearAll() {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = TOKENS.paper;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  /** Y gridlines + numeric labels and the small axis title. */
  function drawYAxis() {
    const max = curYMax;
    const ticks =
      mode === 'plasma'
        ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
        : [0, 25, 50, 75, 100];
    ctx.save();
    ctx.font = '11px ' + FONT_MONO;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tv of ticks) {
      const y = vToY(tv);
      ctx.strokeStyle = TOKENS.hairline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Crisp 1px hairline (align to half pixel).
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(plot.x, yy);
      ctx.lineTo(plot.x + plot.w, yy);
      ctx.stroke();
      ctx.fillStyle = TOKENS.muted;
      const label =
        mode === 'plasma' ? (max >= 10 ? tv.toFixed(0) : tv.toFixed(2)) : String(tv);
      ctx.fillText(label, plot.x - 8, y);
    }
    // Axis title — rotated, lab-notebook style.
    ctx.translate(12, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.font = '10px ' + FONT_UI;
    ctx.fillStyle = TOKENS.muted;
    ctx.fillText(
      mode === 'plasma' ? 'blood level' : 'felt effect',
      0,
      0
    );
    ctx.restore();
  }

  /** X gridlines + time tick labels (wall-clock or elapsed). */
  function drawXAxis(dom) {
    const [a, b] = dom;
    const spanMin = b - a;
    // Choose a "nice" tick step in minutes that yields ~6-9 ticks.
    const targetTicks = clamp(Math.round(plot.w / 90), 4, 10);
    const rawStep = spanMin / targetTicks;
    const niceSteps = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 4320];
    let step = niceSteps[niceSteps.length - 1];
    for (const s of niceSteps) {
      if (s >= rawStep) {
        step = s;
        break;
      }
    }
    const wallClock = state && typeof state.dayStartMin === 'number';
    const day0 = wallClock ? state.dayStartMin : 0;
    const multiday = b - a > 1440; // disambiguate days when the span exceeds 24h

    ctx.save();
    ctx.font = '11px ' + FONT_MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const railTop = plot.y + plot.h;
    const first = Math.ceil(a / step) * step;
    for (let t = first; t <= b + 0.5; t += step) {
      const x = tToX(t, dom);
      ctx.strokeStyle = TOKENS.hairline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const xx = Math.round(x) + 0.5;
      ctx.moveTo(xx, plot.y);
      ctx.lineTo(xx, railTop);
      ctx.stroke();
      ctx.fillStyle = TOKENS.muted;
      const label = wallClock
        ? (multiday ? fmtDay(day0 + t) : fmtClock(day0 + t))
        : fmtElapsed(t - a);
      ctx.fillText(label, x, railTop + RAIL_H + 4);
    }
    // X axis title.
    ctx.textAlign = 'right';
    ctx.font = '10px ' + FONT_UI;
    ctx.fillStyle = TOKENS.muted;
    ctx.fillText(
      wallClock ? 'time' : 'elapsed (h:mm)',
      plot.x + plot.w,
      plot.y + plot.h + RAIL_H + 22
    );
    ctx.restore();
  }

  /**
   * Build a smoothed path for a series using Catmull-Rom -> cubic Bézier.
   * `revealX` clips the curve to a left-to-right reveal during animation.
   * Returns the array of plotted points (for the threshold band fill).
   */
  function buildCurvePoints(grid, values, dom) {
    const pts = [];
    const n = grid.length;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v == null || Number.isNaN(v)) continue;
      pts.push({ x: tToX(grid[i], dom), y: vToY(v) });
    }
    return pts;
  }

  function strokeSmooth(pts) {
    const n = pts.length;
    if (n === 0) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (n === 1) {
      // A single point: draw a small dot so it is visible.
      ctx.arc(pts[0].x, pts[0].y, 1.5, 0, Math.PI * 2);
      return;
    }
    if (n === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
      return;
    }
    // Catmull-Rom through points, converted to cubic Bézier control points.
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  function drawSeries(dom) {
    if (!state || !state.series) return;
    const revealRight = plot.x + plot.w * reveal;

    for (const s of state.series) {
      const vals = seriesValues(s);
      if (!vals || !vals.length) continue;
      const muted = !!s.muted;
      const pts = buildCurvePoints(state.grid_min, vals, dom);
      if (!pts.length) continue;

      const color = parseColor(s.color);
      const baseY = plot.y + plot.h; // y == 0 line

      // Clip to the reveal region (left-to-right draw-on).
      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.x - 1, plot.y - 2, Math.max(0, revealRight - plot.x) + 1, plot.h + 4);
      ctx.clip();

      // --- Faint threshold band / felt area beneath the curve ---------------- //
      // The whole sub-curve area is filled at very low alpha; the portion that
      // is at/above the PD threshold (mapped onto the 0..max axis) is filled a
      // touch stronger to read as the "felt region".
      const areaAlpha = muted ? 0.04 : 0.1;
      strokeSmooth(pts);
      ctx.lineTo(pts[pts.length - 1].x, baseY);
      ctx.lineTo(pts[0].x, baseY);
      ctx.closePath();
      ctx.fillStyle = rgba(color, areaAlpha);
      ctx.fill();

      // Threshold guide line (where the felt region begins). In felt mode the
      // threshold fraction maps to the EC/threshold position on the 0..100 axis
      // only loosely; we draw it as a faint dashed baseline marker at the
      // series' threshold * max so the "felt region" has a visible floor.
      if (!muted && typeof s.threshold === 'number' && s.threshold > 0) {
        // threshold is a fraction of ref-peak: in plasma it's a concentration
        // level directly; in felt mode show it loosely as that fraction of 100.
        const thLevel = mode === 'plasma' ? s.threshold : s.threshold * 100;
        const thY = vToY(thLevel);
        ctx.save();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = rgba(color, 0.25);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plot.x, Math.round(thY) + 0.5);
        ctx.lineTo(plot.x + plot.w, Math.round(thY) + 0.5);
        ctx.stroke();
        ctx.restore();
      }

      // --- The curve line ---------------------------------------------------- //
      strokeSmooth(pts);
      ctx.lineWidth = muted ? 1 : 2;
      ctx.strokeStyle = muted ? rgba(color, 0.35) : rgba(color, 1);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // breaks_superposition (saturable): dash the line to flag the caveat.
      if (s.breaks_superposition) ctx.setLineDash([7, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.restore();
    }
  }

  /** Bottom rail with a colored tick at each dose time. */
  function drawDoseRail(dom) {
    if (!state || !state.doses || !state.doses.length) return;
    const railY = plot.y + plot.h;
    ctx.save();
    for (const d of state.doses) {
      if (typeof d.time_min !== 'number') continue;
      const x = tToX(d.time_min, dom);
      if (x < plot.x - 1 || x > plot.x + plot.w + 1) continue;
      const c = parseColor(d.color);
      ctx.strokeStyle = rgba(c, 0.9);
      ctx.lineWidth = 2;
      ctx.beginPath();
      const xx = Math.round(x) + 0.5;
      ctx.moveTo(xx, railY + 2);
      ctx.lineTo(xx, railY + RAIL_H);
      ctx.stroke();
      // A small filled cap so single doses read as a marker, not a hairline.
      ctx.fillStyle = rgba(c, 0.9);
      ctx.beginPath();
      ctx.arc(x, railY + 2, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Distinct solid accent line + cap at now_min. */
  function drawNow(dom) {
    if (!state || state.now_min == null) return;
    const [a, b] = dom;
    if (state.now_min < a || state.now_min > b) return;
    const x = tToX(state.now_min, dom);
    ctx.save();
    ctx.strokeStyle = TOKENS.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const xx = Math.round(x) + 0.5;
    ctx.moveTo(xx, plot.y);
    ctx.lineTo(xx, plot.y + plot.h);
    ctx.stroke();
    // "now" flag at the top.
    ctx.fillStyle = TOKENS.accent;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x - 4, plot.y - 6);
    ctx.lineTo(x + 4, plot.y - 6);
    ctx.closePath();
    ctx.fill();
    ctx.font = '9px ' + FONT_MONO;
    ctx.fillStyle = TOKENS.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('now', x, plot.y - 7);
    ctx.restore();
  }

  /**
   * Compute the scrub readout values at a given time, for non-muted series.
   * Returns { time_min, values:[{substance_id,name,color,value}] }.
   */
  function readoutAt(t) {
    const values = [];
    if (state && state.series) {
      for (const s of state.series) {
        if (s.muted) continue;
        const v = sampleAt(state.grid_min, seriesValues(s), t);
        if (v == null) continue;
        values.push({
          substance_id: s.substance_id,
          name: s.name,
          color: s.color,
          value: v,
        });
      }
    }
    return { time_min: t, values };
  }

  /** Dashed vertical scrub line + floating readout panel near the cursor. */
  function drawScrub(dom) {
    if (!scrub) return;
    const [a, b] = dom;
    const t = clamp(xToT(scrub.x, dom), a, b);
    const x = tToX(t, dom);

    // Scrub line (dashed, distinct from the solid "now" line).
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = rgba(parseColor(TOKENS.ink), 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const xx = Math.round(x) + 0.5;
    ctx.moveTo(xx, plot.y);
    ctx.lineTo(xx, plot.y + plot.h);
    ctx.stroke();
    ctx.setLineDash([]);

    const info = readoutAt(t);

    // Dots on each curve at the scrub time.
    for (const v of info.values) {
      const s = state.series.find((q) => q.substance_id === v.substance_id);
      if (!s) continue;
      const y = vToY(v.value);
      const c = parseColor(v.color);
      ctx.fillStyle = rgba(c, 1);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = TOKENS.paper;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // --- Floating readout panel ------------------------------------------- //
    const wallClock = state && typeof state.dayStartMin === 'number';
    const header = wallClock
      ? (b - a > 1440 ? fmtDay(state.dayStartMin + t) : fmtClock(state.dayStartMin + t))
      : fmtElapsed(t - a);

    const rows = info.values;
    const padP = 8;
    const lineH = 16;
    const swatch = 9;
    ctx.font = '11px ' + FONT_MONO;
    // Width = max of header and each "name  value" row.
    let maxW = ctx.measureText(header).width;
    for (const r of rows) {
      const txt = `${r.name}  ${fmtVal(r.value)}`;
      const w = swatch + 6 + ctx.measureText(txt).width;
      if (w > maxW) maxW = w;
    }
    const panelW = maxW + padP * 2;
    const panelH = padP * 2 + lineH * (rows.length + 1);

    // Keep the panel inside the plot bounds; flip side near the right edge.
    let px = x + 12;
    if (px + panelW > plot.x + plot.w) px = x - 12 - panelW;
    px = clamp(px, plot.x, plot.x + plot.w - panelW);
    let py = clamp(scrub.y - panelH / 2, plot.y, plot.y + plot.h - panelH);

    // Panel background (paper with a hairline border + soft shadow).
    ctx.shadowColor = 'rgba(26,29,33,0.12)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = TOKENS.paper;
    roundRect(px, py, panelW, panelH, 6);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = TOKENS.hairline;
    ctx.lineWidth = 1;
    roundRect(px, py, panelW, panelH, 6);
    ctx.stroke();

    // Header (time).
    ctx.fillStyle = TOKENS.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '11px ' + FONT_MONO;
    let ty = py + padP + lineH / 2;
    ctx.fillText(header, px + padP, ty);
    ty += lineH;

    // Rows: swatch + name + mono value.
    for (const r of rows) {
      const c = parseColor(r.color);
      ctx.fillStyle = rgba(c, 1);
      ctx.fillRect(px + padP, ty - swatch / 2, swatch, swatch);
      ctx.fillStyle = TOKENS.ink;
      ctx.fillText(`${r.name}  ${fmtVal(r.value)}`, px + padP + swatch + 6, ty);
      ty += lineH;
    }
    ctx.restore();
  }

  function fmtVal(v) {
    return mode === 'plasma' ? v.toFixed(3) : v.toFixed(0);
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Visible keyboard focus ring (quality floor). */
  function drawFocusRing() {
    if (!focused) return;
    ctx.save();
    ctx.strokeStyle = TOKENS.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    roundRect(1, 1, cssW - 2, cssH - 2, 4);
    ctx.stroke();
    ctx.restore();
  }

  // ----- Full render -------------------------------------------------------- //
  function render() {
    if (!cssW || !cssH) return;
    computePlot();
    curYMax = computeYMax(); // plasma axis fits the data (no flat-topped clipping)
    clearAll();
    const dom = timeDomain();

    drawYAxis();
    drawXAxis(dom);
    drawSeries(dom);
    drawDoseRail(dom);
    drawNow(dom);
    drawScrub(dom);
    drawFocusRing();
  }

  // ----- Draw-on animation -------------------------------------------------- //
  function animTick(now) {
    const elapsed = now - animStart;
    const t = clamp(elapsed / ANIM_MS, 0, 1);
    reveal = lerp(animFrom, 1, easeOutCubic(t));
    render();
    if (t < 1) {
      animRAF = requestAnimationFrame(animTick);
    } else {
      reveal = 1;
      animRAF = 0;
    }
  }

  function startReveal() {
    cancelAnim();
    if (reducedMotion) {
      reveal = 1;
      render();
      return;
    }
    animFrom = 0;
    reveal = 0;
    animStart = performance.now();
    animRAF = requestAnimationFrame(animTick);
  }

  function cancelAnim() {
    if (animRAF) {
      cancelAnimationFrame(animRAF);
      animRAF = 0;
    }
  }

  // Build a cheap key that changes when the plotted data changes (so we only
  // animate on real data changes, not on resize / scrub re-renders).
  function dataKey(st) {
    if (!st || !st.series) return 'empty';
    const parts = [mode, st.grid_min ? st.grid_min.length : 0];
    for (const s of st.series) {
      const v = mode === 'plasma' ? s.concentration : s.felt_effect;
      const last = v && v.length ? v[v.length - 1] : 0;
      const sum = v && v.length ? v[0] + last + v.length : 0;
      parts.push(s.substance_id, s.muted ? 'm' : '', Math.round(sum * 1000));
    }
    return parts.join('|');
  }

  // ----- Pointer / scrub handling ------------------------------------------- //
  function localPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function inPlot(p) {
    return (
      p.x >= plot.x &&
      p.x <= plot.x + plot.w &&
      p.y >= plot.y - 4 &&
      p.y <= plot.y + plot.h + 4
    );
  }

  function emitScrub() {
    if (!onScrub) return;
    if (!scrub) {
      onScrub(null);
      return;
    }
    const dom = timeDomain();
    const t = clamp(xToT(scrub.x, dom), dom[0], dom[1]);
    onScrub(readoutAt(t));
  }

  function onPointerMove(ev) {
    const p = localPoint(ev);
    if (inPlot(p)) {
      scrub = p;
      render();
      emitScrub();
    } else if (scrub) {
      scrub = null;
      render();
      emitScrub();
    }
  }

  function onPointerDown(ev) {
    const p = localPoint(ev);
    if (inPlot(p)) {
      scrub = p;
      canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId);
      render();
      emitScrub();
    }
  }

  function onPointerUp(ev) {
    if (canvas.releasePointerCapture && ev.pointerId != null) {
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function onPointerLeave() {
    if (scrub) {
      scrub = null;
      render();
      emitScrub();
    }
  }

  // Keyboard scrubbing: arrows move the scrub line one tick; Esc clears it.
  function onKeyDown(ev) {
    const dom = timeDomain();
    const stepPx = plot.w / 60; // ~60 keyboard stops across the plot
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const cur = scrub ? scrub.x : plot.x + plot.w / 2;
      const nx = clamp(
        cur + (ev.key === 'ArrowRight' ? stepPx : -stepPx),
        plot.x,
        plot.x + plot.w
      );
      scrub = { x: nx, y: scrub ? scrub.y : plot.y + plot.h / 2 };
      render();
      emitScrub();
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      if (scrub) {
        scrub = null;
        render();
        emitScrub();
      }
    }
  }

  function onFocus() {
    focused = true;
    render();
  }
  function onBlur() {
    focused = false;
    render();
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointercancel', onPointerLeave);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('focus', onFocus);
  canvas.addEventListener('blur', onBlur);

  // ----- ResizeObserver ----------------------------------------------------- //
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      resizeBackingStore();
      render();
    });
    ro.observe(container);
  } else {
    // Fallback: window resize (older browsers).
    window.addEventListener('resize', onWinResize);
  }
  function onWinResize() {
    resizeBackingStore();
    render();
  }

  // Initial sizing.
  resizeBackingStore();

  // --------------------------------------------------------------------------- //
  // Public API.                                                                 //
  // --------------------------------------------------------------------------- //

  function update(next) {
    state = next || null;
    resizeBackingStore(); // dpr/size may have changed since last update
    const key = dataKey(state);
    const changed = key !== lastDataKey;
    lastDataKey = key;
    if (changed && state && state.series && state.series.length) {
      startReveal();
    } else {
      // No data change (or empty): render final frame immediately.
      reveal = 1;
      render();
    }
  }

  function setMode(next) {
    if (next !== 'felt' && next !== 'plasma') return;
    if (next === mode) return;
    mode = next;
    // A mode switch is a data change visually — animate the reveal.
    lastDataKey = dataKey(state);
    startReveal();
    // Mirror updated values to any active scrub listener.
    emitScrub();
  }

  function destroy() {
    cancelAnim();
    if (ro) ro.disconnect();
    else window.removeEventListener('resize', onWinResize);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointercancel', onPointerLeave);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('focus', onFocus);
    canvas.removeEventListener('blur', onBlur);
    if (canvas.parentNode === container) container.removeChild(canvas);
    state = null;
  }

  // First paint (empty axes until update() is called).
  render();

  return { update, setMode, destroy };
}

// --------------------------------------------------------------------------- //
// Inline self-test harness (commented; copy into a scratch .html to try):     //
// --------------------------------------------------------------------------- //
//
//   <div id="host" style="width:720px;height:360px"></div>
//   <script type="module">
//     import { createEffectChart } from './effectChart.js';
//     const host = document.getElementById('host');
//     const chart = createEffectChart(host, {
//       reducedMotion: false,
//       onScrub: (info) => console.log('scrub', info),
//     });
//     // Synthesize a Bateman-ish curve on a 0..480 min grid (step 5).
//     const grid = []; for (let t = 0; t <= 480; t += 5) grid.push(t);
//     const felt = grid.map((t) => {
//       const a = 1 - Math.exp(-t / 30), e = Math.exp(-t / 180);
//       return Math.max(0, 100 * a * e);
//     });
//     const conc = felt.map((v) => v / 100);
//     chart.update({
//       grid_min: grid,
//       series: [{
//         substance_id: 'simple_direct', name: 'Stimulant (IR)',
//         color: '#2E8B8B', felt_effect: felt, concentration: conc,
//         landmarks: { onset_min: 20, peak_min: 60, peak_value: 78,
//                      offset_min: 360, current_value: 41 },
//         threshold: 0.08, muted: false, breaks_superposition: false,
//         confidence: 'low',
//       }],
//       window: { start: 0, end_min: 480, step_min: 5 },
//       now_min: 215,
//       doses: [{ substance_id: 'simple_direct', color: '#2E8B8B', time_min: 0 }],
//       mode: 'felt',
//     });
//     // chart.setMode('plasma');  // toggle to normalized 0..1
//     // chart.destroy();          // cleanup
//   </script>
//
