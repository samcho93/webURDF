// graph.js — kinematic tree diagram (links = boxes, joints = labeled edges).
import { esc } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const COLORS = { revolute: '#dc2626', continuous: '#ea580c', prismatic: '#16a34a', fixed: '#94a3b8', floating: '#7c3aed', planar: '#7c3aed' };

export class GraphView {
  constructor(el, { onSelect }) {
    this.el = el;
    this.onSelect = onSelect;
    this.view = null;
    this.selected = null;
    let drag = null;
    el.addEventListener('wheel', (e) => {
      if (!this.view) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const px = this.view.x + ((e.clientX - r.left) / r.width) * this.view.w;
      const py = this.view.y + ((e.clientY - r.top) / r.height) * this.view.h;
      this.view.w *= k; this.view.h *= k;
      this.view.x = px - ((e.clientX - r.left) / r.width) * this.view.w;
      this.view.y = py - ((e.clientY - r.top) / r.height) * this.view.h;
      this.applyView();
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, v: { ...this.view }, moved: false }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!drag || !this.view) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.view.x = drag.v.x - (dx / r.width) * this.view.w;
      this.view.y = drag.v.y - (dy / r.height) * this.view.h;
      this.applyView();
    });
    el.addEventListener('pointerup', (e) => {
      const d = drag; drag = null;
      if (d && !d.moved) {
        const node = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.closest?.('.node'))?.closest('.node');
        if (node) this.onSelect(node.dataset.link);
      }
    });
  }

  render(model) {
    this.model = model;
    this.el.innerHTML = '';
    if (!model || !model.links.length) { this.view = null; return; }
    // tidy-ish tree layout: leaves get consecutive rows, parents are centered
    const W = 150, H = 26, GX = 70, GY = 10;
    const pos = new Map();
    let row = 0;
    const seen = new Set();
    const place = (name, depth) => {
      if (seen.has(name)) return pos.get(name)?.y ?? 0;
      seen.add(name);
      const kids = (model.childrenOf.get(name) || []).filter((j) => model.linkMap.has(j.child));
      let y;
      if (!kids.length) y = row++ * (H + GY);
      else {
        const ys = kids.map((j) => place(j.child, depth + 1));
        y = (Math.min(...ys) + Math.max(...ys)) / 2;
      }
      pos.set(name, { x: depth * (W + GX), y });
      return y;
    };
    for (const r of model.roots) { place(r, 0); row++; }
    for (const l of model.links) if (!seen.has(l.name)) { place(l.name, 0); row++; }

    const svg = document.createElementNS(NS, 'svg');
    const g = document.createElementNS(NS, 'g');
    svg.appendChild(g);
    let html = '';
    for (const j of model.joints) {
      const a = pos.get(j.parent), b = pos.get(j.child);
      if (!a || !b) continue;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
      const c = COLORS[j.type] || '#94a3b8';
      html += `<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" style="stroke:${c}"${j.type === 'fixed' ? ' stroke-dasharray="4 3"' : ''}/>`;
      html += `<text class="elabel" x="${x2 - 4}" y="${y2 - 4}" text-anchor="end">${esc(trunc(j.name, 16))}</text>`;
    }
    for (const [name, p] of pos) {
      const sel = name === this.selected ? ' sel' : '';
      html += `<g class="node${sel}" data-link="${esc(name)}" transform="translate(${p.x},${p.y})"><title>${esc(name)}</title>` +
        `<rect width="${W}" height="${H}" rx="6"/><text x="8" y="${H / 2 + 4}">${esc(trunc(name, 19))}</text></g>`;
    }
    g.innerHTML = html;
    this.el.appendChild(svg);
    this.svg = svg;
    const maxX = Math.max(...[...pos.values()].map((p) => p.x)) + W;
    const maxY = Math.max(...[...pos.values()].map((p) => p.y)) + H;
    this.bounds = { x: -20, y: -20, w: maxX + 40, h: maxY + 40 };
    this.view = { ...this.bounds };
    this.applyView();
    this.fit();
  }

  fit() {
    if (!this.bounds) return;
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return; // hidden tab: fit again when shown
    const b = this.bounds;
    // pixels per unit: fit the whole tree, but never enlarge and never shrink
    // below 70 % so labels stay readable (pan to see the rest)
    const k = Math.max(Math.min(r.width / b.w, r.height / b.h, 1), 0.7);
    const w = r.width / k, h = r.height / k;
    const x = w >= b.w ? b.x - (w - b.w) / 2 : b.x;
    const y = h >= b.h ? b.y - (h - b.h) / 2 : b.y;
    this.view = { x, y, w, h };
    this.applyView();
  }
  applyView() {
    if (this.svg && this.view) this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
  }
  select(name) {
    this.selected = name;
    if (!this.svg) return;
    for (const n of this.svg.querySelectorAll('.node')) n.classList.toggle('sel', n.dataset.link === name);
  }
  svgText() {
    if (!this.svg) return '';
    const clone = this.svg.cloneNode(true);
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('viewBox', `${this.bounds.x} ${this.bounds.y} ${this.bounds.w} ${this.bounds.h}`);
    clone.setAttribute('width', this.bounds.w); clone.setAttribute('height', this.bounds.h);
    const style = document.createElementNS(NS, 'style');
    style.textContent = '.node rect{fill:#fff;stroke:#94a3b8}.node text{font:11px monospace;fill:#111}.edge{fill:none;stroke-width:1.4}.elabel{font:9.5px monospace;fill:#64748b}';
    clone.prepend(style);
    return new XMLSerializer().serializeToString(clone);
  }
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
