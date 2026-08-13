// substancePanel.js — one colored card per active substance.
//
// Shows: name, tiny PK facts (Tmax, half-life, formulation), a mute toggle,
// a remove button, and the dose rows for the substance.

import { brandLabels } from "../aliasLabels.js";
import { renderDoseRows } from "./doseRows.js";
import { FOOD_LEVELS, TOLERANCE_LEVELS, feltFor, foodAffects } from "../data/felt.js";
import { typicalPeakMin, terminalHalfLifeMin } from "../engine.js";

// The two inputs that move the curve most, after dose and time. They are
// APPLIED BY DEFAULT and shown here as the current answer — the user never has
// to answer a questionnaire before seeing a curve, they just correct the two
// assumptions if they're wrong.
const CHIPS = [
  {
    key: "food",
    levels: FOOD_LEVELS,
    order: ["empty", "food"],
    title: "Food shifts the peak by an hour or more through gastric emptying — it changes the shape of the rise, not just the height.",
  },
  {
    key: "tolerance",
    levels: TOLERANCE_LEVELS,
    order: ["first_time", "occasional", "daily"],
    title: "How often you take it. Regular use shifts the whole dose-response curve — 2-3x for benzodiazepines. On 'daily' the curve also starts below baseline, which is why the first dose restores normal rather than lifting above it.",
  },
];

/**
 * @param {HTMLElement} container
 * @param {any} store
 * @param {{onRemove?:(id:string)=>void, stepMin?:number}} [opts]
 */
export function renderSubstancePanel(container, state, store, opts = {}) {
  container.innerHTML = "";
  container.classList.add("panel");

  if (!state.substances.length) {
    const empty = document.createElement("p");
    empty.className = "panel__empty";
    empty.textContent = "No substances yet. Search above to add one.";
    container.append(empty);
    return;
  }

  for (const sub of state.substances) {
    const card = document.createElement("section");
    card.className = "card" + (sub.muted ? " is-muted" : "");
    card.style.setProperty("--card-color", sub.color);
    card.setAttribute("aria-label", `${sub.name} controls`);

    // header
    const head = document.createElement("header");
    head.className = "card__head";

    const swatch = document.createElement("span");
    swatch.className = "card__swatch";
    swatch.setAttribute("aria-hidden", "true");

    const title = document.createElement("h3");
    title.className = "card__title";
    title.textContent = sub.name;

    const actions = document.createElement("div");
    actions.className = "card__actions";

    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "card__mute icon-btn";
    mute.setAttribute("aria-pressed", String(sub.muted));
    mute.setAttribute("aria-label", `${sub.muted ? "Unmute" : "Mute"} ${sub.name}`);
    mute.textContent = sub.muted ? "Muted" : "Mute";
    mute.addEventListener("click", () => store.toggleMute(sub.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "card__remove icon-btn";
    remove.setAttribute("aria-label", `Remove ${sub.name}`);
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (opts.onRemove) opts.onRemove(sub.id);
      else store.removeSubstance(sub.id);
    });

    actions.append(mute, remove);
    head.append(swatch, title, actions);

    // compact subtitle: formulation · peak · half-life (deliberately minimal).
    // Derived from the same engine that draws the curve — the SELECTED route
    // with PK_FIX applied, and "peaks ~" is the drawn curve's peak, so it
    // agrees with the readout's "peak" instead of quoting raw label Tmax.
    const route = (sub.facts?.routes || []).find((r) => r.id === sub.routeId) || sub.facts?.routes?.[0] || null;
    const bits = [];
    if (route?.formulation) bits.push(route.formulation);
    const peakMin = sub.facts ? typicalPeakMin(sub) : null;
    if (peakMin != null) bits.push(`peaks ~${fmtMin(peakMin)} after dose`);
    const hlMin = sub.facts ? terminalHalfLifeMin(sub) : null;
    if (hlMin != null) bits.push(`half-life ${fmtMin(hlMin)}`);
    const facts = document.createElement("p");
    facts.className = "card__sub";
    facts.textContent = bits.join(" · ");
    facts.title =
      "Peak: when the drawn curve is strongest, counted from when you take it. " +
      "Half-life: how fast the blood level falls by half — the felt effect usually ends sooner.";

    // Brand names. The card titles the generic (one substance, one curve), so
    // without this someone who added "Vyvanse" has no confirmation they got it.
    const { brands } = brandLabels(sub.facts?.aliases, sub.name, "", 6);
    let alsoEl = null;
    if (brands.length) {
      alsoEl = document.createElement("p");
      alsoEl.className = "card__aliases";
      const lead = document.createElement("span");
      lead.className = "card__aliases-lead";
      lead.textContent = "also ";
      alsoEl.append(lead, document.createTextNode(brands.join(" · ")));
      alsoEl.title = `Brand names for ${sub.name}`;
    }

    // dose rows
    const dr = document.createElement("div");
    dr.className = "card__doses";

    const extras = [];
    if (sub.facts) {
      const routeEl = renderRoutePicker(sub, store);
      if (routeEl) extras.push(routeEl);
      extras.push(renderConditions(sub, store));
      const note = renderFeltNote(sub);
      if (note) extras.push(note);
    }

    card.append(head, facts, ...(alsoEl ? [alsoEl] : []), ...extras, dr);
    container.append(card);

    renderDoseRows(dr, sub, store, { stepMin: opts.stepMin || 5 });
  }
}

/** Route selector — only when there's more than one to pick from. */
function renderRoutePicker(sub, store) {
  const routes = sub.facts?.routes || [];
  if (routes.length < 2) return null;
  const wrap = document.createElement("div");
  wrap.className = "chiprow";
  const label = document.createElement("span");
  label.className = "chiprow__label";
  label.textContent = "route";
  const sel = document.createElement("select");
  sel.className = "chip chip--select";
  sel.setAttribute("aria-label", `Route for ${sub.name}`);
  for (const r of routes) {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = r.formulation || r.id;
    if (r.id === sub.routeId) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => store.setRoute(sub.id, sel.value));
  wrap.append(label, sel);
  return wrap;
}

/** The default-on condition chips. Clicking cycles to the next option. */
function renderConditions(sub, store) {
  const wrap = document.createElement("div");
  wrap.className = "chiprow";
  const label = document.createElement("span");
  label.className = "chiprow__label";
  label.textContent = "assuming";
  wrap.append(label);

  const route = (sub.facts?.routes || []).find((r) => r.id === sub.routeId) || sub.facts?.routes?.[0];
  for (const chip of CHIPS) {
    // Don't offer "with food" on a route where food can't matter.
    if (chip.key === "food" && route && !foodAffects(route.id, route.route_type)) continue;

    const cur = (sub.conditions && sub.conditions[chip.key]) || chip.order[0];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (cur !== chip.order[0] ? " is-set" : "");
    btn.textContent = (chip.levels[cur] || {}).label || cur;
    btn.title = chip.title;
    btn.setAttribute("aria-label", `${chip.key}: ${btn.textContent}. Click to change.`);
    btn.addEventListener("click", () => {
      const i = chip.order.indexOf(cur);
      store.setCondition(sub.id, { [chip.key]: chip.order[(i + 1) % chip.order.length] });
    });
    wrap.append(btn);
  }
  return wrap;
}

/** Says what the single curve MEANS, or why we won't draw one. */
function renderFeltNote(sub) {
  const route = (sub.facts?.routes || []).find((r) => r.id === sub.routeId) || sub.facts?.routes?.[0];
  const info = feltFor(sub.facts?.id, route?.id, sub.facts?.category);
  if (info.kind === "none") {
    const p = document.createElement("p");
    p.className = "card__nofelt";
    p.textContent = info.reason;
    return p;
  }
  if (info.kind === "unfitted") {
    const p = document.createElement("p");
    p.className = "card__sub card__sub--dim";
    p.textContent = "Felt-effect shape is a class estimate — no published onset/duration for this one.";
    return p;
  }
  return null;
}

function fmtMin(v) {
  if (v == null) return "—";
  if (v < 90) return `${Math.round(v)} min`;
  const h = v / 60;
  return `${h % 1 === 0 ? h : h.toFixed(1)} h`;
}
