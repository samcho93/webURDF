// sources.js — build a VFS from the different places a robot can come from.
import { VFS, normalize, RELEVANT_EXT, URDF_EXT } from './vfs.js';

// ---------------------------------------------------------------------------
// Local files / folders
// ---------------------------------------------------------------------------

export async function fromFileList(files, label = '로컬 파일') {
  const vfs = new VFS(label);
  for (const f of files) {
    const path = f.webkitRelativePath || f._relPath || f.name;
    if (/\.zip$/i.test(f.name)) {
      const zipVfs = await fromZip(f, stripExt(path));
      vfs.merge(zipVfs);
    } else {
      vfs.addBlob(path, f);
    }
  }
  await vfs.scanPackages();
  return vfs;
}

// DataTransfer (drag & drop) — walks dropped directories recursively.
export async function fromDataTransfer(dt) {
  const entries = [];
  for (const item of dt.items || []) {
    const en = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (en) entries.push(en);
  }
  const files = [];
  if (entries.length) {
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        file._relPath = prefix + file.name;
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, prefix + entry.name + '/');
        } while (batch.length);
      }
    };
    for (const en of entries) await walk(en, '');
  } else {
    files.push(...dt.files);
  }
  const label = entries.length === 1 && entries[0].isDirectory ? entries[0].name : '드롭한 파일';
  return fromFileList(files, label);
}

// ---------------------------------------------------------------------------
// ZIP archives (JSZip is loaded on demand)
// ---------------------------------------------------------------------------

let jszipPromise = null;
export function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipPromise ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    s.onload = () => res(window.JSZip);
    s.onerror = () => rej(new Error('JSZip 로드 실패'));
    document.head.appendChild(s);
  });
  return jszipPromise;
}

export async function fromZip(blobOrBuffer, label = 'ZIP') {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(blobOrBuffer);
  const vfs = new VFS(label);
  const jobs = [];
  zip.forEach((path, entry) => {
    if (entry.dir || /(^|\/)(__MACOSX|\.git)\//.test(path)) return;
    jobs.push(entry.async('blob').then((b) => vfs.addBlob(path, b)));
  });
  await Promise.all(jobs);
  await vfs.scanPackages();
  return vfs;
}

// ---------------------------------------------------------------------------
// Bundled examples
// ---------------------------------------------------------------------------

export async function loadManifest() {
  const res = await fetch('examples/manifest.json');
  if (!res.ok) throw new Error('예제 목록을 불러오지 못했습니다');
  return res.json();
}

export async function fromExample(group) {
  const vfs = new VFS(group.name);
  const base = new URL('examples/', location.href);
  for (const f of group.files) vfs.addURL(f.path, new URL(f.path, base).href, { size: f.size });
  await vfs.scanPackages();
  return vfs;
}

// ---------------------------------------------------------------------------
// URLs (GitHub aware)
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'webURDF.githubToken';
export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
export function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

export function parseGitHubURL(input) {
  let u;
  try { u = new URL(input.trim()); } catch { return null; }
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.hostname === 'github.com' && parts.length >= 2) {
    const [owner, repo0, kind, ref, ...rest] = parts;
    const repo = repo0.replace(/\.git$/, '');
    if (!kind) return { owner, repo, ref: null, path: '', kind: 'tree' };
    if ((kind === 'tree' || kind === 'blob' || kind === 'raw') && ref) {
      return { owner, repo, ref, path: rest.join('/'), kind: kind === 'tree' ? 'tree' : 'blob' };
    }
    return { owner, repo, ref: null, path: '', kind: 'tree' };
  }
  if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    const [owner, repo, ...rest] = parts;
    let ref = rest.shift();
    if (ref === 'refs' && rest[0] === 'heads') { rest.shift(); ref = rest.shift(); }
    return { owner, repo, ref, path: rest.join('/'), kind: 'blob' };
  }
  return null;
}

async function ghApi(path, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ' ' + (await res.json()).message; } catch { /* ignore */ }
    if (res.status === 404) msg += ' (비공개 저장소라면 GitHub 토큰을 설정하세요)';
    if (res.status === 403) msg += ' (API 사용량 제한일 수 있습니다. 토큰을 설정하면 한도가 늘어납니다)';
    throw new Error('GitHub API: ' + msg);
  }
  return res.json();
}

export async function fromGitHub(gh, onProgress = () => {}) {
  const token = getToken();
  let ref = gh.ref;
  if (!ref) {
    onProgress('저장소 정보 확인 중…');
    ref = (await ghApi(`/repos/${gh.owner}/${gh.repo}`, token)).default_branch;
  }
  onProgress('파일 목록 가져오는 중…');
  const tree = await ghApi(`/repos/${gh.owner}/${gh.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token);
  const vfs = new VFS(`${gh.owner}/${gh.repo}@${ref}`);
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  for (const t of tree.tree) {
    if (t.type !== 'blob' || !RELEVANT_EXT.test(t.path)) continue;
    const raw = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${enc(ref)}/${enc(t.path)}`;
    const lfsUrl = `https://media.githubusercontent.com/media/${gh.owner}/${gh.repo}/${enc(ref)}/${enc(t.path)}`;
    if (token) {
      vfs.addURL(t.path, `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${enc(t.path)}?ref=${encodeURIComponent(ref)}`,
        { size: t.size, headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${token}` }, rawUrl: raw });
    } else {
      vfs.addURL(t.path, raw, { size: t.size, lfsUrl });
    }
  }
  if (tree.truncated) console.warn('GitHub tree listing truncated');
  onProgress('패키지 검색 중…');
  await vfs.scanPackages();
  // the preferred entry: the linked file, or robot files under the linked folder
  const prefix = gh.path ? normalize(gh.path) : '';
  let entry = null, choices = vfs.robotFiles();
  if (gh.kind === 'blob' && vfs.has(prefix)) entry = prefix;
  else if (prefix) choices = choices.filter((p) => p === prefix || p.startsWith(prefix + '/'));
  return { vfs, entry, choices };
}

export async function fromURL(input, onProgress = () => {}) {
  const url = input.trim();
  const gh = parseGitHubURL(url);
  if (gh) {
    try { return await fromGitHub(gh, onProgress); }
    catch (err) {
      if (gh.kind !== 'blob') throw err;
      console.warn(err, '— falling back to plain URL mode');
    }
  }
  onProgress('다운로드 중…');
  const target = gh ? `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.ref}/${gh.path}` : url;
  const res = await fetch(target);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const u = new URL(res.url || target);
  if (/\.zip$/i.test(u.pathname) || (res.headers.get('content-type') || '').includes('zip')) {
    const vfs = await fromZip(await res.blob(), u.pathname.split('/').pop());
    return { vfs, entry: null, choices: vfs.robotFiles() };
  }
  const text = await res.text();
  const vfs = new VFS(u.hostname);
  vfs.openBase = u.origin + '/';
  const path = normalize(decodeURIComponent(u.pathname));
  vfs.addBlob(path, new Blob([text], { type: 'text/xml' }));
  if (!URDF_EXT.test(path) && !/<robot[\s>]/.test(text)) throw new Error('URDF 문서가 아닙니다');
  return { vfs, entry: path, choices: [path] };
}

function stripExt(p) { return p.replace(/\.[^./]+$/, ''); }
