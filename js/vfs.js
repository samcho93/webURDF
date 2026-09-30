// vfs.js — virtual file system shared by every load source (local files, folders,
// zip archives, GitHub repositories, plain URLs and the bundled examples).
//
// Every file is addressed by a normalized, slash-separated path without a leading
// slash. An entry either holds a Blob (local data) or a URL (remote data).

export const URDF_EXT = /\.(urdf|xacro|urdf\.xacro)$/i;
export const MESH_EXT = /\.(stl|dae|obj|glb|gltf|ply)$/i;
export const RELEVANT_EXT = /\.(urdf|xacro|stl|dae|obj|mtl|glb|gltf|bin|ply|png|jpe?g|tga|bmp|webp|ktx2?|xml|yaml|yml|json|srdf)$/i;

export function normalize(path) {
  const out = [];
  for (const seg of String(path).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); }
    else out.push(seg);
  }
  return out.join('/');
}
export const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
export const join = (...parts) => normalize(parts.filter((s) => s !== '' && s != null).join('/'));
export const extname = (p) => { const m = /\.[^./]+$/.exec(p); return m ? m[0].toLowerCase() : ''; };

const LFS_HEAD = 'version https://git-lfs.github.com/spec';

export class VFS {
  constructor(label = '') {
    this.label = label;
    this.files = new Map();      // path -> entry { path, blob?, url?, size?, headers?, lfsUrl? }
    this.lower = new Map();      // lower-case path -> path (case-insensitive lookups)
    this.packages = new Map();   // ROS package name -> directory path
    this.openBase = null;        // URL-only mode: base URL used to guess unknown files
    this.objectURLs = new Map();
    this.textCache = new Map();
  }

  add(path, entry) {
    path = normalize(path);
    const e = { path, ...entry };
    this.files.set(path, e);
    this.lower.set(path.toLowerCase(), path);
    return e;
  }
  addBlob(path, blob) { return this.add(path, { blob, size: blob.size }); }
  addURL(path, url, extra = {}) { return this.add(path, { url, ...extra }); }

  merge(other) {
    for (const e of other.files.values()) this.add(e.path, e);
    for (const [k, v] of other.packages) this.packages.set(k, v);
  }

  has(path) { return this.files.has(normalize(path)); }
  get(path) {
    const n = normalize(path);
    return this.files.get(n) || this.files.get(this.lower.get(n.toLowerCase()));
  }
  list() { return [...this.files.keys()].sort(); }
  get size() { return this.files.size; }

  dirs() {
    const set = new Set();
    for (const p of this.files.keys()) {
      let d = dirname(p);
      while (d && !set.has(d)) { set.add(d); d = dirname(d); }
    }
    return set;
  }

  robotFiles() {
    return this.list().filter((p) => URDF_EXT.test(p));
  }

  // Scan package.xml files so that package://<name>/ resolves even when the
  // directory name differs from the package name.
  async scanPackages() {
    for (const p of this.files.keys()) {
      if (basename(p) !== 'package.xml') continue;
      try {
        const txt = await this.text(p);
        const m = /<name>\s*([^<\s]+)\s*<\/name>/.exec(txt);
        if (m) this.packages.set(m[1], dirname(p));
      } catch { /* ignore unreadable package.xml */ }
    }
  }

  packageDirs(pkg) {
    const out = [];
    if (this.packages.has(pkg)) out.push(this.packages.get(pkg));
    for (const d of this.dirs()) if (basename(d) === pkg && !out.includes(d)) out.push(d);
    // shallowest first
    return out.sort((a, b) => a.split('/').length - b.split('/').length);
  }

  // Synchronous URL for loaders that fetch by themselves (textures etc.).
  urlFor(path) {
    const e = this.get(path);
    if (!e) return this.openBase ? new URL(path, this.openBase).href : null;
    if (e.blob) {
      if (!this.objectURLs.has(e.path)) this.objectURLs.set(e.path, URL.createObjectURL(e.blob));
      return this.objectURLs.get(e.path);
    }
    return e.url;
  }

  async fetchEntry(e) {
    if (e.blob) return e.blob;
    let res = await fetch(e.url, e.headers ? { headers: e.headers } : undefined);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${e.url}`);
    let blob = await res.blob();
    if (blob.size < 400 && e.lfsUrl) {
      const head = await blob.slice(0, LFS_HEAD.length).text();
      if (head === LFS_HEAD) {
        res = await fetch(e.lfsUrl);
        if (!res.ok) throw new Error(`LFS ${res.status} — ${e.lfsUrl}`);
        blob = await res.blob();
      }
    }
    e.blob = blob; // cache for later reads
    e.size = blob.size;
    return blob;
  }

  async blob(path) {
    const e = this.get(path);
    if (e) return this.fetchEntry(e);
    if (this.openBase) {
      const url = new URL(path, this.openBase).href;
      const ent = this.add(path, { url });
      try { return await this.fetchEntry(ent); } catch (err) { this.files.delete(ent.path); throw err; }
    }
    throw new Error(`파일 없음: ${path}`);
  }
  async text(path) {
    const key = normalize(path);
    if (this.textCache.has(key)) return this.textCache.get(key);
    const t = await (await this.blob(path)).text();
    this.textCache.set(key, t);
    return t;
  }
  async arrayBuffer(path) { return (await this.blob(path)).arrayBuffer(); }

  invalidateText(path) { this.textCache.delete(normalize(path)); }

  dispose() {
    for (const u of this.objectURLs.values()) URL.revokeObjectURL(u);
    this.objectURLs.clear();
  }

  // ------------------------------------------------------------------------
  // Mesh / include resolution
  // ------------------------------------------------------------------------

  // Returns candidate paths (most likely first) for a reference found in `from`.
  candidates(ref, from = '') {
    ref = String(ref).trim().replace(/\\/g, '/');
    const baseDir = dirname(normalize(from));
    const out = [];
    const push = (p) => { p = normalize(p); if (p && !p.startsWith('..') && !out.includes(p)) out.push(p); };

    let m;
    if ((m = /^(?:package|model):\/\/([^/]+)\/?(.*)$/.exec(ref))) {
      const [, pkg, rel] = m;
      for (const d of this.packageDirs(pkg)) push(join(d, rel));
      // typical layout: <pkg>/urdf/robot.urdf + <pkg>/meshes/...
      push(join(dirname(baseDir), rel));
      push(join(baseDir, rel));
      push(join(dirname(dirname(baseDir)), pkg, rel));
      push(join(pkg, rel));
      push(rel);
    } else if ((m = /^file:\/\/+(.*)$/.exec(ref))) {
      push(m[1]);
    } else if (/^\//.test(ref)) {
      push(ref);
    } else {
      push(join(baseDir, ref));
      push(ref);
    }
    return out;
  }

  // Finds an existing file for `ref`. Falls back to suffix / file name matching.
  resolve(ref, from = '') {
    if (/^(https?:|blob:|data:)/i.test(ref)) return { url: ref };
    const cands = this.candidates(ref, from);
    for (const c of cands) { const e = this.get(c); if (e) return { path: e.path }; }

    // suffix matching: the longest trailing segment run wins
    const segs = normalize(ref.replace(/^[a-z]+:\/\/+/i, '')).toLowerCase().split('/');
    for (let k = segs.length; k >= 1; k--) {
      const tail = segs.slice(-k).join('/');
      const hits = [];
      for (const p of this.files.keys()) {
        const lp = p.toLowerCase();
        if (lp === tail || lp.endsWith('/' + tail)) hits.push(p);
      }
      if (hits.length) {
        // prefer the hit closest to the referencing file
        hits.sort((a, b) => commonPrefix(b, from) - commonPrefix(a, from));
        return { path: hits[0], fuzzy: true };
      }
    }
    if (this.openBase && cands.length) return { path: cands[0], guess: true, alternatives: cands.slice(1) };
    return null;
  }
}

function commonPrefix(a, b) {
  const x = a.split('/'), y = dirname(b).split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
