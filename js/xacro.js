// xacro.js — a browser-side xacro processor.
//
// Supports: property (value / block / default / scope), arg + $(arg), include
// (with $(find pkg)), macro (plain, default :=, ^ / ^| inherit, *block, **block),
// insert_block, if / unless, element, attribute, call, ${expr}, $(eval ...),
// $(find), $(env), $(optenv), $(dirname). Expressions are evaluated by a small
// Python-like interpreter — never with eval() — so remote files cannot run code.
import { dirname, join, normalize } from './vfs.js';

export const XACRO_NS = 'http://www.ros.org/wiki/xacro';

export function isXacro(text, path = '') {
  return /\.xacro$/i.test(path) || /xmlns:xacro\s*=/.test(text) || /<xacro:/.test(text);
}

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'in', 'is', 'True', 'False', 'None', 'lambda']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = src.slice(i);
    if ((m = /^(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?/.exec(rest))) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest))) {
      toks.push(KEYWORDS.has(m[0]) ? { t: 'op', v: m[0] } : { t: 'id', v: m[0] });
      i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else s += src[j++]; }
      toks.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if ((m = /^(\*\*|\/\/|==|!=|<=|>=|[-+*/%<>()[\],.:{}])/.exec(rest))) { toks.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
    throw new Error(`수식 해석 불가 문자 '${c}' in "${src}"`);
  }
  return toks;
}

const MATH = {
  pi: Math.PI, e: Math.E, inf: Infinity, nan: NaN, tau: 2 * Math.PI,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, exp: Math.exp, log: (x, b) => (b ? Math.log(x) / Math.log(b) : Math.log(x)),
  log10: Math.log10, log2: Math.log2, fabs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  pow: Math.pow, hypot: Math.hypot, radians: (d) => (d * Math.PI) / 180, degrees: (r) => (r * 180) / Math.PI,
  copysign: (a, b) => Math.sign(b) * Math.abs(a) || Math.abs(a), fmod: (a, b) => a % b,
  isnan: Number.isNaN, isinf: (x) => !Number.isFinite(x) && !Number.isNaN(x),
};
const BUILTINS = {
  ...MATH,
  abs: Math.abs, min: (...a) => Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a)),
  max: (...a) => Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a)),
  round: (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; },
  int: (x) => (typeof x === 'string' ? parseInt(x, 10) : Math.trunc(x)),
  float: (x) => parseFloat(x), str: (x) => pyStr(x), bool: (x) => truthy(x),
  len: (x) => (x == null ? 0 : typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).length : x.length),
  sum: (a) => a.reduce((s, v) => s + v, 0), list: (a) => [...a], range: (a, b, s = 1) => {
    if (b === undefined) { b = a; a = 0; }
    const out = []; for (let v = a; s > 0 ? v < b : v > b; v += s) out.push(v); return out;
  },
  math: MATH, True: true, False: false, None: null,
};

function pyStr(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v == null) return 'None';
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : String(v);
  if (Array.isArray(v)) return '[' + v.map(pyStr).join(', ') + ']';
  return String(v);
}
function truthy(v) {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
    return true;
  }
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

class Parser {
  constructor(src, lookup) { this.toks = tokenize(src); this.i = 0; this.lookup = lookup; this.src = src; }
  peek(v) { const t = this.toks[this.i]; return t && t.t === 'op' && (v === undefined || t.v === v) ? t : null; }
  eat(v) { if (this.peek(v)) { this.i++; return true; } return false; }
  expect(v) { if (!this.eat(v)) throw new Error(`'${v}' 필요: "${this.src}"`); }
  parse() {
    const v = this.ternary();
    if (this.i < this.toks.length) throw new Error(`수식 끝에 불필요한 토큰: "${this.src}"`);
    return v;
  }
  ternary() {
    const a = this.or();
    if (this.eat('if')) {
      const cond = this.or(); this.expect('else'); const b = this.ternary();
      return truthy(cond) ? a : b;
    }
    return a;
  }
  or() { let a = this.and(); while (this.eat('or')) { const b = this.and(); a = truthy(a) ? a : b; } return a; }
  and() { let a = this.not(); while (this.eat('and')) { const b = this.not(); a = truthy(a) ? b : a; } return a; }
  not() { if (this.eat('not')) return !truthy(this.not()); return this.cmp(); }
  cmp() {
    let a = this.add();
    for (;;) {
      const t = this.peek();
      if (!t) return a;
      if (t.v === 'in' || (t.v === 'not' && this.toks[this.i + 1]?.v === 'in')) {
        const neg = t.v === 'not'; this.i += neg ? 2 : 1;
        const b = this.add();
        const r = Array.isArray(b) || typeof b === 'string' ? b.includes(a) : b && a in b;
        a = neg ? !r : r; continue;
      }
      if (t.v === 'is') { this.i++; const neg = this.eat('not'); const b = this.add(); a = neg ? a !== b : a === b; continue; }
      if (!['==', '!=', '<', '>', '<=', '>='].includes(t.v)) return a;
      this.i++;
      const b = this.add();
      const [x, y] = coercePair(a, b);
      a = t.v === '==' ? x === y : t.v === '!=' ? x !== y : t.v === '<' ? x < y : t.v === '>' ? x > y : t.v === '<=' ? x <= y : x >= y;
    }
  }
  add() {
    let a = this.mul();
    for (;;) {
      if (this.eat('+')) { const b = this.mul(); a = typeof a === 'string' || typeof b === 'string' ? (Array.isArray(a) ? a.concat(b) : pyStr(a) + pyStr(b)) : Array.isArray(a) ? a.concat(b) : num(a) + num(b); }
      else if (this.eat('-')) a = num(a) - num(this.mul());
      else return a;
    }
  }
  mul() {
    let a = this.unary();
    for (;;) {
      if (this.eat('*')) a = num(a) * num(this.unary());
      else if (this.eat('/')) a = num(a) / num(this.unary());
      else if (this.eat('//')) a = Math.floor(num(a) / num(this.unary()));
      else if (this.eat('%')) { const b = num(this.unary()); a = ((num(a) % b) + b) % b; }
      else return a;
    }
  }
  unary() {
    if (this.eat('-')) return -num(this.unary());
    if (this.eat('+')) return num(this.unary());
    return this.power();
  }
  power() {
    const a = this.postfix();
    if (this.eat('**')) return num(a) ** num(this.unary());
    return a;
  }
  postfix() {
    let a = this.atom();
    for (;;) {
      if (this.eat('(')) {
        const args = [];
        if (!this.eat(')')) { do { args.push(this.ternary()); } while (this.eat(',')); this.expect(')'); }
        if (typeof a !== 'function') throw new Error(`호출할 수 없는 값: "${this.src}"`);
        a = a(...args);
      } else if (this.eat('[')) {
        const k = this.ternary(); this.expect(']');
        a = Array.isArray(a) || typeof a === 'string' ? a[k < 0 ? a.length + k : k] : a?.[k];
      } else if (this.eat('.')) {
        const id = this.toks[this.i++];
        if (!id || id.t !== 'id') throw new Error(`속성 이름 필요: "${this.src}"`);
        if (a && Object.prototype.hasOwnProperty.call(a, id.v)) a = a[id.v];
        else if (typeof a === 'string' && id.v in STR_METHODS) a = STR_METHODS[id.v].bind(null, a);
        else throw new Error(`알 수 없는 속성 '${id.v}'`);
      } else return a;
    }
  }
  atom() {
    const t = this.toks[this.i++];
    if (!t) throw new Error(`수식이 불완전합니다: "${this.src}"`);
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'id') return this.lookup(t.v);
    if (t.v === 'True') return true;
    if (t.v === 'False') return false;
    if (t.v === 'None') return null;
    if (t.v === '(') {
      const v = this.ternary();
      if (this.eat(',')) { const arr = [v]; if (!this.peek(')')) do { arr.push(this.ternary()); } while (this.eat(',') && !this.peek(')')); this.expect(')'); return arr; }
      this.expect(')'); return v;
    }
    if (t.v === '[') {
      const arr = [];
      if (!this.eat(']')) { do { if (this.peek(']')) break; arr.push(this.ternary()); } while (this.eat(',')); this.expect(']'); }
      return arr;
    }
    if (t.v === '{') {
      const obj = {};
      if (!this.eat('}')) { do { if (this.peek('}')) break; const k = this.ternary(); this.expect(':'); obj[k] = this.ternary(); } while (this.eat(',')); this.expect('}'); }
      return obj;
    }
    throw new Error(`예상치 못한 토큰 '${t.v}': "${this.src}"`);
  }
}

const STR_METHODS = {
  upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase(), strip: (s) => s.trim(),
  split: (s, sep) => (sep === undefined ? s.trim().split(/\s+/) : s.split(sep)),
  replace: (s, a, b) => s.split(a).join(b), startswith: (s, p) => s.startsWith(p), endswith: (s, p) => s.endsWith(p),
  format: (s, ...a) => { let i = 0; return s.replace(/\{\}/g, () => pyStr(a[i++])); },
};

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)) return +v;
  if (v == null) throw new Error('None 값에 산술 연산');
  if (Array.isArray(v)) return v;
  throw new Error(`숫자가 아닙니다: '${v}'`);
}
function coercePair(a, b) {
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !isNaN(+b)) return [a, +b];
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && !isNaN(+a)) return [+a, b];
  if (typeof a === 'boolean' && typeof b === 'string') return [pyStr(a), b];
  if (typeof b === 'boolean' && typeof a === 'string') return [a, pyStr(b)];
  return [a, b];
}

export function evalExpr(src, lookup) { return new Parser(src, lookup).parse(); }

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

class Scope {
  constructor(parent = null) { this.parent = parent; this.vars = new Map(); this.macros = new Map(); }
  findVar(name) { for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name); return undefined; }
  findMacro(name) { for (let s = this; s; s = s.parent) if (s.macros.has(name)) return s.macros.get(name); return undefined; }
  root() { let s = this; while (s.parent) s = s.parent; return s; }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export class XacroProcessor {
  constructor(vfs, { args = {}, maxDepth = 60 } = {}) {
    this.vfs = vfs;
    this.userArgs = args;
    this.args = new Map();      // name -> { default, value }
    this.maxDepth = maxDepth;
    this.includes = [];
    this.warnings = [];
  }

  async process(text, path) {
    const doc = parseXML(text, path);
    this.doc = doc;
    this.rootPath = path;
    const scope = new Scope();
    const root = doc.documentElement;
    const out = doc.implementation.createDocument(null, null, null);
    const robot = out.importNode(root, false);
    out.appendChild(robot);
    this.out = out;
    await this.processChildren(root, robot, scope, path, 0);
    robot.removeAttribute('xmlns:xacro');
    for (const a of [...robot.attributes]) if (a.value === XACRO_NS) robot.removeAttribute(a.name);
    this.evalAttributes(robot, scope, path);
    return out;
  }

  isX(node) {
    return node.nodeType === 1 && (node.namespaceURI === XACRO_NS || node.nodeName.startsWith('xacro:'));
  }
  xname(node) { return node.localName || node.nodeName.replace(/^xacro:/, ''); }

  async processChildren(src, dst, scope, path, depth) {
    const kids = [...src.childNodes];
    for (let i = 0; i < kids.length; i++) await this.processNode(kids[i], dst, scope, path, depth);
  }

  async processNode(node, dst, scope, path, depth) {
    if (depth > this.maxDepth) throw new Error('xacro 재귀 깊이 초과 (순환 매크로?)');
    if (node.nodeType === 3) { dst.appendChild(this.out.createTextNode(this.subst(node.nodeValue, scope, path))); return; }
    if (node.nodeType === 4) { dst.appendChild(this.out.createCDATASection(node.nodeValue)); return; }
    if (node.nodeType === 8) { dst.appendChild(this.out.createComment(node.nodeValue)); return; }
    if (node.nodeType !== 1) return;

    if (!this.isX(node)) {
      const el = this.out.createElementNS(node.namespaceURI, node.nodeName);
      for (const a of node.attributes) {
        if (a.value === XACRO_NS) continue;
        el.setAttribute(a.name, this.subst(a.value, scope, path));
      }
      dst.appendChild(el);
      await this.processChildren(node, el, scope, path, depth + 1);
      return;
    }

    const tag = this.xname(node);
    const attr = (n) => node.getAttribute(n);
    switch (tag) {
      case 'property': {
        const name = attr('name');
        let target = scope;
        const sc = attr('scope');
        if (sc === 'parent' && scope.parent) target = scope.parent;
        else if (sc === 'global') target = scope.root();
        if (node.hasAttribute('value')) {
          // evaluate eagerly for plain values, keep lazily for ${} — same observable behavior
          target.vars.set(name, { raw: attr('value'), scope, path });
        } else if (node.hasAttribute('default')) {
          if (target.findVar(name) === undefined) target.vars.set(name, { raw: attr('default'), scope, path });
        } else {
          target.vars.set(name, { block: [...node.childNodes].filter((n) => n.nodeType === 1), scope, path });
        }
        return;
      }
      case 'arg': {
        const name = attr('name');
        if (!this.args.has(name)) {
          const def = node.hasAttribute('default') ? this.subst(attr('default'), scope, path) : null;
          const value = name in this.userArgs ? String(this.userArgs[name]) : def;
          this.args.set(name, { default: def, value, doc: attr('doc') || '' });
        }
        return;
      }
      case 'include': {
        const fn = this.subst(attr('filename'), scope, path);
        const res = this.resolveFile(fn, path);
        if (!res) { this.warnings.push(`include 파일을 찾을 수 없음: ${fn}`); return; }
        this.includes.push(res);
        const text = await this.vfs.text(res);
        const idoc = parseXML(text, res);
        const ns = attr('ns');
        let target = scope;
        if (ns) { target = new Scope(scope); scope.vars.set(ns, { namespace: target }); }
        await this.processChildren(idoc.documentElement, dst, target, res, depth + 1);
        return;
      }
      case 'macro': {
        const name = attr('name');
        scope.macros.set(name, { name, params: parseParams(attr('params') || ''), body: node, scope, path });
        return;
      }
      case 'if': case 'unless': {
        const v = this.evalValue(attr('value'), scope, path);
        if (truthy(v) === (tag === 'if')) await this.processChildren(node, dst, scope, path, depth + 1);
        return;
      }
      case 'insert_block': {
        const name = this.subst(attr('name'), scope, path);
        const v = scope.findVar(name);
        if (!v || !v.block) throw new Error(`블록 '${name}' 을(를) 찾을 수 없음`);
        for (const b of v.block) await this.processNode(b, dst, v.scope, v.path, depth + 1);
        return;
      }
      case 'element': {
        const el = this.out.createElement(this.subst(node.getAttribute('xacro:name'), scope, path));
        for (const a of node.attributes) if (a.name !== 'xacro:name') el.setAttribute(a.name, this.subst(a.value, scope, path));
        dst.appendChild(el);
        await this.processChildren(node, el, scope, path, depth + 1);
        return;
      }
      case 'attribute': {
        if (dst.nodeType === 1) dst.setAttribute(this.subst(attr('name'), scope, path), this.subst(attr('value') ?? node.textContent, scope, path));
        return;
      }
      case 'call': {
        const m = this.lookupMacro(this.subst(attr('macro'), scope, path), scope);
        await this.callMacro(m, node, dst, scope, path, depth, ['macro']);
        return;
      }
      default: {
        const m = this.lookupMacro(tag, scope);
        await this.callMacro(m, node, dst, scope, path, depth, []);
      }
    }
  }

  lookupMacro(name, scope) {
    let m = scope.findMacro(name);
    if (!m && name.includes('.')) {
      const [ns, rest] = name.split(/\.(.+)/);
      const v = scope.findVar(ns);
      if (v?.namespace) m = v.namespace.findMacro(rest);
    }
    if (!m) throw new Error(`알 수 없는 xacro 매크로: xacro:${name}`);
    return m;
  }

  async callMacro(m, node, dst, callerScope, path, depth, skipAttrs) {
    const local = new Scope(callerScope);
    const blocks = [...node.childNodes].filter((n) => n.nodeType === 1);
    let bi = 0;
    const given = new Set();
    for (const a of node.attributes) {
      if (skipAttrs.includes(a.name) || a.value === XACRO_NS) continue;
      const p = m.params.find((q) => q.name === a.name);
      if (!p) { this.warnings.push(`매크로 ${m.name}: 정의되지 않은 매개변수 '${a.name}'`); }
      local.vars.set(a.name, { value: this.subst(a.value, callerScope, path) });
      given.add(a.name);
    }
    for (const p of m.params) {
      if (p.block) {
        if (p.all) local.vars.set(p.name, { block: blocks.slice(bi), scope: callerScope, path }), (bi = blocks.length);
        else {
          const b = blocks[bi++];
          if (!b) throw new Error(`매크로 ${m.name}: 블록 매개변수 '${p.name}' 누락`);
          local.vars.set(p.name, { block: [b], scope: callerScope, path });
        }
        continue;
      }
      if (given.has(p.name)) continue;
      if (p.inherit) {
        const v = callerScope.findVar(p.name);
        if (v !== undefined) { local.vars.set(p.name, { value: this.resolveVar(p.name, v) }); continue; }
      }
      if (p.def !== undefined) local.vars.set(p.name, { value: this.subst(p.def, callerScope, path) });
      else throw new Error(`매크로 ${m.name}: 매개변수 '${p.name}' 누락`);
    }
    await this.processChildren(m.body, dst, local, m.path, depth + 1);
  }

  resolveVar(name, v) {
    if (v.value !== undefined) return v.value;
    if (v.block) return v.block;
    if (v.namespace) return v.namespace;
    if ('cached' in v) return v.cached;
    if (v.evaluating) throw new Error(`속성 '${name}' 순환 참조`);
    v.evaluating = true;
    try { v.cached = this.substTyped(v.raw, v.scope, v.path); }
    finally { v.evaluating = false; }
    return v.cached;
  }

  lookupFn(scope) {
    return (name) => {
      const v = scope.findVar(name);
      if (v !== undefined) {
        const r = this.resolveVar(name, v);
        if (v.namespace) return nsProxy(v.namespace, this);
        return typeof r === 'string' && r.trim() !== '' && !isNaN(+r) ? +r : r;
      }
      if (name === 'xacro') return { arg: (n) => this.args.get(n)?.value ?? '' };
      if (name in BUILTINS) return BUILTINS[name];
      throw new Error(`정의되지 않은 속성: '${name}'`);
    };
  }

  evalValue(s, scope, path) { return this.substTyped(s ?? '', scope, path); }

  // Substitute and keep the type when the whole string is a single ${expr}.
  substTyped(s, scope, path) {
    const m = /^\s*\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*$/.exec(s);
    if (m) return evalExpr(this.substDollar(m[1], scope, path), this.lookupFn(scope));
    return this.subst(s, scope, path);
  }

  subst(s, scope, path) {
    if (s == null || s.indexOf('$') < 0) return s;
    s = this.substDollar(s, scope, path);
    let out = '', i = 0;
    while (i < s.length) {
      if (s[i] === '$' && s[i + 1] === '$' && s[i + 2] === '{') { out += '${'; i += 3; continue; }
      if (s[i] === '$' && s[i + 1] === '{') {
        let depth = 1, j = i + 2;
        while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
        const expr = s.slice(i + 2, j - 1);
        const v = evalExpr(expr, this.lookupFn(scope));
        out += Array.isArray(v) ? v.map(pyStr).join(' ') : pyStr(fmtNum(v));
        i = j; continue;
      }
      out += s[i++];
    }
    return out;
  }

  // $(arg x), $(find pkg), $(env X), $(optenv X def), $(eval expr), $(dirname)
  substDollar(s, scope, path) {
    if (s.indexOf('$(') < 0) return s;
    let out = '', i = 0;
    while (i < s.length) {
      if (s[i] === '$' && s[i + 1] === '(') {
        let depth = 1, j = i + 2;
        while (j < s.length && depth) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; j++; }
        const body = s.slice(i + 2, j - 1).trim();
        const [cmd, ...rest] = body.split(/\s+/);
        const argStr = body.slice(cmd.length).trim();
        switch (cmd) {
          case 'arg': {
            const a = this.args.get(rest[0]);
            if (!a) {
              if (rest[0] in this.userArgs) out += this.userArgs[rest[0]];
              else throw new Error(`정의되지 않은 인자: $(arg ${rest[0]})`);
            } else out += a.value ?? '';
            break;
          }
          case 'find': {
            const dirs = this.vfs.packageDirs(rest[0]);
            out += dirs.length ? dirs[0] : `package://${rest[0]}`;
            break;
          }
          case 'dirname': out += dirname(path); break;
          case 'env': out += ''; this.warnings.push(`$(env ${rest[0]}) 는 브라우저에서 빈 값으로 처리됩니다`); break;
          case 'optenv': out += rest.slice(1).join(' '); break;
          case 'eval': out += pyStr(fmtNum(evalExpr(this.substDollar(argStr, scope, path), this.lookupFn(scope)))); break;
          default: out += s.slice(i, j);
        }
        i = j; continue;
      }
      out += s[i++];
    }
    return out;
  }

  // attributes of the root element
  evalAttributes(el, scope, path) {
    for (const a of [...el.attributes]) el.setAttribute(a.name, this.subst(a.value, scope, path));
  }

  resolveFile(fn, from) {
    fn = fn.trim();
    const pk = /^package:\/\/([^/]+)\/(.*)$/.exec(fn);
    if (pk) { const r = this.vfs.resolve(fn, from); return r?.path || null; }
    const direct = normalize(fn);
    if (this.vfs.has(direct)) return direct;
    const rel = join(dirname(from), fn);
    if (this.vfs.has(rel)) return rel;
    const r = this.vfs.resolve(fn, from);
    return r?.path || null;
  }
}

function nsProxy(scope, proc) {
  return new Proxy({}, {
    get: (_, k) => { const v = scope.findVar(k); return v === undefined ? undefined : proc.resolveVar(k, v); },
    has: (_, k) => scope.findVar(k) !== undefined,
    getOwnPropertyDescriptor: (_, k) => (scope.findVar(k) !== undefined ? { configurable: true, enumerable: true, value: proc.resolveVar(k, scope.findVar(k)) } : undefined),
  });
}

function fmtNum(v) {
  if (typeof v !== 'number') return v;
  if (Number.isInteger(v)) return v;
  return parseFloat(v.toPrecision(15));
}

function parseParams(s) {
  const out = [];
  for (const tok of s.trim().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('**')) { out.push({ name: tok.slice(2), block: true, all: true }); continue; }
    if (tok.startsWith('*')) { out.push({ name: tok.slice(1), block: true }); continue; }
    const m = /^([^:=]+)(?::=|=)(\^\|?)?(.*)$/.exec(tok);
    if (m) {
      const p = { name: m[1] };
      if (m[2] === '^') p.inherit = true;
      else if (m[2] === '^|') { p.inherit = true; p.def = m[3]; }
      if (m[2] !== '^|') p.def = m[3];
      if (m[2] === '^') p.def = undefined;
      out.push(p);
    } else out.push({ name: tok });
  }
  return out;
}

export function parseXML(text, path = '') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) {
    const detail = err.textContent
      .replace(/This page contains the following errors:/i, '')
      .replace(/Below is a rendering of the page up to the first error\.?/i, '')
      .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' ');
    const e = new Error(`XML 오류${path ? ` (${path.split('/').pop()})` : ''}: ${detail}`);
    const m = /line (\d+)/i.exec(err.textContent);
    if (m) e.line = +m[1];
    throw e;
  }
  return doc;
}

export async function expandXacro(vfs, text, path, args = {}) {
  const proc = new XacroProcessor(vfs, { args });
  const doc = await proc.process(text, path);
  return {
    doc, args: [...proc.args].map(([name, a]) => ({ name, ...a })),
    includes: proc.includes, warnings: proc.warnings,
  };
}
