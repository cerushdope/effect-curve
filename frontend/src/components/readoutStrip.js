// readoutStrip.js — live per-substance readout under/beside the chart.
//
// Per substance: current level (from scrub, else from now/landmarks), peak time,
// onset, offset, and a confidence indicator. Two update paths:
//   - setSeries(series, mode): from the latest compute landmarks (the resting view)
//   - setScrub(info|null): from chart.onScrub (live cursor values), or null to reset
//
// Numbers are mono. When scrubbing, the "current" cell shows the value at the
// cursor time and the strip header notes the scrub time.

export function createReadoutStrip(container) {
  container.innerHTML = "";
  container.classList.add("readout");
  container.setAttribute("aria-live", "polite");

  const head = document.createElement("div");
  head.className = "readout__head";
  const headLabel = document.createElement("span");
  headLabel.className = "readout__headlabel";
  headLabel.textContent = "Readout";
  const headTime = document.createElement("span");
  headTime.className = "readout__time mono";
  headTime.textContent = "peak";
  head.append(headLabel, headTime);

  const list = document.createElement("div");
  list.className = "readout__list";

  container.append(head, list);

  /** @type {import("../api/contract.js").SeriesOut[]} */
  let series = [];
  let mode = "felt";
  // muted ids from app so we can hide them
  let mutedIds = new Set();
  // when the chart spans more than a day, prefix times with the day (D1/D2/…)
  let multiday = false;

  function fmtTime(min) {
    const t = Math.max(0, Math.round(min));
    return multiday ? "D" + (Math.floor(t / 1440) + 1) + " " + toHMM(t) : toHMM(t);
  }

  function valueLabel() {
    return mode === "plasma" ? "level" : "felt";
  }

  function render(scrub) {
    list.innerHTML = "";
    const visible = series.filter((s) => !mutedIds.has(s.substance_id));
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "readout__empty";
      empty.textContent = "No active curve.";
      list.append(empty);
      headTime.textContent = "";
      return;
    }

    // scrub value lookup by substance_id
    const scrubMap = new Map();
    if (scrub && scrub.values) {
      for (const v of scrub.values) scrubMap.set(v.substance_id, v.value);
      headTime.textContent = `at ${fmtTime(scrub.time_min)}`;
    } else {
      headTime.textContent = "peak"; // resting view shows each substance's peak
    }

    for (const s of visible) {
      const lm = s.landmarks || {};
      const row = document.createElement("div");
      row.className = "readout__row";
      const color = colorFor(s.substance_id);
      row.style.setProperty("--row-color", color || "var(--accent)");

      const top = document.createElement("div");
      top.className = "readout__rowtop";
      const dot = document.createElement("span");
      dot.className = "readout__dot";
      const name = document.createElement("span");
      name.className = "readout__name";
      name.textContent = s.name;
      const cur = document.createElement("span");
      cur.className = "readout__cur mono";
      const scrubVal = scrubMap.has(s.substance_id) ? scrubMap.get(s.substance_id) : null;
      // Resting view: the peak of whichever curve is on screen (felt vs plasma).
      const arr = mode === "plasma" ? s.concentration : s.felt_effect;
      const restPeak = arr && arr.length ? Math.max(...arr) : null;
      const curVal = scrubVal != null ? scrubVal : restPeak;
      cur.textContent = fmtVal(curVal, mode);
      top.append(dot, name, cur);

      const stats = document.createElement("dl");
      stats.className = "readout__stats mono";
      addStat(stats, "peak", lm.peak_min != null ? fmtTime(lm.peak_min) : "—");
      addStat(stats, "onset", lm.onset_min != null ? fmtTime(lm.onset_min) : "—");
      addStat(stats, "offset", lm.offset_min != null ? fmtTime(lm.offset_min) : "—");
      // How long it's actually noticeable — the number people mean by "how long
      // does it last", and the one the PD model is now fitted to.
      if (lm.onset_min != null && lm.offset_min != null) {
        addStat(stats, "lasts", fmtDur(lm.offset_min - lm.onset_min));
      }
      if (lm.rebound_min != null) {
        addStat(stats, "crash", `${fmtTime(lm.rebound_min)} (${Math.round(lm.rebound_value)})`);
      }

      const conf = document.createElement("div");
      conf.className = "readout__conf";
      // Say WHAT the one number is. "Sedation" and "anxiety relief" are not the
      // same experience, and a curve labelled only "felt effect" makes the
      // reader supply the answer themselves.
      if (mode !== "plasma" && s.channel && s.felt_kind !== "none") {
        const ch = document.createElement("span");
        ch.className = "readout__channel";
        ch.textContent = s.channel;
        ch.title = "Which single effect this curve tracks. Other effects of the same drug follow different time courses.";
        conf.append(ch);
      }
      if (s.tolerance_mult && s.tolerance_mult !== 1) {
        const tol = document.createElement("span");
        tol.className = "readout__warn";
        tol.textContent = s.tolerance_mult > 1 ? `tolerance ×${s.tolerance_mult.toFixed(1)}` : "no tolerance";
        conf.append(tol);
      }
      const cspan = document.createElement("span");
      cspan.className = `readout__confbadge readout__confbadge--${s.confidence || "low"}`;
      cspan.textContent = s.pd_fitted ? "fitted to published onset & duration" : `confidence: ${s.confidence || "low"}`;
      cspan.title = s.pd_fitted
        ? "The felt-effect shape is solved so this drug's onset and duration match published figures, rather than assigned from its class. Still an illustration, not a clinical tool."
        : "How well population data supports this curve's shape — not a measure of accuracy for you specifically.";
      conf.append(cspan);
      if (s.pk_short) {
        const w = document.createElement("span");
        w.className = "readout__warn";
        w.textContent = "PK shorter than reported duration";
        w.title = "The blood-level curve we were given fades before the drug is reported to stop working, so the felt duration here is the shorter of the two.";
        conf.append(w);
      }
      if (s.breaks_superposition) {
        const warn = document.createElement("span");
        warn.className = "readout__warn";
        warn.textContent = "saturable — doses not additive";
        conf.append(warn);
      }

      row.append(top, stats, conf);
      list.append(row);
    }
  }

  // app injects a color resolver (id -> css color)
  let colorResolver = () => null;
  function colorFor(id) { return colorResolver(id); }

  return {
    setColorResolver(fn) { colorResolver = fn; },
    setWindow(win) { multiday = !!(win && win.end_min - win.start > 1440); },
    setMutedIds(ids) { mutedIds = new Set(ids); render(null); },
    setSeries(nextSeries, nextMode) {
      series = nextSeries || [];
      if (nextMode) mode = nextMode;
      render(null);
    },
    setScrub(info) { render(info); },
    destroy() { container.innerHTML = ""; },
  };
}

function addStat(dl, term, value) {
  // Each label+value is one inline unit so it wraps together (never splits or
  // overflows into the neighbouring readout box on narrow/scaled screens).
  const wrap = document.createElement("div");
  wrap.className = "readout__stat";
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  wrap.append(dt, dd);
  dl.append(wrap);
}

function fmtVal(v, mode) {
  if (v == null || isNaN(v)) return "—";
  if (mode === "plasma") return v.toFixed(2);
  return `${Math.round(v)}`;
}

function fmtDur(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 90) return `${m}m`;
  const h = m / 60;
  return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
}

function toHMM(min) {
  const m = (((Math.round(min) % 1440) + 1440) % 1440); // wrap to clock time
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
