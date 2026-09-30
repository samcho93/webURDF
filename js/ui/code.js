// code.js — lightweight XML code editor: a textarea over a syntax-highlighted
// <pre>, line numbers, error marker, find / replace and jump-to-element.
import { esc } from './util.js';

const NL = '\n';

const TOKEN = /(<!--[\s\S]*?(?:-->|$))|(<\?[\s\S]*?(?:\?>|$))|(<!\[CDATA\[[\s\S]*?(?:\]\]>|$))|(<\/?)([\w:.-]+)|(\/?>)|([\w:.-]+)(\s*=\s*)("[^"]*"?|'[^']*'?)/g;

function highlight(src) {
  let out = '', last = 0, inTag = false;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src))) {
    if (m.index > last) out += esc(src.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (m[1]) out += `<span class="c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="p">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="c">${esc(m[3])}</span>`;
    else if (m[4]) { inTag = true; out += `<span class="t">${esc(m[4])}${esc(m[5])}</span>`; }
    else if (m[6]) { inTag = false; out += `<span class="t">${esc(m[6])}</span>`; }
    else if (m[7]) {
      if (!inTag) { out += esc(m[0]); continue; }
      const v = esc(m[9]).replace(/(\$\{[^}]*\}|\$\([^)]*\))/g, '<span class="x">$1</span>');
      out += `<span class="a">${esc(m[7])}</span>${esc(m[8])}<span class="v">${v}</span>`;
    }
  }
  out += esc(src.slice(last));
  return out + '\n';
}

export class CodeEditor {
  constructor({ textarea, pre, gutter }) {
    this.ta = textarea; this.pre = pre; this.gutter = gutter;
    this.errorLine = null;
    this.onChange = () => {};
    this.onSave = () => {};
    this.lineCount = 0;
    this.ta.addEventListener('input', () => { this.render(); this.onChange(this.ta.value); });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.keydown(e));
    this.render();
  }

  get value() { return this.ta.value; }
  setValue(v, { keepScroll = true } = {}) {
    if (v === this.ta.value) return;
    const st = this.ta.scrollTop, sl = this.ta.scrollLeft;
    const selStart = this.ta.selectionStart;
    this.ta.value = v;
    if (keepScroll) { this.ta.scrollTop = st; this.ta.scrollLeft = sl; this.ta.setSelectionRange(Math.min(selStart, v.length), Math.min(selStart, v.length)); }
    else { this.ta.scrollTop = 0; }
    this.render();
  }

  render() {
    const v = this.ta.value;
    this.pre.innerHTML = this.markTerm ? this.applyMarks(highlight(v)) : highlight(v);
    const n = v.split('\n').length;
    if (n !== this.lineCount || this.errorDirty) {
      this.lineCount = n;
      this.errorDirty = false;
      let s = '';
      for (let i = 1; i <= n; i++) s += i === this.errorLine ? `<span class="err">${i}</span>\n` : i + '\n';
      this.gutter.innerHTML = s;
    }
    this.syncScroll();
  }

  applyMarks(html) {
    // mark search hits only inside text (not inside tags of the generated html)
    const term = esc(this.markTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(/(>|^)([^<]*)/g, (_, a, text) => a + text.replace(new RegExp(term, 'gi'), (x) => `<span class="mark">${x}</span>`));
  }

  syncScroll() {
    this.pre.scrollTop = this.ta.scrollTop;
    this.pre.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
  }

  setError(line) {
    if (line === this.errorLine) return;
    this.errorLine = line;
    this.errorDirty = true;
    this.render();
  }

  // insert through execCommand so the browser's native undo stack keeps working
  insert(text, s, e) {
    this.ta.setSelectionRange(s, e);
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, s, e, 'end');
      this.ta.dispatchEvent(new Event('input'));
    }
  }

  keydown(e) {
    const ta = this.ta;
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value: v } = ta;
      if (s !== en && v.slice(s, en).includes(NL)) {
        const ls = v.lastIndexOf(NL, s - 1) + 1;
        const block = v.slice(ls, en);
        const out = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        this.insert(out, ls, en);
        ta.setSelectionRange(ls, ls + out.length);
      } else if (!e.shiftKey) {
        this.insert('  ', s, en);
      }
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      // keep indentation
      const { selectionStart: s, value: v } = ta;
      const ls = v.lastIndexOf(NL, s - 1) + 1;
      const before = v.slice(ls, s);
      const indent = /^\s*/.exec(before)[0];
      const opened = /<[\w:.-][^>]*[^/]>\s*$/.test(before) && !/<\//.test(before) && !/<[!?]/.test(before);
      e.preventDefault();
      this.insert(NL + indent + (opened ? '  ' : ''), s, ta.selectionEnd);
    }
  }

  goToLine(line, { select = true } = {}) {
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    const lh = 19.375;
    this.ta.scrollTop = Math.max(0, (line - 4) * lh);
    if (select) { this.ta.focus({ preventScroll: true }); this.ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length); }
    this.syncScroll();
  }

  // Jump to <link name="X"> / <joint name="X">
  reveal(kind, name) {
    const re = new RegExp(`<${kind}\\s[^>]*name\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
    const m = re.exec(this.ta.value);
    if (!m) return false;
    const line = this.ta.value.slice(0, m.index).split('\n').length;
    this.goToLine(line, { select: false });
    return true;
  }

  // ------------------------------------------------------------------ find
  setMark(term) { this.markTerm = term || ''; this.render(); }
  findNext(term, from = this.ta.selectionEnd) {
    if (!term) return -1;
    const v = this.ta.value.toLowerCase(), t = term.toLowerCase();
    let i = v.indexOf(t, from);
    if (i < 0) i = v.indexOf(t);
    if (i >= 0) {
      this.ta.focus();
      this.ta.setSelectionRange(i, i + term.length);
      const line = this.ta.value.slice(0, i).split('\n').length;
      const lh = 19.375;
      const top = (line - 1) * lh;
      if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - 40) this.ta.scrollTop = top - 80;
      this.syncScroll();
    }
    return i;
  }
  count(term) {
    if (!term) return 0;
    const v = this.ta.value.toLowerCase(), t = term.toLowerCase();
    let n = 0, i = -1;
    while ((i = v.indexOf(t, i + 1)) >= 0) n++;
    return n;
  }
  replaceOne(term, rep) {
    const { selectionStart: s, selectionEnd: e, value } = this.ta;
    if (value.slice(s, e).toLowerCase() === term.toLowerCase() && term) {
      this.insert(rep, s, e);
    }
    this.findNext(term);
  }
  replaceAll(term, rep) {
    if (!term) return 0;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const n = this.count(term);
    this.insert(this.ta.value.replace(re, () => rep), 0, this.ta.value.length);
    return n;
  }
}
