// Turns the HUD model (ui/inventory.js) into HTML. Browser-only (uses sprite icons).
import { iconURL } from "../render/sprites.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const bar = (frac, cls = "") => `<div class="bar ${cls}"><div style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%"></div></div>`;
const MIN_SLOTS = 5; // empty slots make it read as a hotbar

export function hudHtml(model, { title, hint }) {
  let h = "";
  if (model.speech?.incoming) {
    const p = model.speech.incoming;
    h += `<div class="prompt">human#${p.from} wants to ${esc(p.kind)} — <kbd>Y</kbd> accept &nbsp; <kbd>N</kbd> decline <span class="left">(${p.left}t)</span></div>`;
  }
  if (hint) h += `<div class="hint">${esc(hint)}</div>`;
  if (model.speech?.outgoing) h += `<div class="hint">waiting for an answer... <span class="left">(${model.speech.outgoing.left}t)</span></div>`;
  if (model.actions.length) {
    h += '<div class="actions">';
    for (const a of model.actions) {
      const tip = a.enabled ? a.label : a.why;
      h += `<span class="act ${a.enabled ? "on" : "off"}" title="${esc(tip)}"><kbd>${a.key}</kbd>${esc(a.label)}${a.hold ? "<i>hold</i>" : ""}</span>`;
    }
    h += "</div>";
  }
  h += '<div class="main">';
  const f = model.food;
  h += `<div class="card food ${f.level}"><div class="who">${esc(title)} <span class="age">age ${model.age.text}${model.age.adult ? "" : " · child"}</span></div><div>Food ${f.value} / ${f.max}${f.level === "critical" ? " · starving!" : ""}</div>${bar(f.frac, f.level)}</div>`;
  h += '<div class="slots">';
  for (const s of model.slots) {
    const tip = `${s.name}${s.count > 1 ? " ×" + s.count : ""} — ${s.detail}`;
    h += `<div class="slot ${s.progress ? "work" : ""}" title="${esc(tip)}"><img src="${iconURL(s.kind)}" alt="">` +
      (s.count > 1 ? `<span class="count">${s.count}</span>` : "") +
      (s.frac != null ? `<div class="pbar ${s.kind}"><div style="width:${Math.round(s.frac * 100)}%"></div></div>` : "") +
      `<span class="cap">${esc(s.name)}</span></div>`;
  }
  for (let i = model.slots.length; i < MIN_SLOTS; i++) h += '<div class="slot empty"></div>';
  h += "</div>";
  if (model.fire) {
    const fi = model.fire;
    h += `<div class="card fire ${fi.lit ? "lit" : ""}" title="${esc(fi.detail)}"><img src="${iconURL("fire")}" alt=""><div><div>Fire · ${esc(fi.text)}</div>${bar(fi.frac, fi.lit ? "burn" : "build")}</div></div>`;
  }
  return h + "</div>";
}

// Only touch the DOM when the HTML changed (the HUD is refreshed every frame).
export function renderHud(el, html) {
  if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
}
