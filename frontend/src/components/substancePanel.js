// substancePanel.js — one colored card per active substance.
//
// Shows: name, tiny PK facts (Tmax, half-life, formulation), a mute toggle,
// a remove button, and the dose rows for the substance.

import { renderDoseRows } from "./doseRows.js";

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

    // compact subtitle: formulation · peak · half-life (deliberately minimal)
    const lm = sub.facts?.landmarks || {};
    const route = sub.facts?.routes?.[0] || null;
    const bits = [];
    if (route?.formulation) bits.push(route.formulation);
    if (lm.tmax_min?.value != null) bits.push(`peaks ~${fmtMin(lm.tmax_min.value)}`);
    if (lm.half_life_min?.value != null) bits.push(`t½ ${fmtMin(lm.half_life_min.value)}`);
    const facts = document.createElement("p");
    facts.className = "card__sub";
    facts.textContent = bits.join(" · ");

    // dose rows
    const dr = document.createElement("div");
    dr.className = "card__doses";

    card.append(head, facts, dr);
    container.append(card);

    renderDoseRows(dr, sub, store, { stepMin: opts.stepMin || 5 });
  }
}

function fmtMin(v) {
  if (v == null) return "—";
  if (v < 90) return `${Math.round(v)} min`;
  const h = v / 60;
  return `${h % 1 === 0 ? h : h.toFixed(1)} h`;
}
