// doseRows.js — the add/remove dose rows shown under a substance card.
//
// Any number of rows, across any number of substances. Amount is in the
// substance's unit; time is integer minutes from window start, rendered as a
// h:mm helper. Inputs use the mono font.

/**
 * @param {HTMLElement} container
 * @param {import("../state.js").ActiveSubstance} substance
 * @param {any} store
 * @param {{stepMin:number}} opts
 */
export function renderDoseRows(container, substance, store, opts = { stepMin: 5 }) {
  container.innerHTML = "";
  container.classList.add("doserows");

  const headerRow = document.createElement("div");
  headerRow.className = "doserows__head";
  const c1 = document.createElement("span");
  c1.textContent = `Dose (${substance.unit})`;
  const c2 = document.createElement("span");
  c2.textContent = "Time";
  const c3 = document.createElement("span");
  c3.textContent = "";
  headerRow.append(c1, c2, c3);
  container.append(headerRow);

  const route = substance.facts?.routes?.[0] || null;
  const range = route?.dose_range || null;

  substance.doses.forEach((row) => {
    const r = document.createElement("div");
    r.className = "doserows__row";

    // amount input
    const amt = document.createElement("input");
    amt.type = "number";
    amt.className = "doserows__amt mono";
    amt.value = String(row.dose_mg);
    amt.min = "0";
    amt.step = range ? String(Math.max(0.1, Math.round(range.typical / 10 * 10) / 10)) : "1";
    amt.setAttribute("aria-label", `Dose for ${substance.name} in ${substance.unit}`);
    if (range) amt.title = `typical ${range.typical} ${substance.unit} (range ${range.min}–${range.max})`;
    amt.addEventListener("change", () => {
      const v = parseFloat(amt.value);
      store.updateDose(substance.id, row.id, { dose_mg: isNaN(v) ? 0 : Math.max(0, v) });
    });

    // time input — clock time (HH:MM), stored internally as minutes-from-midnight
    const timeWrap = document.createElement("div");
    timeWrap.className = "doserows__timewrap";
    const time = document.createElement("input");
    time.type = "time";
    time.className = "doserows__time mono";
    time.value = minToHHMM(row.time_min);
    time.step = "300"; // 5-minute increments
    time.setAttribute("aria-label", `Clock time of this ${substance.name} dose`);
    time.addEventListener("change", () => {
      const v = hhmmToMin(time.value);
      store.updateDose(substance.id, row.id, { time_min: v == null ? row.time_min : v });
    });
    timeWrap.append(time);

    // remove
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "doserows__rm icon-btn";
    rm.setAttribute("aria-label", `Remove this dose of ${substance.name}`);
    rm.textContent = "×";
    rm.disabled = substance.doses.length <= 1;
    rm.addEventListener("click", () => store.removeDose(substance.id, row.id));

    r.append(amt, timeWrap, rm);
    container.append(r);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "doserows__add";
  add.textContent = "+ Add dose";
  add.addEventListener("click", () => {
    // default the new dose to typical amount, stepped 4h after the last dose.
    const last = substance.doses[substance.doses.length - 1];
    const nextTime = last ? last.time_min + 240 : 0;
    const dose = range?.typical ?? route?.dose_ref ?? (last ? last.dose_mg : 0);
    store.addDose(substance.id, { dose_mg: dose, time_min: nextTime });
  });
  container.append(add);
}

function minToHHMM(min) {
  const m = (((Math.round(min) % 1440) + 1440) % 1440);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function hhmmToMin(s) {
  if (!s) return null;
  const parts = String(s).split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
