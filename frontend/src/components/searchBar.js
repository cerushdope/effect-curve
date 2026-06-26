// searchBar.js — accessible autocomplete that adds a substance to the store.
//
// - Debounced search against client.search.
// - Keyboard: ArrowUp/Down to move, Enter to select, Escape to close.
// - On select: fetch the full record (for default dose + unit + route), assign a
//   palette color, and add to the store.

import * as client from "../api/client.js";
import { colorForSubstance } from "../api/contract.js";

const DEBOUNCE_MS = 250;

/**
 * @param {HTMLElement} container
 * @param {import("../state.js").createStore extends (...a:any)=>infer R ? R : any} store
 * @param {(msg:string|null)=>void} [onError]
 */
export function createSearchBar(container, store, onError = () => {}) {
  container.innerHTML = "";
  container.classList.add("searchbar");

  const label = document.createElement("label");
  label.className = "searchbar__label";
  label.setAttribute("for", "substance-search");
  label.textContent = "Add a substance";

  const wrap = document.createElement("div");
  wrap.className = "searchbar__wrap";
  wrap.setAttribute("role", "combobox");
  wrap.setAttribute("aria-expanded", "false");
  wrap.setAttribute("aria-haspopup", "listbox");
  wrap.setAttribute("aria-owns", "substance-listbox");

  const input = document.createElement("input");
  input.id = "substance-search";
  input.type = "text";
  input.className = "searchbar__input mono";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "searchbox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", "substance-listbox");
  input.placeholder = "Search name or alias…";

  const list = document.createElement("ul");
  list.id = "substance-listbox";
  list.className = "searchbar__list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  wrap.append(input, list);
  container.append(label, wrap);

  let results = [];
  let active = -1;
  let debounceTimer = null;
  let reqSeq = 0;

  function close() {
    list.hidden = true;
    list.innerHTML = "";
    results = [];
    active = -1;
    wrap.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function render() {
    list.innerHTML = "";
    if (!results.length) {
      const li = document.createElement("li");
      li.className = "searchbar__empty";
      li.textContent = "No matches";
      li.setAttribute("aria-disabled", "true");
      list.append(li);
      list.hidden = false;
      wrap.setAttribute("aria-expanded", "true");
      return;
    }
    results.forEach((r, i) => {
      const li = document.createElement("li");
      li.className = "searchbar__option" + (i === active ? " is-active" : "");
      li.id = `opt-${r.id}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      const already = store.hasSubstance(r.id);
      if (already) li.classList.add("is-added");

      const name = document.createElement("span");
      name.className = "searchbar__optname";
      name.textContent = r.name;
      const cat = document.createElement("span");
      cat.className = "searchbar__optcat mono";
      cat.textContent = already ? "added" : r.category;
      li.append(name, cat);

      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in input
        choose(i);
      });
      list.append(li);
    });
    list.hidden = false;
    wrap.setAttribute("aria-expanded", "true");
    if (active >= 0 && results[active]) {
      input.setAttribute("aria-activedescendant", `opt-${results[active].id}`);
    }
  }

  async function runSearch(q) {
    const my = ++reqSeq;
    try {
      const res = await client.search(q);
      if (my !== reqSeq) return; // stale
      results = res;
      active = res.length ? 0 : -1;
      onError(null);
      render();
    } catch (e) {
      if (my !== reqSeq) return;
      onError("Search is unavailable — is the backend running? Start it, or enable mock mode.");
      close();
    }
  }

  async function choose(i) {
    const r = results[i];
    if (!r) return;
    if (store.hasSubstance(r.id)) {
      input.value = "";
      close();
      return;
    }
    const color = colorForSubstance(r.id);
    let facts = null, routeId = "", unit = "mg", defaultDose = 0;
    try {
      facts = await client.getSubstance(r.id);
      const route = (facts.routes && facts.routes[0]) || null;
      routeId = route ? route.id : "";
      unit = facts.unit || "mg";
      defaultDose = route?.dose_range?.typical ?? route?.dose_ref ?? 0;
      onError(null);
    } catch (e) {
      onError("Could not load substance details — added with defaults.");
    }
    store.addSubstance({
      id: r.id, name: r.name, category: r.category,
      color, facts, routeId, unit, defaultDose,
    });
    input.value = "";
    close();
    input.focus();
  }

  input.addEventListener("input", () => {
    const q = input.value;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(q), DEBOUNCE_MS);
  });

  input.addEventListener("focus", () => {
    if (!input.value && results.length === 0) runSearch("");
    else if (results.length) render();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.hidden) { runSearch(input.value); return; }
      if (results.length) { active = (active + 1) % results.length; render(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) { active = (active - 1 + results.length) % results.length; render(); }
    } else if (e.key === "Enter") {
      if (!list.hidden && active >= 0) { e.preventDefault(); choose(active); }
    } else if (e.key === "Escape") {
      close();
    }
  });

  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) close();
  });

  return { focus: () => input.focus(), destroy: () => { container.innerHTML = ""; } };
}
