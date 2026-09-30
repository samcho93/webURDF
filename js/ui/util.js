// util.js — small DOM helpers shared by the UI modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(msg, type = 'info', ms = 3500) {
  const el = h('div', { class: `toast ${type}` }, msg);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// Minimal modal dialog. `build(form, close)` fills the form; returns a promise
// resolved with the value passed to close().
export function dialog(build) {
  const dlg = document.getElementById('dlg');
  const form = document.getElementById('dlg-form');
  form.innerHTML = '';
  return new Promise((resolve) => {
    let done = false;
    const close = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    dlg.onclose = () => close(undefined);
    form.onsubmit = (e) => e.preventDefault();
    build(form, close);
    dlg.showModal();
    const first = form.querySelector('input,select,textarea,button.primary');
    first?.focus();
  });
}

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

export function num(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return String(v);
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, '') === '-0' ? '0' : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
