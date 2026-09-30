// main.js — webURDF application: loading, state, and the UI panels.
import URDFLoader from 'urdf-loader';
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { MeshLibrary } from './meshes.js';
import { VFS, basename, dirname, formatBytes, URDF_EXT, MESH_EXT, normalize } from './vfs.js';
import * as Src from './sources.js';
import { expandXacro, isXacro, parseXML } from './xacro.js';
import * as M from './model.js';
import { CodeEditor } from './ui/code.js';
import { GraphView } from './ui/graph.js';
import { $, $$, h, toast, download, debounce, dialog, RAD2DEG, num } from './ui/util.js';

// ============================================================================
// State
// ============================================================================
const S = {
  vfs: null,            // current virtual file system
  path: '',             // path of the opened robot file inside the VFS
  source: '',           // text of the opened file (URDF or xacro)
  xacro: false,
  xacroArgs: {},        // user overrides
  xacroInfo: null,      // { args, includes, warnings }
  urdf: '',             // expanded URDF text
  doc: null,            // DOM of the URDF
  model: null,          // extracted structure
  robot: null,          // URDFRobot
  meshStatus: new Map(),// mesh ref -> { path, error, fuzzy, info }
  pending: 0,
  selected: null,       // link name
  origin: null,         // { type: 'example'|'url', ... } for share links
  history: [], future: [],
  build: 0,
  anim: null,
  exampleManifest: null,
  label: '',
};

const viewer = new Viewer($('#viewport'));
const meshes = new MeshLibrary();
const editor = new CodeEditor({ textarea: $('#code'), pre: $('#code-hl'), gutter: $('#gutter') });
const graph = new GraphView($('#graph'), { onSelect: (n) => select(n, { from: 'graph' }) });

// ============================================================================
// Loading
// ============================================================================

function progress(msg, frac = null) {
  const p = $('#progress');
  if (msg == null) { p.classList.remove('show'); return; }
  p.classList.add('show');
  p.classList.toggle('indet', frac == null);
  if (frac != null) p.style.setProperty('--p', `${Math.round(frac * 100)}%`);
  p.querySelector('span').textContent = msg;
}

async function openVFS(vfs, { entry = null, choices = null, origin = null } = {}) {
  const list = choices || vfs.robotFiles();
  if (!list.length && !entry) {
    // no robot file: maybe the user dropped meshes to add to the current model
    if (S.vfs && S.source) {
      S.vfs.merge(vfs);
      toast(`${vfs.size}개 파일을 현재 모델에 추가했습니다`, 'ok');
      await rebuild({ keepView: true });
      return;
    }
    toast('URDF / xacro 파일을 찾지 못했습니다', 'error');
    return;
  }
  let target = entry;
  if (!target) target = list.length === 1 ? list[0] : await pickRobotFile(list, vfs.label);
  if (!target) return;
  S.vfs?.dispose();
  S.vfs = vfs;
  S.origin = origin;
  meshes.setVFS(vfs);
  await openEntry(target);
}

async function openEntry(path) {
  progress(`${basename(path)} 읽는 중…`);
  try {
    const text = await S.vfs.text(path);
    S.path = normalize(path);
    S.xacroArgs = {};
    S.history = []; S.future = [];
    S.selected = null;
    await setSource(text, { fresh: true });
    renderFiles();
    updateURLState();
  } catch (err) {
    console.error(err);
    toast(`열기 실패: ${err.message}`, 'error', 6000);
  } finally { progress(null); }
}

async function setSource(text, { fresh = false, fromEditor = false, keepView = !fresh, record = !fresh } = {}) {
  if (record && S.source && S.source !== text) { S.history.push({ source: S.source, xacro: S.xacro, path: S.path }); S.future = []; if (S.history.length > 200) S.history.shift(); }
  S.source = text;
  S.xacro = isXacro(text, S.path);
  await rebuild({ fresh, fromEditor, keepView });
}

async function rebuild({ fresh = false, fromEditor = false, keepView = true } = {}) {
  const token = ++S.build;
  let doc;
  $('#code-error').textContent = '';
  editor.setError(null);
  try {
    if (S.xacro) {
      const res = await expandXacro(S.vfs, S.source, S.path, S.xacroArgs);
      if (token !== S.build) return;
      S.xacroInfo = res;
      doc = res.doc;
      S.urdf = M.formatXML(M.serialize(doc));
      doc = parseXML(S.urdf);
    } else {
      S.xacroInfo = null;
      doc = parseXML(S.source, S.path);
      S.urdf = S.source;
    }
    if (!doc.documentElement || doc.documentElement.tagName !== 'robot') throw new Error('최상위 요소가 <robot> 이 아닙니다');
  } catch (err) {
    if (token !== S.build) return;
    $('#code-error').textContent = err.message;
    editor.setError(err.line || null);
    if (!fromEditor) toast(err.message, 'error', 6000);
    if (!fromEditor) editor.setValue(S.source, { keepScroll: false });
    setCodeMode();
    return;
  }

  S.doc = doc;
  S.model = M.extract(doc);
  const jointState = !fresh && S.robot ? Object.fromEntries(Object.entries(S.robot.joints).map(([k, j]) => [k, j.jointValue.slice()])) : null;

  // build the three.js robot
  const loader = new URDFLoader(meshes.manager);
  loader.parseCollision = true;
  loader.packages = (pkg) => `package://${pkg}`;
  const status = new Map();
  S.meshStatus = status;
  S.pending = 0;
  let total = 0;
  const onMesh = (r) => {
    if (token !== S.build) return;
    status.set(r.ref, r.error ? { error: r.error.message || String(r.error) } : { path: r.path || r.url, fuzzy: r.fuzzy, info: r.info });
    S.pending--;
    if (total > 2) progress(`메시 불러오는 중… ${total - S.pending}/${total}`, (total - S.pending) / total);
    if (S.pending === 0) meshesDone(fresh, token);
  };
  const cb = meshes.callback(S.path, onMesh);
  loader.loadMeshCb = (path, manager, material, done) => { S.pending++; total++; cb(path, manager, material, done); };
  let robot;
  try {
    robot = loader.parse(S.urdf);
  } catch (err) {
    console.error(err);
    $('#code-error').textContent = 'URDF 해석 오류: ' + err.message;
    return;
  }
  if (token !== S.build) return;
  S.robot = robot;
  for (const j of Object.values(robot.joints)) j.ignoreLimits = $('#ignore-limits').checked;
  if (jointState) for (const [k, v] of Object.entries(jointState)) robot.joints[k]?.setJointValue(...v);
  if (S.selected && !S.model.linkMap.has(S.selected)) S.selected = null;
  viewer.setRobot(robot, S.model, { keepView });
  viewer.select(S.selected);
  $('#welcome').classList.add('hidden');

  if (!fromEditor) editor.setValue(S.source, { keepScroll: !fresh });
  setCodeMode();
  renderTitle();
  renderTree();
  renderJoints();
  renderProps();
  renderCheck();
  renderInfo();
  graph.render(S.model);
  graph.select(S.selected);
  if (S.pending === 0) meshesDone(fresh, token);
}

function meshesDone(fresh, token) {
  if (token !== S.build) return;
  progress(null);
  viewer.meshesLoaded({ fit: fresh });
  renderCheck();
  renderInfo();
  renderFiles();
  const failed = [...S.meshStatus.values()].filter((s) => s.error).length;
  const st = M.stats(S.model);
  setStatus(`${S.model.name || '(이름 없음)'} — 링크 ${st.links} · 조인트 ${st.joints} · 자유도 ${st.dof}${failed ? ` · 메시 실패 ${failed}` : ''}`);
  if (fresh && failed) toast(`메시 ${failed}개를 찾지 못했습니다. [검사] 탭을 확인하거나 메시 폴더를 추가하세요.`, 'warn', 6000);
}

function setStatus(t) { $('#status').textContent = t; }

async function pickRobotFile(list, label) {
  const sorted = [...list].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  return dialog((form, close) => {
    form.append(
      h('h2', {}, '열 파일 선택'),
      h('p', {}, `${label || ''} 에서 URDF/xacro 파일 ${list.length}개를 찾았습니다.`),
      h('div', { class: 'list' }, sorted.map((p) => h('button', { type: 'button', onclick: () => close(p) }, p))),
      h('div', { class: 'buttons' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '취소')),
    );
  });
  function score(p) { return (/\.urdf$/i.test(p) ? 0 : 1) + p.split('/').length * 0.01; }
}

// ---------------------------------------------------------------- sources

async function loadExample(group, file = null) {
  progress(`${group.name} 예제 불러오는 중…`);
  try {
    const vfs = await Src.fromExample(group);
    const entry = file || group.entries[0].path;
    await openVFS(vfs, { entry, origin: { type: 'example', id: group.id, file: entry } });
  } catch (err) { toast(err.message, 'error'); } finally { progress(null); }
}

async function loadURL(url) {
  progress('URL 확인 중…');
  try {
    const res = await Src.fromURL(url, (m) => progress(m));
    await openVFS(res.vfs, { entry: res.entry, choices: res.choices, origin: { type: 'url', url } });
  } catch (err) {
    console.error(err);
    toast(`URL 불러오기 실패: ${err.message}`, 'error', 7000);
  } finally { progress(null); }
}

async function loadFiles(files, label) {
  if (!files.length) return;
  progress('파일 읽는 중…');
  try {
    const vfs = await Src.fromFileList(files, label);
    await openVFS(vfs, { origin: null });
  } catch (err) { toast(err.message, 'error'); } finally { progress(null); }
}

async function addFiles(files) {
  if (!S.vfs) return loadFiles(files);
  const extra = await Src.fromFileList(files);
  S.vfs.merge(extra);
  meshes.clear();
  toast(`${extra.size}개 파일을 추가했습니다`, 'ok');
  await rebuild({ keepView: true });
  renderFiles();
}

// ============================================================================
// Editing (DOM-based edits from the property panel)
// ============================================================================

async function commitDoc({ structural = false } = {}) {
  let text = M.serialize(S.doc);
  if (structural) text = M.formatXML(text);
  if (S.xacro) {
    toast('xacro 원본 대신 전개된 URDF 를 편집합니다 (xacro 매크로는 제거됨)', 'warn', 5000);
    S.path = S.path.replace(/\.urdf\.xacro$|\.xacro$/i, '') + (/\.urdf$/i.test(S.path.replace(/\.xacro$/i, '')) ? '' : '.urdf');
  }
  await setSource(text, { record: true });
}

function editJoint(name, patch) {
  M.setJoint(S.model, name, patch);
  return commitDoc({ structural: true });
}

// ============================================================================
// Selection
// ============================================================================

function select(name, { from = '' } = {}) {
  if (name && !S.model?.linkMap.has(name)) name = null;
  S.selected = name;
  viewer.select(name);
  graph.select(name);
  for (const n of $$('#tree .tnode')) n.classList.toggle('selected', n.dataset.link === name);
  const j = name && S.model.childJoint.get(name);
  for (const r of $$('#joint-list .jrow')) r.classList.toggle('selected', !!j && r.dataset.joint === j.name);
  if (from !== 'tree') $(`#tree .tnode[data-link="${CSS.escape(name || '')}"]`)?.scrollIntoView({ block: 'nearest' });
  if (name && from !== 'code' && isTabActive('code')) editor.reveal('link', name);
  renderProps();
}

// ============================================================================
// Panels
// ============================================================================

function renderTitle() {
  const t = $('#doc-title');
  t.innerHTML = '';
  if (!S.model) return;
  t.append(h('b', {}, S.model.name || '(이름 없음)'), '  ', h('span', {}, `${S.vfs?.label ? S.vfs.label + ' · ' : ''}${S.path}${S.xacro ? ' (xacro)' : ''}`));
  document.title = `${S.model.name || 'robot'} — webURDF`;
}

// ---------------------------------------------------------------- tree
const collapsed = new Set();
function renderTree() {
  const root = $('#tree');
  root.innerHTML = '';
  const m = S.model;
  if (!m) return;
  const filter = $('#tree-filter').value.trim().toLowerCase();
  const matches = (name, j) => !filter || name.toLowerCase().includes(filter) || (j && j.name.toLowerCase().includes(filter));
  // keep ancestors of matches visible
  const keep = new Set();
  if (filter) {
    for (const l of m.links) {
      const j = m.childJoint.get(l.name);
      if (matches(l.name, j)) {
        let n = l.name, guard = 0;
        while (n && !keep.has(n) && guard++ < 10000) { keep.add(n); n = m.childJoint.get(n)?.parent; }
      }
    }
  }
  const frag = document.createDocumentFragment();
  const visit = (name, depth, joint, seen) => {
    if (seen.has(name)) return;
    seen.add(name);
    if (filter && !keep.has(name)) return;
    const kids = m.childrenOf.get(name) || [];
    const isCol = collapsed.has(name) && !filter;
    const link = m.linkMap.get(name);
    const icon = link && (link.visuals.some((v) => v.geometry.type === 'mesh') ? '◆' : link.visuals.length ? '■' : '□');
    const row = h('div', {
      class: 'tnode' + (name === S.selected ? ' selected' : '') + (filter && !matches(name, joint) ? ' dim' : ''),
      style: { paddingLeft: `${6 + depth * 14}px` }, dataset: { link: name }, title: name,
    },
    h('span', { class: 'tw', onclick: (e) => { e.stopPropagation(); if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name); renderTree(); } }, kids.length ? (isCol ? '▸' : '▾') : ''),
    h('span', { class: 'ico', style: { color: link ? 'var(--accent)' : 'var(--err)' } }, icon || '!'),
    h('span', {}, name),
    joint ? h('span', { class: `jt ${joint.type}`, title: `조인트: ${joint.name} (${joint.type})` }, joint.type) : null,
    joint ? h('span', { class: 'jn' }, joint.name) : null);
    row.addEventListener('click', () => select(name, { from: 'tree' }));
    row.addEventListener('dblclick', () => viewer.focusLink(name));
    frag.appendChild(row);
    if (!isCol) for (const j of kids) visit(j.child, depth + 1, j, seen);
  };
  const seen = new Set();
  for (const r of m.roots) visit(r, 0, null, seen);
  for (const l of m.links) if (!seen.has(l.name)) visit(l.name, 0, m.childJoint.get(l.name), seen);
  root.appendChild(frag);
  if (!root.children.length) root.appendChild(h('div', { class: 'empty' }, filter ? '일치하는 항목 없음' : '링크 없음'));
}

// ---------------------------------------------------------------- joints
const jointInputs = new Map();
function useDeg() { return $('#deg-toggle').checked; }
function jointRange(mj, rj) {
  if (mj.type === 'continuous') return [-Math.PI, Math.PI];
  if ($('#ignore-limits').checked) return mj.type === 'prismatic' ? [-1, 1] : [-Math.PI, Math.PI];
  let lo = rj.limit.lower, hi = rj.limit.upper;
  if (lo === hi) { lo = mj.type === 'prismatic' ? -0.1 : -Math.PI; hi = -lo; }
  return [lo, hi];
}
function renderJoints() {
  const list = $('#joint-list');
  list.innerHTML = '';
  jointInputs.clear();
  if (!S.robot) return;
  const movable = S.model.joints.filter((j) => M.MOVABLE.has(j.type));
  if (!movable.length) { list.appendChild(h('div', { class: 'empty' }, '움직일 수 있는 조인트가 없습니다')); return; }
  const deg = useDeg();
  for (const mj of movable) {
    const rj = S.robot.joints[mj.name];
    if (!rj) continue;
    const angular = mj.type !== 'prismatic';
    const k = angular && deg ? RAD2DEG : 1;
    const [lo, hi] = jointRange(mj, rj);
    const val = rj.jointValue[0] || 0;
    const range = h('input', { type: 'range', min: lo * k, max: hi * k, step: (hi - lo) * k / 1000 || 0.001, value: val * k, disabled: !!mj.mimic });
    const box = h('input', { type: 'number', step: angular ? (deg ? 1 : 0.01) : 0.001, value: num(val * k, 3), disabled: !!mj.mimic });
    const set = (v) => { setJoint(mj.name, v / k); };
    range.addEventListener('input', () => set(+range.value));
    box.addEventListener('change', () => set(+box.value));
    const row = h('div', { class: 'jrow' + (S.model.childJoint.get(S.selected) === mj ? ' selected' : ''), dataset: { joint: mj.name } },
      h('div', { class: 'jhead', onclick: () => select(mj.child) },
        h('span', { class: `jt ${mj.type}`, style: { fontSize: '10px', padding: '0 4px', border: '1px solid', borderRadius: '4px' } }, mj.type[0].toUpperCase()),
        h('b', { title: mj.name }, mj.name),
        h('span', { class: 'muted sm' }, angular ? (deg ? '°' : 'rad') : 'm')),
      h('div', { class: 'jctl' }, range, box),
      mj.mimic ? h('div', { class: 'mimic' }, `mimic: ${mj.mimic.joint} × ${mj.mimic.multiplier} + ${mj.mimic.offset}`)
        : h('div', { class: 'lim' }, h('span', {}, num(lo * k, 2)), h('span', {}, num(hi * k, 2))));
    list.appendChild(row);
    jointInputs.set(mj.name, { range, box, k });
  }
}
function setJoint(name, value, { silent = false } = {}) {
  const rj = S.robot?.joints[name];
  if (!rj) return;
  rj.setJointValue(value);
  syncJointInputs();
  if (!silent) renderPose();
}
function syncJointInputs() {
  for (const [name, { range, box, k }] of jointInputs) {
    const v = (S.robot.joints[name]?.jointValue[0] || 0) * k;
    if (document.activeElement !== range) range.value = v;
    if (document.activeElement !== box) box.value = num(v, 3);
  }
}
viewer.addEventListener('joint-change', () => { syncJointInputs(); renderPose(); });

function setAllJoints(fn) {
  if (!S.robot) return;
  for (const mj of S.model.joints) {
    if (!M.MOVABLE.has(mj.type) || mj.mimic) continue;
    const rj = S.robot.joints[mj.name];
    if (!rj) continue;
    const [lo, hi] = jointRange(mj, rj);
    rj.setJointValue(fn(lo, hi, mj));
  }
  syncJointInputs();
  renderPose();
}

function toggleAnimation() {
  const btn = $('#anim-btn');
  if (S.anim) {
    viewer.animators.delete(S.anim);
    S.anim = null;
    btn.textContent = '▶ 스윕';
    return;
  }
  let t = 0;
  S.anim = (dt) => {
    t += dt;
    if (!S.robot) return;
    let i = 0;
    for (const mj of S.model.joints) {
      if (!M.MOVABLE.has(mj.type) || mj.mimic) continue;
      const rj = S.robot.joints[mj.name];
      if (!rj) continue;
      const [lo, hi] = jointRange(mj, rj);
      const mid = mj.type === 'continuous' ? 0 : (lo + hi) / 2, amp = mj.type === 'continuous' ? Math.PI : (hi - lo) / 2;
      rj.setJointValue(mid + amp * 0.9 * Math.sin(t * 1.2 + i * 0.7));
      i++;
    }
    syncJointInputs();
  };
  viewer.animators.add(S.anim);
  btn.textContent = '■ 정지';
}

// ---------------------------------------------------------------- properties
function vecInputs(values, onChange, { step = 0.001, deg = false } = {}) {
  const k = deg ? RAD2DEG : 1;
  const ins = values.map((v) => h('input', { type: 'number', step: deg ? 1 : step, value: num(v * k, deg ? 3 : 6) }));
  for (const i of ins) i.addEventListener('change', () => onChange(ins.map((x) => (+x.value || 0) / k)));
  return h('div', { class: 'v3' }, ins);
}
const rgbaToHex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const hexToRgba = (hex, a = 1) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat([a]);

function renderProps() {
  const root = $('#props');
  root.innerHTML = '';
  const m = S.model;
  if (!m) { root.appendChild(h('div', { class: 'empty' }, '모델을 열면 속성이 표시됩니다')); return; }
  const deg = useDeg();

  if (!S.selected) {
    const nameIn = h('input', { type: 'text', value: m.name });
    nameIn.addEventListener('change', () => { S.doc.documentElement.setAttribute('name', nameIn.value.trim()); commitDoc(); });
    root.append(
      h('h3', {}, '로봇'),
      h('div', { class: 'pgrid' }, h('label', {}, '이름'), nameIn),
      h('p', { class: 'hint' }, '3D 뷰, 구조 트리, 그래프에서 링크를 클릭하면 링크와 부모 조인트의 속성을 편집할 수 있습니다.'),
      h('h3', {}, '재질 (material)'),
      m.materials.size ? h('div', {}, [...m.materials].map(([name, mat]) => {
        const c = h('input', { type: 'color', class: 'color-in', value: mat.rgba ? rgbaToHex(mat.rgba) : '#cccccc' });
        c.addEventListener('change', () => {
          let col = [...mat.el.children].find((x) => x.tagName === 'color');
          if (!col) { col = S.doc.createElement('color'); mat.el.appendChild(col); }
          col.setAttribute('rgba', M.fmtVec(hexToRgba(c.value, mat.rgba?.[3] ?? 1)));
          commitDoc({ structural: !mat.rgba });
        });
        return h('div', { class: 'pgrid', style: { gridTemplateColumns: '34px 1fr', marginBottom: '4px' } }, c, h('span', {}, name, mat.texture ? h('span', { class: 'muted sm' }, ` (texture: ${mat.texture})`) : null));
      })) : h('p', { class: 'hint' }, '전역 재질 없음'),
    );
    return;
  }

  const link = m.linkMap.get(S.selected);
  const joint = m.childJoint.get(S.selected);
  if (!link) return;

  // ---- link header
  const lname = h('input', { type: 'text', value: link.name });
  lname.addEventListener('change', () => {
    try { if (M.renameLink(m, link.name, lname.value.trim())) { S.selected = lname.value.trim(); commitDoc(); } }
    catch (e) { toast(e.message, 'error'); lname.value = link.name; }
  });
  root.append(
    h('h3', {}, '링크', h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', title: '화면 맞춤', onclick: () => viewer.focusLink(link.name) }, '🔍'),
      h('button', { class: 'btn sm', title: '코드에서 보기', onclick: () => { activateTab('code'); editor.reveal('link', link.name); } }, '</>')),
    h('div', { class: 'pgrid' }, h('label', {}, '이름'), lname),
  );

  // ---- joint
  if (joint) {
    const jname = h('input', { type: 'text', value: joint.name });
    jname.addEventListener('change', () => {
      try { if (M.renameJoint(m, joint.name, jname.value.trim())) commitDoc(); }
      catch (e) { toast(e.message, 'error'); jname.value = joint.name; }
    });
    const jtype = h('select', {}, M.JOINT_TYPES.map((t) => h('option', { value: t, selected: t === joint.type }, t)));
    jtype.addEventListener('change', () => editJoint(joint.name, { type: jtype.value }));
    const parentSel = h('select', {}, m.links.filter((l) => l.name !== link.name).map((l) => h('option', { value: l.name, selected: l.name === joint.parent }, l.name)));
    parentSel.addEventListener('change', () => {
      // prevent cycles: the new parent must not be in the subtree of this link
      const sub = new Set();
      const walk = (n) => { sub.add(n); for (const c of m.childrenOf.get(n) || []) walk(c.child); };
      walk(link.name);
      if (sub.has(parentSel.value)) { toast('자손 링크를 부모로 지정할 수 없습니다 (순환)', 'error'); parentSel.value = joint.parent; return; }
      [...joint.el.children].find((c) => c.tagName === 'parent').setAttribute('link', parentSel.value);
      commitDoc();
    });
    const grid = h('div', { class: 'pgrid' },
      h('label', {}, '이름'), jname,
      h('label', {}, '타입'), jtype,
      h('label', {}, '부모 링크'), parentSel,
      h('label', {}, 'xyz (m)'), vecInputs(joint.xyz, (v) => editJoint(joint.name, { xyz: v })),
      h('label', {}, `rpy (${deg ? '°' : 'rad'})`), vecInputs(joint.rpy, (v) => editJoint(joint.name, { rpy: v }), { deg }),
    );
    if (M.MOVABLE.has(joint.type) || joint.type === 'planar') {
      const axisIn = vecInputs(joint.axis, (v) => {
        const n = Math.hypot(...v) || 1;
        editJoint(joint.name, { axis: v.map((x) => x / n) });
      }, { step: 0.1 });
      const presets = h('div', { class: 'btn-row', style: { marginTop: '3px' } }, [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]], ['-X', [-1, 0, 0]], ['-Y', [0, -1, 0]], ['-Z', [0, 0, -1]]]
        .map(([t, v]) => h('button', { class: 'btn sm', type: 'button', onclick: () => editJoint(joint.name, { axis: v }) }, t)));
      grid.append(h('label', {}, '축 axis'), h('div', {}, axisIn, presets));
    }
    if (joint.type === 'revolute' || joint.type === 'prismatic' || joint.type === 'continuous') {
      const ang = joint.type !== 'prismatic';
      const k = ang && deg ? RAD2DEG : 1;
      const L = joint.limit || {};
      const f = (key, scale = 1) => {
        const i = h('input', { type: 'number', step: 'any', value: L[key] == null ? '' : num(L[key] * scale, 6), placeholder: '—' });
        i.addEventListener('change', () => editJoint(joint.name, { limit: { [key]: i.value === '' ? null : +i.value / scale } }));
        return i;
      };
      if (joint.type !== 'continuous') {
        grid.append(h('label', {}, `하한 (${ang ? (deg ? '°' : 'rad') : 'm'})`), f('lower', k), h('label', {}, `상한 (${ang ? (deg ? '°' : 'rad') : 'm'})`), f('upper', k));
      }
      grid.append(h('label', {}, ang ? 'effort (N·m)' : 'effort (N)'), f('effort'), h('label', {}, ang ? 'velocity (rad/s)' : 'velocity (m/s)'), f('velocity'));
      const D = joint.dynamics || {};
      const d = (key) => {
        const i = h('input', { type: 'number', step: 'any', value: D[key] == null ? '' : D[key], placeholder: '—' });
        i.addEventListener('change', () => editJoint(joint.name, { dynamics: { [key]: i.value === '' ? null : +i.value } }));
        return i;
      };
      grid.append(h('label', {}, 'damping'), d('damping'), h('label', {}, 'friction'), d('friction'));
    }
    if (joint.mimic) grid.append(h('label', {}, 'mimic'), h('span', { class: 'sm' }, `${joint.mimic.joint} × ${joint.mimic.multiplier} + ${joint.mimic.offset}`));
    root.append(h('h3', {}, '부모 조인트', h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', title: '코드에서 보기', onclick: () => { activateTab('code'); editor.reveal('joint', joint.name); } }, '</>')), grid);
  } else {
    root.append(h('p', { class: 'hint' }, '루트 링크입니다 (부모 조인트 없음).'));
  }

  // ---- pose
  root.append(h('h3', {}, '현재 자세 (기준 좌표계)'), poseBlock(link.name));

  // ---- visuals / collisions
  const shapeCards = (list, kind) => list.map((s, idx) => {
    const g = s.geometry;
    const typeSel = h('select', {}, ['box', 'cylinder', 'sphere', 'mesh'].map((t) => h('option', { value: t, selected: t === g.type }, t)));
    typeSel.addEventListener('change', () => {
      const t = typeSel.value;
      const def = { box: { type: 'box', size: [0.05, 0.05, 0.05] }, cylinder: { type: 'cylinder', radius: 0.025, length: 0.05 }, sphere: { type: 'sphere', radius: 0.025 }, mesh: { type: 'mesh', filename: g.filename || '' } }[t];
      M.setGeometry(s.el, def); commitDoc({ structural: true });
    });
    const grid = h('div', { class: 'pgrid' }, h('label', {}, '형상'), typeSel);
    const setG = (patch) => { M.setGeometry(s.el, { ...g, ...patch }); commitDoc(); };
    const numIn = (v, cb) => { const i = h('input', { type: 'number', step: 0.001, value: num(v, 6) }); i.addEventListener('change', () => cb(+i.value)); return i; };
    if (g.type === 'box') grid.append(h('label', {}, 'size'), vecInputs(g.size, (v) => setG({ size: v })));
    if (g.type === 'sphere') grid.append(h('label', {}, 'radius'), numIn(g.radius, (v) => setG({ radius: v })));
    if (g.type === 'cylinder' || g.type === 'capsule') grid.append(h('label', {}, 'radius'), numIn(g.radius, (v) => setG({ radius: v })), h('label', {}, 'length'), numIn(g.length, (v) => setG({ length: v })));
    if (g.type === 'mesh') {
      const fn = h('input', { type: 'text', value: g.filename });
      fn.addEventListener('change', () => setG({ filename: fn.value.trim() }));
      const st = S.meshStatus.get(g.filename);
      grid.append(h('label', {}, 'filename'), fn,
        h('label', {}, 'scale'), vecInputs(g.scale || [1, 1, 1], (v) => setG({ scale: v })),
        h('label', {}, '상태'), h('span', { class: 'sm', style: { color: st?.error ? 'var(--err)' : 'var(--muted)', wordBreak: 'break-all' } },
          !st ? '로딩 중…' : st.error ? `✗ ${st.error}` : `✓ ${st.path}${st.info ? ` · ${st.info.format} · ${st.info.triangles.toLocaleString()} tris · ${formatBytes(st.info.bytes)}` : ''}`));
    }
    grid.append(h('label', {}, 'xyz'), vecInputs(s.xyz, (v) => { M.setOrigin(s.el, v, s.rpy); commitDoc({ structural: !s.el.querySelector(':scope > origin') }); }),
      h('label', {}, `rpy (${deg ? '°' : 'rad'})`), vecInputs(s.rpy, (v) => { M.setOrigin(s.el, s.xyz, v); commitDoc({ structural: !s.el.querySelector(':scope > origin') }); }, { deg }));
    if (kind === 'visual') {
      const mat = s.rgba || m.materials.get(s.material)?.rgba;
      const col = h('input', { type: 'color', class: 'color-in', value: mat ? rgbaToHex(mat) : '#cccccc' });
      col.addEventListener('change', () => { M.setShapeColor(s.el, hexToRgba(col.value, mat?.[3] ?? 1)); commitDoc({ structural: true }); });
      grid.append(h('label', {}, '색상'), h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, col, h('span', { class: 'muted sm' }, s.material ? `material: ${s.material}` : '')));
    }
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, `${kind === 'visual' ? '비주얼' : '충돌'} #${idx + 1}`, s.name ? h('span', { class: 'muted' }, s.name) : null, h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm danger', type: 'button', title: '삭제', onclick: () => { s.el.remove(); commitDoc({ structural: true }); } }, '✕')),
      grid);
  });
  const addShape = (kind) => {
    const el = S.doc.createElement(kind);
    link.el.insertBefore(el, kind === 'visual' ? link.el.firstElementChild : null);
    M.setOrigin(el, [0, 0, 0], [0, 0, 0]);
    M.setGeometry(el, { type: 'box', size: [0.05, 0.05, 0.05] });
    if (kind === 'visual') M.setShapeColor(el, [0.6, 0.6, 0.6, 1]);
    commitDoc({ structural: true });
  };
  root.append(h('h3', {}, `비주얼 (${link.visuals.length})`, h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => addShape('visual') }, '+ 추가')), ...shapeCards(link.visuals, 'visual'));
  const copyVis = link.visuals.length ? h('button', {
    class: 'btn sm', title: '비주얼 형상을 충돌 형상으로 복사', onclick: () => {
      for (const c of link.collisions) c.el.remove();
      for (const v of link.visuals) {
        const c = S.doc.createElement('collision');
        for (const ch of v.el.children) if (ch.tagName !== 'material') c.appendChild(ch.cloneNode(true));
        link.el.appendChild(c);
      }
      commitDoc({ structural: true });
    },
  }, '비주얼→충돌') : null;
  root.append(h('h3', {}, `충돌 (${link.collisions.length})`, h('span', { class: 'spacer' }), copyVis, h('button', { class: 'btn sm', onclick: () => addShape('collision') }, '+ 추가')), ...shapeCards(link.collisions, 'collision'));

  // ---- inertial
  const inr = link.inertial;
  const I = inr?.I || { ixx: 0, ixy: 0, ixz: 0, iyy: 0, iyz: 0, izz: 0 };
  const cur = { mass: inr?.mass ?? 0, xyz: inr?.xyz ?? [0, 0, 0], rpy: inr?.rpy ?? [0, 0, 0], I: { ...I } };
  const save = () => { M.setInertial(link.el, cur); commitDoc({ structural: !inr }); };
  const massIn = h('input', { type: 'number', step: 'any', value: cur.mass });
  massIn.addEventListener('change', () => { cur.mass = +massIn.value; save(); });
  const ii = ['ixx', 'ixy', 'ixz', 'iyy', 'iyz', 'izz'].map((key) => {
    const i = h('input', { type: 'number', step: 'any', value: I[key] });
    i.addEventListener('change', () => { cur.I[key] = +i.value; save(); });
    return h('div', { class: 'cell' }, h('span', {}, key), i);
  });
  const auto = h('button', {
    class: 'btn sm', type: 'button', title: '첫 번째 충돌(없으면 비주얼) 기본 도형과 질량으로 관성 텐서를 계산',
    onclick: () => {
      const s = [...link.collisions, ...link.visuals].find((x) => ['box', 'cylinder', 'sphere', 'capsule'].includes(x.geometry.type));
      if (!s) { toast('기본 도형(box/cylinder/sphere)이 있어야 자동 계산할 수 있습니다', 'warn'); return; }
      if (!(cur.mass > 0)) { toast('먼저 질량을 입력하세요', 'warn'); return; }
      cur.I = M.primitiveInertia(s.geometry, cur.mass);
      cur.xyz = s.xyz; cur.rpy = s.rpy;
      save();
    },
  }, '형상으로 계산');
  root.append(
    h('h3', {}, '관성 (inertial)', h('span', { class: 'spacer' }), auto),
    h('div', { class: 'pgrid' },
      h('label', {}, '질량 (kg)'), massIn,
      h('label', {}, 'COM xyz'), vecInputs(cur.xyz, (v) => { cur.xyz = v; save(); }),
      h('label', {}, `rpy (${deg ? '°' : 'rad'})`), vecInputs(cur.rpy, (v) => { cur.rpy = v; save(); }, { deg }),
      h('label', {}, '관성 텐서'), h('div', { class: 'v6' }, ii)),
  );

  // ---- structure actions
  root.append(h('h3', {}, '구조 편집'), h('div', { class: 'btn-row' },
    h('button', { class: 'btn sm', onclick: () => addChildDialog(link.name) }, '+ 자식 링크 추가'),
    h('button', { class: 'btn sm', onclick: () => duplicateSubtree(link.name) }, '하위 트리 복제'),
    h('button', { class: 'btn sm danger', onclick: () => deleteLink(link.name) }, '링크 삭제'),
  ));
}

function poseBlock(linkName) {
  const wrap = h('div', {});
  const refSel = h('select', { style: { width: '100%', marginBottom: '4px' } },
    h('option', { value: '' }, '로봇 루트 기준'),
    S.model.links.filter((l) => l.name !== linkName).map((l) => h('option', { value: l.name, selected: l.name === S.poseRef }, `${l.name} 기준`)));
  refSel.addEventListener('change', () => { S.poseRef = refSel.value || null; renderPose(); });
  const pre = h('div', { class: 'pose', id: 'pose-box' });
  wrap.append(refSel, pre);
  requestAnimationFrame(renderPose);
  return wrap;
}
function renderPose() {
  const box = $('#pose-box');
  if (!box || !S.selected) return;
  const ref = S.poseRef && S.poseRef !== S.selected ? S.poseRef : null;
  const m = viewer.linkWorldMatrix(S.selected, ref);
  if (!m) { box.textContent = ''; return; }
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  m.decompose(p, q, sc);
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  const deg = useDeg(), k = deg ? RAD2DEG : 1, u = deg ? '°' : 'rad';
  box.textContent =
    `xyz  ${[p.x, p.y, p.z].map((v) => num(v, 4).padStart(9)).join(' ')}  m\n` +
    `rpy  ${[e.x, e.y, e.z].map((v) => num(v * k, deg ? 2 : 4).padStart(9)).join(' ')}  ${u}\n` +
    `quat ${[q.x, q.y, q.z, q.w].map((v) => num(v, 4).padStart(7)).join(' ')}  (x y z w)\n` +
    `거리 ${num(p.length(), 4)} m`;
}

async function addChildDialog(parent) {
  const res = await dialog((form, close) => {
    const name = h('input', { type: 'text', value: M.uniqueName(S.model.linkMap, 'link') });
    const type = h('select', {}, M.JOINT_TYPES.slice(0, 4).map((t) => h('option', { value: t }, t)));
    const geom = h('select', {}, h('option', { value: 'box' }, 'box'), h('option', { value: 'cylinder' }, 'cylinder'), h('option', { value: 'sphere' }, 'sphere'));
    const xyz = h('input', { type: 'text', value: '0 0 0.1' });
    form.append(h('h2', {}, `"${parent}" 에 자식 링크 추가`),
      h('div', { class: 'field' }, h('label', {}, '링크 이름'), name),
      h('div', { class: 'field' }, h('label', {}, '조인트 타입'), type),
      h('div', { class: 'field' }, h('label', {}, '형상'), geom),
      h('div', { class: 'field' }, h('label', {}, '조인트 위치 xyz (부모 기준, m)'), xyz),
      h('div', { class: 'buttons' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '취소'),
        h('button', { class: 'btn primary', type: 'submit', onclick: () => close({ name: name.value.trim(), type: type.value, geom: geom.value, xyz: xyz.value.trim() }) }, '추가')));
  });
  if (!res || !res.name) return;
  const geometry = { box: '<box size="0.05 0.05 0.1"/>', cylinder: '<cylinder radius="0.025" length="0.1"/>', sphere: '<sphere radius="0.04"/>' }[res.geom];
  const r = M.addChildLink(S.model, parent, { name: res.name, type: res.type, geometry, xyz: M.fmtVec(M.vec(res.xyz)) });
  S.selected = r.linkName;
  await commitDoc({ structural: true });
  toast(`링크 "${r.linkName}" 와 조인트 "${r.jointName}" 를 추가했습니다`, 'ok');
}

async function deleteLink(name) {
  const sub = [];
  const walk = (n) => { sub.push(n); for (const j of S.model.childrenOf.get(n) || []) walk(j.child); };
  walk(name);
  const ok = await dialog((form, close) => form.append(
    h('h2', {}, '링크 삭제'),
    h('p', {}, `"${name}" ${sub.length > 1 ? `과(와) 하위 링크 ${sub.length - 1}개` : ''} 및 연결된 조인트를 삭제합니다. (실행 취소 가능)`),
    h('div', { class: 'buttons' }, h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, '취소'), h('button', { class: 'btn primary', type: 'submit', onclick: () => close(true) }, '삭제'))));
  if (!ok) return;
  const parent = S.model.childJoint.get(name)?.parent || null;
  M.removeLinkSubtree(S.model, name);
  S.selected = parent;
  await commitDoc({ structural: true });
}

async function duplicateSubtree(name) {
  const m = S.model;
  const pj = m.childJoint.get(name);
  if (!pj) { toast('루트 링크는 복제할 수 없습니다', 'warn'); return; }
  const links = [], joints = [pj];
  const walk = (n) => { links.push(m.linkMap.get(n)); for (const j of m.childrenOf.get(n) || []) { joints.push(j); walk(j.child); } };
  walk(name);
  const suffix = M.uniqueName(new Set(m.links.map((l) => l.name.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), ''))), '_copy');
  const ren = (n) => `${n}${suffix}`;
  const robot = S.doc.documentElement;
  for (const l of links) { const c = l.el.cloneNode(true); c.setAttribute('name', ren(l.name)); robot.appendChild(c); }
  for (const j of joints) {
    const c = j.el.cloneNode(true);
    c.setAttribute('name', ren(j.name));
    const ch = [...c.children];
    if (j !== pj) ch.find((x) => x.tagName === 'parent').setAttribute('link', ren(j.parent));
    ch.find((x) => x.tagName === 'child').setAttribute('link', ren(j.child));
    const mim = ch.find((x) => x.tagName === 'mimic');
    if (mim && joints.some((o) => o.name === mim.getAttribute('joint'))) mim.setAttribute('joint', ren(mim.getAttribute('joint')));
    robot.appendChild(c);
  }
  S.selected = ren(name);
  await commitDoc({ structural: true });
  toast(`${links.length}개 링크를 복제했습니다 (접미사 "${suffix}")`, 'ok');
}

// ---------------------------------------------------------------- check
function renderCheck() {
  const root = $('#check');
  root.innerHTML = '';
  const badge = $('#check-badge');
  if (!S.model) { badge.textContent = ''; badge.className = 'badge'; return; }
  const issues = M.validate(S.model, { meshStatus: S.meshStatus });
  for (const w of S.xacroInfo?.warnings || []) issues.unshift({ level: 'warn', msg: `xacro: ${w}` });
  const missing = [...S.meshStatus].filter(([, s]) => s.error);
  const err = issues.filter((i) => i.level === 'error').length, warn = issues.filter((i) => i.level === 'warn').length;
  badge.textContent = err || warn || '';
  badge.className = 'badge ' + (err ? 'err' : warn ? 'warn' : '');
  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  for (const i of issues) {
    const el = h('div', { class: `issue ${i.level}${i.target ? ' clickable' : ''}` },
      h('span', { class: 'lv' }, { error: '!', warn: '!', info: 'i', ok: '✓' }[i.level]), h('span', {}, i.msg));
    if (i.target) el.addEventListener('click', () => {
      if (i.target.kind === 'link') select(i.target.name);
      else { const j = S.model.jointMap.get(i.target.name); if (j) select(j.child); }
    });
    root.appendChild(el);
  }
  if (missing.length) {
    root.append(h('p', { class: 'hint', style: { marginTop: '12px' } },
      '메시를 찾지 못했다면 메시가 들어있는 폴더(또는 파일)를 추가하세요. package:// 경로는 폴더 이름 또는 package.xml 의 이름으로 찾습니다.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn sm primary', onclick: () => { $('#folder-input').dataset.mode = 'add'; $('#folder-input').click(); } }, '메시 폴더 추가…'),
      h('button', { class: 'btn sm', onclick: () => $('#add-input').click() }, '메시 파일 추가…')));
  }
}

// ---------------------------------------------------------------- info
function renderInfo() {
  const root = $('#info');
  root.innerHTML = '';
  const m = S.model;
  if (!m) return;
  const st = M.stats(m);
  const tris = [...S.meshStatus.values()].reduce((s, x) => s + (x.info?.triangles || 0), 0);
  const bytes = [...new Set([...S.meshStatus.values()].filter((x) => x.info).map((x) => x.path))].reduce((s, p) => s + ([...S.meshStatus.values()].find((x) => x.path === p)?.info.bytes || 0), 0);
  const box = viewer.bounds();
  const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());
  // bounds are in three.js space; convert to ROS axes for display when Z-up
  const dims = size ? (viewer.opts.upAxis === 'Z' ? [size.x, size.z, size.y] : [size.x, size.y, size.z]) : null;
  const com = combinedCOM();
  root.append(
    h('h3', {}, '개요'),
    h('dl', { class: 'kv' },
      h('dt', {}, '로봇 이름'), h('dd', {}, m.name || '—'),
      h('dt', {}, '파일'), h('dd', { style: { wordBreak: 'break-all' } }, S.path + (S.xacro ? ' (xacro)' : '')),
      h('dt', {}, '출처'), h('dd', {}, S.vfs?.label || '—'),
      h('dt', {}, '링크 / 조인트'), h('dd', {}, `${st.links} / ${st.joints}`),
      h('dt', {}, '자유도 (DOF)'), h('dd', {}, `${st.dof}` + (m.joints.some((j) => j.mimic) ? ` (+ mimic ${m.joints.filter((j) => j.mimic).length})` : '')),
      h('dt', {}, '조인트 타입'), h('dd', {}, Object.entries(st.types).map(([k, v]) => `${k} ${v}`).join(', ') || '—'),
      h('dt', {}, '트리 깊이'), h('dd', {}, st.depth),
      h('dt', {}, '총 질량'), h('dd', {}, `${num(st.mass, 4)} kg`),
      h('dt', {}, '질량 중심'), h('dd', {}, com ? `${com.map((v) => num(v, 4)).join(', ')} m` : '—'),
      h('dt', {}, '크기 (x·y·z)'), h('dd', {}, dims ? dims.map((v) => num(v, 3)).join(' × ') + ' m' : '—'),
      h('dt', {}, '비주얼'), h('dd', {}, `메시 ${st.meshes}, 기본도형 ${st.prims}`),
      h('dt', {}, '충돌 형상'), h('dd', {}, st.collisions),
      h('dt', {}, '삼각형'), h('dd', {}, tris ? tris.toLocaleString() : '—'),
      h('dt', {}, '메시 용량'), h('dd', {}, bytes ? formatBytes(bytes) : '—'),
      h('dt', {}, '기타 요소'), h('dd', {}, [...new Set(m.other)].join(', ') || '—'),
    ),
  );

  if (S.xacroInfo) {
    const args = S.xacroInfo.args;
    root.append(h('h3', {}, 'xacro 인자'));
    if (!args.length) root.append(h('p', { class: 'hint' }, '인자 없음'));
    else {
      const grid = h('div', { class: 'pgrid' });
      for (const a of args) {
        const i = h('input', { type: 'text', value: a.value ?? '', placeholder: a.default ?? '' });
        i.addEventListener('change', async () => { S.xacroArgs[a.name] = i.value; await rebuild({ keepView: true }); });
        grid.append(h('label', { title: a.doc || a.name }, a.name), i);
      }
      root.append(grid);
    }
    if (S.xacroInfo.includes.length) root.append(h('p', { class: 'hint' }, 'include: ' + [...new Set(S.xacroInfo.includes)].join(', ')));
    root.append(h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => download(basename(S.path).replace(/(\.urdf)?\.xacro$/i, '') + '.urdf', S.urdf, 'text/xml') }, '전개된 URDF 저장')));
  }

  // mass distribution
  const massive = m.links.filter((l) => l.inertial?.mass > 0).sort((a, b) => b.inertial.mass - a.inertial.mass);
  if (massive.length) {
    const max = massive[0].inertial.mass;
    root.append(h('h3', {}, '질량 분포'), h('div', { class: 'bars' }, massive.slice(0, 30).map((l) =>
      h('div', { class: 'bar-row', style: { cursor: 'pointer' }, onclick: () => select(l.name), title: l.name },
        h('span', {}, l.name), h('div', {}, h('div', { class: 'b', style: { width: `${(l.inertial.mass / max) * 100}%` } })), h('span', {}, num(l.inertial.mass, 3))))));
  }

  // joint table
  const deg = useDeg(), k = deg ? RAD2DEG : 1;
  const js = m.joints;
  if (js.length) {
    root.append(h('h3', {}, `조인트 표 (${deg ? '°' : 'rad'}, m)`), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['이름', '타입', '부모 → 자식', '하한', '상한', 'effort', 'vel'].map((t) => h('th', {}, t)))),
      h('tbody', {}, js.map((j) => {
        const kk = j.type === 'prismatic' ? 1 : k;
        return h('tr', { class: 'clickable', onclick: () => select(j.child) },
          h('td', {}, j.name), h('td', {}, h('span', { class: `jt ${j.type}` }, j.type)), h('td', {}, `${j.parent} → ${j.child}`),
          h('td', { class: 'num' }, j.limit?.lower != null && j.type !== 'continuous' ? num(j.limit.lower * kk, 2) : ''),
          h('td', { class: 'num' }, j.limit?.upper != null && j.type !== 'continuous' ? num(j.limit.upper * kk, 2) : ''),
          h('td', { class: 'num' }, j.limit?.effort ?? ''), h('td', { class: 'num' }, j.limit?.velocity ?? ''));
      })))),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: exportJointCSV }, 'CSV 저장')));
  }
}

function combinedCOM() {
  if (!S.robot || !S.model) return null;
  S.robot.updateMatrixWorld(true);
  const inv = S.robot.matrixWorld.clone().invert();
  let mass = 0;
  const acc = new THREE.Vector3();
  for (const l of S.model.links) {
    if (!(l.inertial?.mass > 0)) continue;
    const link = S.robot.links[l.name];
    if (!link) continue;
    const p = new THREE.Vector3(...l.inertial.xyz).applyMatrix4(link.matrixWorld).applyMatrix4(inv);
    acc.addScaledVector(p, l.inertial.mass);
    mass += l.inertial.mass;
  }
  return mass > 0 ? acc.divideScalar(mass).toArray() : null;
}

function exportJointCSV() {
  const rows = [['name', 'type', 'parent', 'child', 'x', 'y', 'z', 'roll', 'pitch', 'yaw', 'axis_x', 'axis_y', 'axis_z', 'lower', 'upper', 'effort', 'velocity']];
  for (const j of S.model.joints) rows.push([j.name, j.type, j.parent, j.child, ...j.xyz, ...j.rpy, ...j.axis, j.limit?.lower ?? '', j.limit?.upper ?? '', j.limit?.effort ?? '', j.limit?.velocity ?? '']);
  download(`${S.model.name || 'robot'}_joints.csv`, '﻿' + rows.map((r) => r.join(',')).join('\n'), 'text/csv');
}

// ---------------------------------------------------------------- files
function renderFiles() {
  const root = $('#file-tree');
  root.innerHTML = '';
  if (!S.vfs) return;
  $('#vfs-label').textContent = `${S.vfs.label} · ${S.vfs.size}개 파일`;
  const used = new Set([...S.meshStatus.values()].map((s) => s.path).filter(Boolean));
  for (const i of S.xacroInfo?.includes || []) used.add(i);
  // folder tree
  const tree = {};
  for (const p of S.vfs.list()) {
    const parts = p.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i] + '/'] ||= {};
    node[parts[parts.length - 1]] = p;
  }
  const frag = document.createDocumentFragment();
  const rec = (node, depth, prefix) => {
    const keys = Object.keys(node).sort((a, b) => (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b));
    for (const k of keys) {
      if (k.endsWith('/')) {
        // collapse single-child chains (a/b/c/)
        let label = k, child = node[k], path = prefix + k;
        while (Object.keys(child).length === 1 && Object.keys(child)[0].endsWith('/')) {
          const only = Object.keys(child)[0]; label += only; path += only; child = child[only];
        }
        const open = !collapsedDirs.has(path);
        const row = h('div', { class: 'fnode clickable', style: { paddingLeft: `${8 + depth * 12}px` } }, h('span', {}, open ? '▾' : '▸'), h('span', {}, '📁'), h('span', { class: 'fname' }, label));
        row.onclick = () => { open ? collapsedDirs.add(path) : collapsedDirs.delete(path); renderFiles(); };
        frag.appendChild(row);
        if (open) rec(child, depth + 1, path);
      } else {
        const p = node[k];
        const e = S.vfs.get(p);
        const robotFile = URDF_EXT.test(p);
        const icon = robotFile ? '🤖' : MESH_EXT.test(p) ? '🧊' : /\.(png|jpe?g|tga|bmp|webp)$/i.test(p) ? '🖼' : '📄';
        const row = h('div', {
          class: 'fnode' + (robotFile ? ' clickable' : '') + (p === S.path ? ' active' : '') + (used.has(p) ? ' used' : ''),
          style: { paddingLeft: `${8 + depth * 12 + 14}px` }, title: p,
        }, h('span', {}, icon), h('span', { class: 'fname' }, k), h('span', { class: 'fsize' }, formatBytes(e?.size)));
        if (robotFile) row.onclick = () => { if (p !== S.path) openEntry(p); };
        frag.appendChild(row);
      }
    }
  };
  rec(tree, 0, '');
  root.appendChild(frag);
}
const collapsedDirs = new Set();

// ---------------------------------------------------------------- code
function setCodeMode() {
  $('#code-mode').textContent = S.xacro ? 'xacro — 적용 시 전개됩니다' : '';
}
const applyCode = debounce(() => { if (editor.value !== S.source) setSource(editor.value, { fromEditor: true, record: true }); }, 700);
editor.onChange = () => { if ($('#code-live').checked) applyCode(); };

// ============================================================================
// Export
// ============================================================================

function robotFileName(ext = '.urdf') {
  return (basename(S.path).replace(/(\.urdf)?(\.xacro)?$/i, '') || S.model?.name || 'robot') + ext;
}

async function exportZip() {
  if (!S.model) return;
  progress('ZIP 만드는 중…');
  try {
    const JSZip = await Src.loadJSZip();
    const zip = new JSZip();
    const dir = dirname(S.path);
    zip.file(S.path.replace(/(\.urdf)?\.xacro$/i, '.urdf'), S.urdf);
    if (S.xacro) {
      zip.file(S.path, S.source);
      for (const inc of S.xacroInfo?.includes || []) zip.file(inc, await S.vfs.blob(inc));
    }
    const done = new Set();
    for (const st of S.meshStatus.values()) {
      if (!st.path || done.has(st.path) || /^https?:/.test(st.path)) continue;
      done.add(st.path);
      zip.file(st.path, await S.vfs.blob(st.path));
      // textures / mtl next to meshes
      const d = dirname(st.path);
      for (const p of S.vfs.list()) if (dirname(p) === d && /\.(mtl|png|jpe?g|tga|bmp|webp|bin)$/i.test(p) && !done.has(p)) { done.add(p); zip.file(p, await S.vfs.blob(p)); }
    }
    for (const p of S.vfs.list()) if (basename(p) === 'package.xml') zip.file(p, await S.vfs.blob(p));
    const blob = await zip.generateAsync({ type: 'blob' });
    download(robotFileName('.zip'), blob);
    void dir;
  } catch (err) { toast(err.message, 'error'); } finally { progress(null); }
}

function exportPose() {
  const joints = {};
  for (const [k, j] of Object.entries(S.robot?.joints || {})) if (M.MOVABLE.has(j.jointType)) joints[k] = j.jointValue[0];
  download(`${S.model?.name || 'robot'}_pose.json`, JSON.stringify({ robot: S.model?.name, unit: 'rad/m', joints }, null, 2), 'application/json');
}

async function importPose(file) {
  try {
    const data = JSON.parse(await file.text());
    const js = data.joints || data;
    let n = 0;
    for (const [k, v] of Object.entries(js)) if (S.robot?.joints[k]) { S.robot.joints[k].setJointValue(+v); n++; }
    syncJointInputs(); renderPose();
    toast(`${n}개 조인트 값을 적용했습니다`, 'ok');
  } catch (err) { toast('자세 파일 오류: ' + err.message, 'error'); }
}

function shareLink() {
  const u = new URL(location.href);
  u.search = '';
  if (S.origin?.type === 'example') { u.searchParams.set('example', S.origin.id); if (S.path) u.searchParams.set('file', S.path); }
  else if (S.origin?.type === 'url') u.searchParams.set('url', S.origin.url);
  else return null;
  return u.href;
}
function updateURLState() {
  const link = shareLink();
  history.replaceState(null, '', link || location.pathname);
}

// ============================================================================
// Dialogs
// ============================================================================

async function urlDialog() {
  const res = await dialog((form, close) => {
    const input = h('input', { type: 'url', placeholder: 'https://github.com/owner/repo/tree/main/robot_description', value: '' });
    const tok = h('input', { type: 'password', placeholder: 'ghp_… (선택)', value: Src.getToken(), autocomplete: 'off' });
    const samples = [
      'https://github.com/TheRobotStudio/SO-ARM100/blob/main/Simulation/SO101/so101_new_calib.urdf',
      'https://github.com/ros/urdf_tutorial/tree/ros2/urdf',
      'https://github.com/unitreerobotics/unitree_ros/tree/master/robots/go2_description',
    ];
    form.append(
      h('h2', {}, 'URL / GitHub 링크 열기'),
      h('p', {}, 'URDF 파일 링크(raw / blob), GitHub 저장소·폴더 링크, ZIP 링크를 지원합니다. 폴더·저장소 링크는 메시 파일까지 함께 찾습니다.'),
      h('div', { class: 'field' }, input),
      h('div', { class: 'examples-hint' }, '예: ', samples.map((s, i) => [i ? ' · ' : '', h('code', { onclick: () => { input.value = s; input.focus(); } }, s.replace('https://github.com/', ''))])),
      h('details', {}, h('summary', {}, 'GitHub 토큰 (비공개 저장소 / 사용량 제한)'),
        h('p', { class: 'hint' }, '비공개 저장소를 읽거나 API 한도(시간당 60회)를 늘릴 때 사용합니다. 토큰은 이 브라우저의 localStorage 에만 저장되고 api.github.com 으로만 전송됩니다.'),
        h('div', { class: 'field' }, tok)),
      h('div', { class: 'buttons' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '취소'),
        h('button', { class: 'btn primary', type: 'submit', onclick: () => { Src.setToken(tok.value.trim()); close(input.value.trim()); } }, '열기')));
  });
  if (res) loadURL(res);
}

function helpDialog() {
  dialog((form, close) => form.append(
    h('h2', {}, 'webURDF 사용법'),
    h('p', {}, 'URDF / xacro 로봇 모델을 브라우저에서 열고, 보고, 편집하고, 검사합니다. 모든 처리는 브라우저 안에서 이루어지며 파일은 서버로 업로드되지 않습니다.'),
    h('div', { class: 'help-grid' },
      h('b', {}, '열기'), h('span', {}, '파일 · 폴더 · ZIP 드래그 앤 드롭, URL/GitHub 링크, 예제'),
      h('b', {}, '메시 경로'), h('span', {}, 'package://, 상대 경로, file:// 모두 지원 (package.xml / 폴더 이름 / 파일 이름으로 탐색)'),
      h('b', {}, '메시 형식'), h('span', {}, 'STL, DAE(Collada), OBJ(+MTL), GLB/glTF, PLY'),
      h('b', {}, '3D 조작'), h('span', {}, '왼쪽 드래그 회전 · 오른쪽 드래그 이동 · 휠 확대 · 링크 드래그로 관절 이동 · 클릭 선택 · 더블클릭 확대'),
      h('kbd', {}, 'F'), h('span', {}, '화면 맞춤'),
      h('kbd', {}, 'Esc'), h('span', {}, '선택 해제'),
      h('kbd', {}, 'Ctrl+O'), h('span', {}, '파일 열기'),
      h('kbd', {}, 'Ctrl+S'), h('span', {}, 'URDF 저장'),
      h('kbd', {}, 'Ctrl+Z / Ctrl+Y'), h('span', {}, '실행 취소 / 다시 실행 (속성 편집)'),
      h('kbd', {}, 'Ctrl+Enter'), h('span', {}, '코드 적용'),
      h('kbd', {}, 'Ctrl+F'), h('span', {}, '코드 찾기 / 바꾸기'),
    ),
    h('p', { style: { marginTop: '12px' } }, h('a', { href: 'https://github.com/samcho93/webURDF', target: '_blank', rel: 'noopener' }, 'github.com/samcho93/webURDF')),
    h('div', { class: 'buttons' }, h('button', { class: 'btn primary', type: 'submit', onclick: () => close() }, '닫기'))));
}

// ============================================================================
// Examples
// ============================================================================

async function initExamples() {
  try {
    const man = S.exampleManifest = await Src.loadManifest();
    const menu = $('#example-menu');
    menu.innerHTML = '';
    const welcome = $('#welcome-examples');
    welcome.innerHTML = '';
    for (const g of man.groups) {
      for (const e of g.entries) {
        menu.appendChild(h('button', { class: 'item', onclick: () => { closeMenus(); loadExample(g, e.path); } },
          h('div', {}, h('b', {}, `${g.name}`), ` — ${e.label}`, h('small', {}, `${g.repo ? g.repo.replace('https://github.com/', '') + ' · ' : ''}${e.path.split('/').pop()}`))));
      }
      welcome.appendChild(h('div', { class: 'ex-card', onclick: () => loadExample(g, g.entries[0].path) },
        h('b', {}, g.name), h('span', {}, g.description),
        h('div', { class: 'chips' }, g.entries.map((e) => h('span', { class: 'chip', title: e.path, onclick: (ev) => { ev.stopPropagation(); loadExample(g, e.path); } }, e.label)))));
    }
    return man;
  } catch (err) {
    $('#example-menu').innerHTML = '<div class="muted pad">예제 목록을 불러오지 못했습니다</div>';
    console.warn(err);
    return null;
  }
}

// ============================================================================
// Wiring
// ============================================================================

function closeMenus() { for (const m of $$('.menu-pop.open')) m.classList.remove('open'); }
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-menu]');
  if (trigger) {
    const pop = document.getElementById(trigger.dataset.menu);
    const open = pop.classList.contains('open');
    closeMenus();
    if (!open) pop.classList.add('open');
    e.stopPropagation();
    return;
  }
  if (!e.target.closest('.menu-pop') || e.target.closest('.menu-pop > button')) closeMenus();
});

function isTabActive(name) { return !!$(`.tab[data-tab="${name}"].active`); }
function activateTab(name) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  const panel = tab.closest('.panel');
  for (const t of $$('.tab', panel)) t.classList.toggle('active', t === tab);
  for (const b of $$('.tab-body', panel)) b.classList.toggle('active', b.dataset.body === name);
  if (name === 'graph') requestAnimationFrame(() => graph.fit());
  if (name === 'code') { editor.render(); if (S.selected) editor.reveal('link', S.selected); }
  try { localStorage.setItem(`webURDF.tab.${panel.id}`, name); } catch { /* ignore */ }
}
for (const t of $$('.tab')) t.addEventListener('click', () => activateTab(t.dataset.tab));

const ACTIONS = {
  'open-files': () => $('#file-input').click(),
  'open-folder': () => { $('#folder-input').dataset.mode = ''; $('#folder-input').click(); },
  'open-zip': () => $('#zip-input').click(),
  'add-files': () => $('#add-input').click(),
  'open-url': urlDialog,
  new: (el) => {
    const t = M.TEMPLATES[el.dataset.template];
    const vfs = new VFS('새 로봇');
    const name = `${el.dataset.template}.urdf`;
    vfs.addBlob(name, new Blob([t.text]));
    openVFS(vfs, { entry: name });
  },
  'save-urdf': () => { if (S.model) download(S.xacro ? basename(S.path) : robotFileName(), S.xacro ? S.source : S.urdf, 'text/xml'); },
  'save-zip': exportZip,
  'save-glb': async () => { try { download(robotFileName('.glb'), await viewer.exportGLB()); } catch (e) { toast(e.message, 'error'); } },
  'save-png': () => { const a = h('a', { href: viewer.screenshot(2), download: robotFileName('.png') }); a.click(); },
  'save-pose': exportPose,
  'load-pose': () => $('#pose-input').click(),
  'copy-link': async () => {
    const l = shareLink();
    if (!l) { toast('예제나 URL 로 연 모델만 링크로 공유할 수 있습니다 (로컬 파일은 브라우저 밖에 없음)', 'warn', 5000); return; }
    try { await navigator.clipboard.writeText(l); toast('공유 링크를 복사했습니다', 'ok'); } catch { prompt('링크', l); }
  },
  undo: () => undo(),
  redo: () => redo(),
  fit: () => viewer.fit(),
  theme: () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('webURDF.theme', next); } catch { /* ignore */ }
    viewer.setTheme(next === 'dark');
  },
  help: helpDialog,
  'toggle-left': () => $('#layout').classList.toggle('hide-left'),
  'toggle-right': () => $('#layout').classList.toggle('hide-right'),
  'joints-zero': () => setAllJoints((lo, hi) => Math.min(Math.max(0, lo), hi)),
  'joints-random': () => setAllJoints((lo, hi) => lo + Math.random() * (hi - lo)),
  'joints-animate': toggleAnimation,
  'code-apply': () => { applyCode.cancel(); if (editor.value !== S.source) setSource(editor.value, { fromEditor: true, record: true }); else rebuild({ fromEditor: true }); },
  'code-format': () => { const t = M.formatXML(editor.value); if (t !== editor.value) { editor.setValue(t); setSource(t, { fromEditor: true, record: true }); } },
  'code-find': () => { $('#find-bar').classList.toggle('show'); if ($('#find-bar').classList.contains('show')) $('#find-input').focus(); else editor.setMark(''); },
  'find-next': () => editor.findNext($('#find-input').value),
  'replace-one': () => editor.replaceOne($('#find-input').value, $('#replace-input').value),
  'replace-all': () => { const n = editor.replaceAll($('#find-input').value, $('#replace-input').value); toast(`${n}개 바꿈`); },
  'graph-fit': () => graph.fit(),
  'graph-svg': () => download(`${S.model?.name || 'robot'}_tree.svg`, graph.svgText(), 'image/svg+xml'),
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el); }
});
for (const b of $$('[data-view]')) b.addEventListener('click', () => viewer.setView(b.dataset.view));

$('#find-input').addEventListener('input', () => {
  const t = $('#find-input').value;
  editor.setMark(t);
  $('#find-count').textContent = t ? `${editor.count(t)}개` : '';
});
$('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.findNext($('#find-input').value); } });

// display options
for (const el of $$('[data-opt]')) {
  const key = el.dataset.opt;
  const read = () => (el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value);
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => { viewer.set(key, read()); saveOpts(); });
}
function saveOpts() {
  try { localStorage.setItem('webURDF.view', JSON.stringify(viewer.opts)); } catch { /* ignore */ }
}
function loadOpts() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem('webURDF.view') || 'null'); } catch { /* ignore */ }
  if (!o) return;
  for (const el of $$('[data-opt]')) {
    const key = el.dataset.opt;
    if (!(key in o)) continue;
    if (el.type === 'checkbox') el.checked = !!o[key]; else el.value = o[key];
    viewer.set(key, o[key]);
  }
}

$('#tree-filter').addEventListener('input', debounce(renderTree, 120));
$('#deg-toggle').addEventListener('change', () => { renderJoints(); renderProps(); renderInfo(); });
$('#ignore-limits').addEventListener('change', () => {
  if (S.robot) for (const j of Object.values(S.robot.joints)) j.ignoreLimits = $('#ignore-limits').checked;
  renderJoints();
});

// file inputs
$('#file-input').addEventListener('change', (e) => { loadFiles([...e.target.files], '로컬 파일'); e.target.value = ''; });
$('#folder-input').addEventListener('change', (e) => {
  const files = [...e.target.files];
  const mode = e.target.dataset.mode;
  e.target.value = '';
  if (mode === 'add') addFiles(files);
  else loadFiles(files, files[0]?.webkitRelativePath.split('/')[0] || '폴더');
});
$('#zip-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  progress('ZIP 푸는 중…');
  try { await openVFS(await Src.fromZip(f, f.name)); } catch (err) { toast(err.message, 'error'); } finally { progress(null); }
});
$('#add-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
$('#pose-input').addEventListener('change', (e) => { if (e.target.files[0]) importPose(e.target.files[0]); e.target.value = ''; });

// drag & drop anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop-overlay').classList.add('show'); e.preventDefault(); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.remove('show'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.remove('show');
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (!e.dataTransfer.files.length && /^https?:\/\//.test(text || '')) { loadURL(text.trim()); return; }
  progress('파일 읽는 중…');
  try {
    const vfs = await Src.fromDataTransfer(e.dataTransfer);
    // dropping only meshes onto an open model adds them
    if (S.model && !vfs.robotFiles().length) { S.vfs.merge(vfs); meshes.clear(); toast(`${vfs.size}개 파일을 추가했습니다`, 'ok'); await rebuild({ keepView: true }); renderFiles(); }
    else await openVFS(vfs);
  } catch (err) { toast(err.message, 'error'); } finally { progress(null); }
});

// paste a URL anywhere (outside inputs)
window.addEventListener('paste', (e) => {
  if (e.target.closest('input,textarea')) return;
  const t = e.clipboardData.getData('text').trim();
  if (/^https?:\/\/\S+$/.test(t)) loadURL(t);
  else if (/<robot[\s>]/.test(t)) {
    const vfs = new VFS('붙여넣기');
    vfs.addBlob('pasted.urdf', new Blob([t]));
    openVFS(vfs, { entry: 'pasted.urdf' });
  }
});

// viewer picks
viewer.addEventListener('pick', (e) => select(e.detail.link, { from: 'viewer' }));
viewer.addEventListener('grid', (e) => {
  const s = e.detail.step;
  $('#grid-note').textContent = `격자 ${s >= 1 ? s + ' m' : s >= 0.01 ? s * 100 + ' cm' : s * 1000 + ' mm'}`;
});

// undo / redo
async function undo() {
  const prev = S.history.pop();
  if (!prev) { toast('더 이상 되돌릴 수 없습니다'); return; }
  S.future.push({ source: S.source, xacro: S.xacro, path: S.path });
  S.path = prev.path;
  await setSource(prev.source, { record: false });
}
async function redo() {
  const next = S.future.pop();
  if (!next) return;
  S.history.push({ source: S.source, xacro: S.xacro, path: S.path });
  S.path = next.path;
  await setSource(next.source, { record: false });
}

// keyboard
window.addEventListener('keydown', (e) => {
  const inField = e.target.closest('input,textarea,select');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); ACTIONS['open-files'](); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); ACTIONS['save-urdf'](); return; }
  if (mod && e.key === 'Enter' && e.target.id === 'code') { e.preventDefault(); ACTIONS['code-apply'](); return; }
  if (mod && e.key.toLowerCase() === 'f' && isTabActive('code')) { e.preventDefault(); $('#find-bar').classList.add('show'); $('#find-input').focus(); $('#find-input').select(); return; }
  if (inField) return;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (e.key === 'f' || e.key === 'F') viewer.fit();
  else if (e.key === 'Escape') select(null);
  else if (e.key === '?') helpDialog();
});

// panel resizers
for (const r of $$('.resizer')) {
  r.addEventListener('pointerdown', (e) => {
    const side = r.dataset.resize;
    const startX = e.clientX;
    const panel = side === 'left' ? $('#left-panel') : $('#right-panel');
    const startW = panel.getBoundingClientRect().width;
    r.classList.add('active');
    r.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.max(200, Math.min(700, startW + (side === 'left' ? ev.clientX - startX : startX - ev.clientX)));
      document.documentElement.style.setProperty(side === 'left' ? '--left-w' : '--right-w', `${w}px`);
    };
    const up = () => { r.classList.remove('active'); r.removeEventListener('pointermove', move); r.removeEventListener('pointerup', up); graph.fit(); };
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up);
  });
}

// ============================================================================
// Boot
// ============================================================================

(async function boot() {
  try {
    const t = localStorage.getItem('webURDF.theme');
    if (t) document.documentElement.dataset.theme = t;
    for (const p of ['left-panel', 'right-panel']) { const tab = localStorage.getItem(`webURDF.tab.${p}`); if (tab) activateTab(tab); }
  } catch { /* ignore */ }
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  viewer.setTheme(dark);
  loadOpts();
  renderProps();
  const man = await initExamples();
  const q = new URLSearchParams(location.search);
  if (q.get('url')) loadURL(q.get('url'));
  else if (q.get('example') && man) {
    const g = man.groups.find((x) => x.id === q.get('example'));
    if (g) loadExample(g, q.get('file') || null);
  }
  window.webURDF = { S, viewer, meshes, loadFiles, loadURL, openVFS }; // for debugging from the console
})();
