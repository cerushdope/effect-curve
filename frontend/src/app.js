// app.js — wires the store, controls, readout strip and the EffectChart.
//
// The backend only supplies substance PARAMETERS (fetched once when a substance
// is added, cached on the store as `.facts`). All curve math runs HERE, in the
// browser (see engine.js). On any store change we re-render controls and
// (debounced) recompute + redraw locally — no compute round-trip.

import { createStore } from "./state.js";
import { releaseColor } from "./api/contract.js";
import { computeSeries } from "./engine.js";
import { createSearchBar } from "./components/searchBar.js";
import { renderSubstancePanel } from "./components/substancePanel.js";
import { createReadoutStrip } from "./components/readoutStrip.js";
import { createEffectChart } from "/src/components/effectChart.js";

const RECOMPUTE_MS = 250;

// ---- bootstrap mock flag from ?mock=1 ------------------------------------- //
try {
  const params = new URLSearchParams(location.search);
  if (params.get("mock") === "1") window.EFFECT_CURVE_MOCK = true;
} catch (_) { /* ignore */ }

const reducedMotionMQ = window.matchMedia("(prefers-reduced-motion: reduce)");

// ---- DOM handles ---------------------------------------------------------- //
const els = {
  search: document.getElementById("search-region"),
  panel: document.getElementById("panel-region"),
  chart: document.getElementById("chart-region"),
  readout: document.getElementById("readout-region"),
  toggleFelt: document.getElementById("mode-felt"),
  togglePlasma: document.getElementById("mode-plasma"),
  error: document.getElementById("error-region"),
  empty: document.getElementById("empty-region"),
  status: document.getElementById("compute-status"),
};

const store = createStore();

// ---- chart ---------------------------------------------------------------- //
const readout = createReadoutStrip(els.readout);
readout.setColorResolver((id) => {
  const s = store.getState().substances.find((x) => x.id === id);
  return s ? s.color : null;
});

const chart = createEffectChart(els.chart, {
  reducedMotion: reducedMotionMQ.matches,
  onScrub: (info) => readout.setScrub(info),
});

// ---- error / status helpers ---------------------------------------------- //
function showError(msg) {
  if (!els.error) return;
  if (msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  } else {
    els.error.textContent = "";
    els.error.hidden = true;
  }
}

function setStatus(text) {
  if (els.status) els.status.textContent = text || "";
}

// ---- search + panel ------------------------------------------------------- //
createSearchBar(els.search, store, showError);

function removeSubstance(id) {
  releaseColor(id);
  store.removeSubstance(id);
}

// ---- mode toggle ---------------------------------------------------------- //
function syncModeButtons(mode) {
  const felt = mode === "felt";
  els.toggleFelt.setAttribute("aria-pressed", String(felt));
  els.togglePlasma.setAttribute("aria-pressed", String(!felt));
  els.toggleFelt.classList.toggle("is-active", felt);
  els.togglePlasma.classList.toggle("is-active", !felt);
}
els.toggleFelt.addEventListener("click", () => {
  store.setMode("felt");
  chart.setMode("felt");
});
els.togglePlasma.addEventListener("click", () => {
  store.setMode("plasma");
  chart.setMode("plasma");
});

// ---- window: a human "day" starting at 06:00, auto-fit to the doses -------- //
// We don't show a flat midnight-to-6am dead zone, and we don't squash a short
// onset against a 24h axis. Start at 06:00 (earlier only if a dose is earlier),
// end once effects have faded (last dose + ~1.25x its duration), capped at the
// next 06:00. This gives the onset enough horizontal room to read as a ramp.
const DAY_START = 360;     // 06:00
const DAY = 1440;          // 24h, the span quantum
const MIN_SPAN = 240;      // show at least 4h
const MAX_SPAN = 5 * DAY;  // safety cap (~5 days) for very long-acting drugs
const PROBE_STEP = 20;     // coarse grid used only to find where the curve ends

// Coarsen the grid on long spans so we don't compute thousands of points.
function stepForSpan(span) {
  if (span <= DAY) return 5;
  if (span <= 2 * DAY) return 10;
  return 15;
}

// 06:00, or a touch before the earliest dose.
function windowStartFor(state) {
  let earliest = DAY_START;
  for (const s of state.substances)
    for (const d of s.doses) if (d.time_min < earliest) earliest = d.time_min;
  return Math.floor(Math.min(DAY_START, Math.max(0, earliest - 30)) / 30) * 30;
}

// Last grid minute where any visible felt curve is still meaningfully above
// baseline (>3% of its own peak). This sizes the window from the ACTUAL computed
// curve, not a static landmark, so long-acting drugs don't get clipped.
function activeEndMin(probe) {
  const g = probe.grid_min;
  if (!g.length) return 0;
  let lastIdx = 0;
  for (const s of probe.series) {
    if (s.muted) continue;
    let peak = 0;
    for (const v of s.felt_effect) if (v > peak) peak = v;
    const cut = Math.max(1, 0.03 * peak);
    for (let i = g.length - 1; i > lastIdx; i--) {
      if (s.felt_effect[i] > cut) { lastIdx = i; break; }
    }
  }
  return g[lastIdx];
}

// Probe the curve over a generous range, then size the window: tight fit if it
// fits in a day, otherwise grow in clean 24h steps (24 → 48 → 72 …).
function computeWindow(state) {
  const start = windowStartFor(state);
  const probe = computeSeries(state.substances, {
    start, end_min: start + MAX_SPAN, step_min: PROBE_STEP,
  });
  let span = activeEndMin(probe) + 45 - start;
  if (span <= 0) span = MIN_SPAN;
  if (span > DAY) span = Math.ceil(span / DAY) * DAY;          // 24h steps
  else span = Math.max(MIN_SPAN, Math.ceil(span / 30) * 30);   // tidy short fit
  if (span > MAX_SPAN) span = MAX_SPAN;
  return { start, end_min: start + span, step_min: stepForSpan(span) };
}

// ---- the recompute pipeline (all local; backend is not involved) ---------- //
let recomputeTimer = null;

function recompute(state) {
  const hasDose = state.substances.some((s) => s.doses.length > 0);
  const doses = [];
  for (const s of state.substances) {
    for (const d of s.doses) doses.push({ substance_id: s.id, color: s.color, time_min: d.time_min });
  }

  if (!state.substances.length || !hasDose) {
    const start = windowStartFor(state);
    const window = { start, end_min: start + MIN_SPAN, step_min: 5 };
    readout.setWindow(window);
    chart.update({ grid_min: [], series: [], window, doses: [], mode: state.mode, dayStartMin: 0 });
    readout.setSeries([], state.mode);
    return;
  }

  let result, window;
  try {
    window = computeWindow(state); // probes the curve to size the span
    result = computeSeries(state.substances, window);
    showError(null);
  } catch (e) {
    console.error(e);
    showError("Could not draw the curve — check the substance parameters.");
    return;
  }

  readout.setWindow(window);
  chart.update({
    grid_min: result.grid_min,
    series: result.series,
    window,
    doses,
    mode: state.mode,
    dayStartMin: 0, // window minutes are clock-minutes; label the x-axis as clock time
  });

  readout.setMutedIds(state.substances.filter((s) => s.muted).map((s) => s.id));
  readout.setSeries(result.series.filter((s) => !s.muted), state.mode);
}

function scheduleRecompute(state) {
  if (recomputeTimer) clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => recompute(state), RECOMPUTE_MS);
}

// ---- main subscription ---------------------------------------------------- //
store.subscribe((state) => {
  // immediate UI render
  renderSubstancePanel(els.panel, state, store, { onRemove: removeSubstance, stepMin: state.window.step_min });
  syncModeButtons(state.mode);
  if (els.empty) {
    const hasDose = state.substances.some((s) => s.doses.length > 0);
    els.empty.hidden = state.substances.length > 0 && hasDose;
  }
  // debounced recompute
  scheduleRecompute(state);
});

// reduced-motion live changes
reducedMotionMQ.addEventListener?.("change", () => {
  // re-render forces the chart to pick up the new preference on next update
  scheduleRecompute(store.getState());
});

// initial paint
renderSubstancePanel(els.panel, store.getState(), store, { onRemove: removeSubstance });
syncModeButtons("felt");
if (els.empty) els.empty.hidden = false;
