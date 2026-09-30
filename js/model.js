// model.js — URDF document model: structure extraction, validation, statistics,
// editing helpers and XML formatting. Works on a DOM Document so edits keep
// comments and unknown tags (gazebo, transmission, ros2_control…) intact.

export const JOINT_TYPES = ['revolute', 'continuous', 'prismatic', 'fixed', 'floating', 'planar'];
export const MOVABLE = new Set(['revolute', 'continuous', 'prismatic']);

const kids = (el, tag) => [...el.children].filter((c) => c.tagName === tag);
const kid = (el, tag) => kids(el, tag)[0] || null;
export const vec = (s, n = 3, def = 0) => {
  const a = String(s ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
  return Array.from({ length: n }, (_, i) => (Number.isFinite(a[i]) ? a[i] : def));
};
export const fmt = (v) => {
  if (!Number.isFinite(v)) return String(v);
  let s = (+v.toPrecision(10)).toString();
  if (s.includes('e')) s = v.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};
export const fmtVec = (a) => a.map(fmt).join(' ');

export function readOrigin(el) {
  const o = el && kid(el, 'origin');
  return { xyz: vec(o?.getAttribute('xyz')), rpy: vec(o?.getAttribute('rpy')), el: o };
}

function readGeometry(g) {
  const c = g && g.children[0];
  if (!c) return { type: 'none' };
  const t = c.tagName;
  if (t === 'box') return { type: t, size: vec(c.getAttribute('size')) };
  if (t === 'sphere') return { type: t, radius: +c.getAttribute('radius') || 0 };
  if (t === 'cylinder' || t === 'capsule') return { type: t, radius: +c.getAttribute('radius') || 0, length: +c.getAttribute('length') || 0 };
  if (t === 'mesh') return { type: t, filename: c.getAttribute('filename') || '', scale: c.hasAttribute('scale') ? vec(c.getAttribute('scale'), 3, 1) : null };
  return { type: t };
}

export function extract(doc) {
  const robot = doc.documentElement;
  const model = {
    name: robot.getAttribute('name') || '',
    links: [], joints: [], materials: new Map(),
    linkMap: new Map(), jointMap: new Map(), childJoint: new Map(), childrenOf: new Map(),
    roots: [], other: [],
  };
  for (const m of kids(robot, 'material')) {
    const c = kid(m, 'color');
    model.materials.set(m.getAttribute('name'), { rgba: c ? vec(c.getAttribute('rgba'), 4, 1) : null, texture: kid(m, 'texture')?.getAttribute('filename') || null, el: m });
  }
  for (const l of kids(robot, 'link')) {
    const inertialEl = kid(l, 'inertial');
    let inertial = null;
    if (inertialEl) {
      const I = kid(inertialEl, 'inertia');
      const g = (k) => +(I?.getAttribute(k) ?? 0) || 0;
      inertial = {
        ...readOrigin(inertialEl),
        mass: +(kid(inertialEl, 'mass')?.getAttribute('value') ?? 0) || 0,
        I: { ixx: g('ixx'), ixy: g('ixy'), ixz: g('ixz'), iyy: g('iyy'), iyz: g('iyz'), izz: g('izz') },
        el: inertialEl,
      };
    }
    const shape = (el) => {
      const mat = kid(el, 'material');
      let rgba = null, matName = mat?.getAttribute('name') || null;
      const col = mat && kid(mat, 'color');
      if (col) rgba = vec(col.getAttribute('rgba'), 4, 1);
      return { name: el.getAttribute('name') || '', ...readOrigin(el), geometry: readGeometry(kid(el, 'geometry')), material: matName, rgba, el };
    };
    const link = {
      name: l.getAttribute('name') || '', el: l, inertial,
      visuals: kids(l, 'visual').map(shape), collisions: kids(l, 'collision').map(shape),
    };
    model.links.push(link);
    model.linkMap.set(link.name, link);
  }
  for (const j of kids(robot, 'joint')) {
    const lim = kid(j, 'limit'), dyn = kid(j, 'dynamics'), mim = kid(j, 'mimic'), ax = kid(j, 'axis');
    const num = (el, k) => (el && el.hasAttribute(k) ? +el.getAttribute(k) : null);
    const joint = {
      name: j.getAttribute('name') || '', type: j.getAttribute('type') || '', el: j,
      parent: kid(j, 'parent')?.getAttribute('link') || '', child: kid(j, 'child')?.getAttribute('link') || '',
      ...readOrigin(j),
      axis: ax ? vec(ax.getAttribute('xyz')) : [1, 0, 0], hasAxis: !!ax,
      limit: lim ? { lower: num(lim, 'lower'), upper: num(lim, 'upper'), effort: num(lim, 'effort'), velocity: num(lim, 'velocity') } : null,
      dynamics: dyn ? { damping: num(dyn, 'damping'), friction: num(dyn, 'friction') } : null,
      mimic: mim ? { joint: mim.getAttribute('joint'), multiplier: num(mim, 'multiplier') ?? 1, offset: num(mim, 'offset') ?? 0 } : null,
    };
    model.joints.push(joint);
    model.jointMap.set(joint.name, joint);
    if (!model.childJoint.has(joint.child)) model.childJoint.set(joint.child, joint);
    if (!model.childrenOf.has(joint.parent)) model.childrenOf.set(joint.parent, []);
    model.childrenOf.get(joint.parent).push(joint);
  }
  model.roots = model.links.filter((l) => !model.childJoint.has(l.name)).map((l) => l.name);
  model.other = [...robot.children].filter((c) => !['link', 'joint', 'material'].includes(c.tagName)).map((c) => c.tagName);
  return model;
}

// depth-first order of links from the root(s)
export function walk(model, fn) {
  const seen = new Set();
  const visit = (name, depth, joint) => {
    if (seen.has(name)) return;
    seen.add(name);
    fn(name, depth, joint);
    for (const j of model.childrenOf.get(name) || []) visit(j.child, depth + 1, j);
  };
  for (const r of model.roots) visit(r, 0, null);
  return seen;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validate(model, { meshStatus = new Map() } = {}) {
  const out = [];
  const add = (level, msg, target = null) => out.push({ level, msg, target });

  if (!model.name) add('warn', '<robot> 에 name 속성이 없습니다.');
  if (!model.links.length) add('error', '링크가 하나도 없습니다.');

  const dup = (arr, what) => {
    const seen = new Set();
    for (const x of arr) {
      if (!x.name) add('error', `이름 없는 ${what}이(가) 있습니다.`);
      else if (seen.has(x.name)) add('error', `${what} 이름 중복: "${x.name}"`, { kind: what === '링크' ? 'link' : 'joint', name: x.name });
      seen.add(x.name);
    }
  };
  dup(model.links, '링크');
  dup(model.joints, '조인트');

  const childCount = new Map();
  for (const j of model.joints) {
    const t = { kind: 'joint', name: j.name };
    if (!JOINT_TYPES.includes(j.type)) add('error', `조인트 "${j.name}": 알 수 없는 타입 "${j.type}"`, t);
    if (!j.parent) add('error', `조인트 "${j.name}": <parent> 누락`, t);
    else if (!model.linkMap.has(j.parent)) add('error', `조인트 "${j.name}": 부모 링크 "${j.parent}" 가 없습니다.`, t);
    if (!j.child) add('error', `조인트 "${j.name}": <child> 누락`, t);
    else if (!model.linkMap.has(j.child)) add('error', `조인트 "${j.name}": 자식 링크 "${j.child}" 가 없습니다.`, t);
    if (j.parent && j.parent === j.child) add('error', `조인트 "${j.name}": 부모와 자식이 같습니다.`, t);
    childCount.set(j.child, (childCount.get(j.child) || 0) + 1);
    if ((j.type === 'revolute' || j.type === 'prismatic')) {
      if (!j.limit) add('error', `조인트 "${j.name}" (${j.type}): <limit> 이 필요합니다.`, t);
      else {
        if (j.limit.effort == null) add('warn', `조인트 "${j.name}": limit effort 누락`, t);
        if (j.limit.velocity == null) add('warn', `조인트 "${j.name}": limit velocity 누락`, t);
        if (j.limit.lower != null && j.limit.upper != null && j.limit.lower > j.limit.upper) add('error', `조인트 "${j.name}": lower(${j.limit.lower}) > upper(${j.limit.upper})`, t);
        if (j.limit.lower == null && j.limit.upper == null) add('info', `조인트 "${j.name}": lower/upper 가 없어 0 으로 간주됩니다.`, t);
      }
    }
    if (MOVABLE.has(j.type) || j.type === 'planar') {
      const n = Math.hypot(...j.axis);
      if (n < 1e-9) add('error', `조인트 "${j.name}": axis 가 0 벡터입니다.`, t);
      else if (Math.abs(n - 1) > 1e-3) add('warn', `조인트 "${j.name}": axis 가 단위 벡터가 아닙니다 (|a|=${fmt(n)}).`, t);
    }
    if (j.mimic) {
      if (!model.jointMap.has(j.mimic.joint)) add('error', `조인트 "${j.name}": mimic 대상 "${j.mimic.joint}" 가 없습니다.`, t);
    }
  }
  for (const [c, n] of childCount) if (n > 1) add('error', `링크 "${c}" 가 여러 조인트의 자식입니다 (${n}개) — 트리 구조가 아닙니다.`, { kind: 'link', name: c });

  if (model.roots.length > 1) add('error', `루트 링크가 ${model.roots.length}개입니다: ${model.roots.join(', ')} — 하나의 트리로 연결되어야 합니다.`);
  if (model.links.length && !model.roots.length) add('error', '루트 링크가 없습니다 (순환 구조).');
  const reached = walk(model, () => {});
  const unreached = model.links.filter((l) => !reached.has(l.name));
  if (unreached.length && model.roots.length) add('error', `루트에서 도달할 수 없는 링크(순환): ${unreached.map((l) => l.name).join(', ')}`);

  for (const l of model.links) {
    const t = { kind: 'link', name: l.name };
    const root = model.roots[0] === l.name;
    if (l.inertial) {
      const { mass, I } = l.inertial;
      if (mass <= 0) add(root ? 'info' : 'warn', `링크 "${l.name}": 질량이 0 이하 (${mass})`, t);
      const ev = eigenSym3(inertiaMatrix(I)).values;
      if (ev.some((v) => v < -1e-12)) add('error', `링크 "${l.name}": 관성 행렬이 양의 정부호가 아닙니다.`, t);
      else if (mass > 0) {
        const [a, b, c] = ev;
        const tol = 1e-9 + 1e-6 * (a + b + c);
        if (a + b < c - tol || a + c < b - tol || b + c < a - tol) add('warn', `링크 "${l.name}": 관성 모멘트가 삼각 부등식을 만족하지 않습니다 (물리적으로 불가능).`, t);
        if (ev.every((v) => v === 0)) add('warn', `링크 "${l.name}": 관성 텐서가 모두 0 입니다.`, t);
      }
    } else if (!root && (l.visuals.length || l.collisions.length)) {
      add('info', `링크 "${l.name}": <inertial> 없음 — 시뮬레이터(Gazebo 등)에서 무시될 수 있습니다.`, t);
    }
    for (const s of [...l.visuals, ...l.collisions]) {
      const g = s.geometry;
      if (g.type === 'none') add('error', `링크 "${l.name}": geometry 가 비어 있습니다.`, t);
      if (g.type === 'mesh') {
        if (!g.filename) add('error', `링크 "${l.name}": mesh filename 누락`, t);
        const st = meshStatus.get(g.filename);
        if (st && st.error) add('error', `링크 "${l.name}": 메시 로드 실패 — ${g.filename}`, t);
        else if (st && st.fuzzy) add('info', `링크 "${l.name}": ${g.filename} → ${st.path} (이름으로 추정 매칭)`, t);
      }
      if ((g.type === 'box' && g.size.some((v) => v <= 0)) || ((g.type === 'sphere' || g.type === 'cylinder') && g.radius <= 0)) add('warn', `링크 "${l.name}": 크기가 0 이하인 기본 도형`, t);
      if (s.material && !s.rgba && !model.materials.has(s.material) && s.el.tagName === 'visual') {
        const matEl = [...s.el.children].find((c) => c.tagName === 'material');
        if (matEl && !matEl.children.length) add('warn', `링크 "${l.name}": 정의되지 않은 재질 "${s.material}"`, t);
      }
    }
  }
  if (!out.some((x) => x.level === 'error')) add('ok', `구조 검사 통과 — 링크 ${model.links.length}개, 조인트 ${model.joints.length}개`);
  return out;
}

// ---------------------------------------------------------------------------
// Statistics & mass properties
// ---------------------------------------------------------------------------

export function inertiaMatrix(I) {
  return [[I.ixx, I.ixy, I.ixz], [I.ixy, I.iyy, I.iyz], [I.ixz, I.iyz, I.izz]];
}

// Jacobi eigenvalue decomposition of a symmetric 3x3 matrix.
export function eigenSym3(A) {
  const a = A.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v }; // columns of v are eigenvectors
}

export function stats(model) {
  let mass = 0, depth = 0, meshes = 0, prims = 0, collisions = 0;
  const types = {};
  for (const j of model.joints) types[j.type] = (types[j.type] || 0) + 1;
  for (const l of model.links) {
    if (l.inertial) mass += l.inertial.mass;
    for (const v of l.visuals) (v.geometry.type === 'mesh' ? meshes++ : prims++);
    collisions += l.collisions.length;
  }
  walk(model, (_, d) => { depth = Math.max(depth, d); });
  const dof = model.joints.filter((j) => MOVABLE.has(j.type) && !j.mimic).length;
  return { links: model.links.length, joints: model.joints.length, dof, mass, depth, meshes, prims, collisions, types, materials: model.materials.size };
}

// ---------------------------------------------------------------------------
// Editing helpers (mutate the DOM document)
// ---------------------------------------------------------------------------

function ensure(parent, tag, before = null) {
  let el = kid(parent, tag);
  if (!el) {
    el = parent.ownerDocument.createElement(tag);
    const ref = before ? kid(parent, before) : null;
    parent.insertBefore(el, ref);
  }
  return el;
}

export function setOrigin(el, xyz, rpy) {
  const o = ensure(el, 'origin', el.tagName === 'joint' ? 'parent' : 'geometry');
  if (el.tagName === 'joint' && o.nextSibling == null) el.insertBefore(o, el.firstChild);
  o.setAttribute('xyz', fmtVec(xyz));
  o.setAttribute('rpy', fmtVec(rpy));
}

export function setJoint(model, name, patch) {
  const j = model.jointMap.get(name);
  if (!j) return;
  const el = j.el;
  if (patch.type) el.setAttribute('type', patch.type);
  if (patch.xyz || patch.rpy) setOrigin(el, patch.xyz || j.xyz, patch.rpy || j.rpy);
  if (patch.axis) ensure(el, 'axis').setAttribute('xyz', fmtVec(patch.axis));
  if (patch.limit) {
    const lim = ensure(el, 'limit');
    for (const [k, v] of Object.entries(patch.limit)) {
      if (v === null || v === '' || Number.isNaN(v)) lim.removeAttribute(k); else lim.setAttribute(k, fmt(+v));
    }
  }
  if (patch.dynamics) {
    const d = ensure(el, 'dynamics');
    for (const [k, v] of Object.entries(patch.dynamics)) {
      if (v === null || v === '' || Number.isNaN(v)) d.removeAttribute(k); else d.setAttribute(k, fmt(+v));
    }
    if (!d.attributes.length) d.remove();
  }
  const type = patch.type || j.type;
  if (type === 'fixed' || type === 'floating') {
    // axis/limit are meaningless for these types
    kid(el, 'axis')?.remove();
  }
  if ((type === 'revolute' || type === 'prismatic') && !kid(el, 'limit')) {
    const lim = ensure(el, 'limit');
    lim.setAttribute('lower', type === 'revolute' ? '-3.14159' : '0');
    lim.setAttribute('upper', type === 'revolute' ? '3.14159' : '0.1');
    lim.setAttribute('effort', '10');
    lim.setAttribute('velocity', '1');
  }
  if ((MOVABLE.has(type) || type === 'planar') && !kid(el, 'axis')) ensure(el, 'axis').setAttribute('xyz', '0 0 1');
}

export function renameLink(model, oldName, newName) {
  const l = model.linkMap.get(oldName);
  if (!l || !newName || oldName === newName) return false;
  if (model.linkMap.has(newName)) throw new Error(`이미 존재하는 링크 이름: ${newName}`);
  l.el.setAttribute('name', newName);
  for (const j of model.joints) {
    if (j.parent === oldName) kid(j.el, 'parent').setAttribute('link', newName);
    if (j.child === oldName) kid(j.el, 'child').setAttribute('link', newName);
  }
  for (const g of l.el.ownerDocument.querySelectorAll(`gazebo[reference="${CSS.escape(oldName)}"]`)) g.setAttribute('reference', newName);
  return true;
}

export function renameJoint(model, oldName, newName) {
  const j = model.jointMap.get(oldName);
  if (!j || !newName || oldName === newName) return false;
  if (model.jointMap.has(newName)) throw new Error(`이미 존재하는 조인트 이름: ${newName}`);
  j.el.setAttribute('name', newName);
  for (const o of model.joints) if (o.mimic?.joint === oldName) kid(o.el, 'mimic').setAttribute('joint', newName);
  const doc = j.el.ownerDocument;
  for (const t of doc.querySelectorAll('transmission joint, ros2_control joint')) if (t.getAttribute('name') === oldName) t.setAttribute('name', newName);
  return true;
}

export function uniqueName(existing, base) {
  if (!existing.has(base)) return base;
  let i = 1;
  while (existing.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function addChildLink(model, parentName, opts = {}) {
  const doc = model.links[0]?.el.ownerDocument || opts.doc;
  const robot = doc.documentElement;
  const linkName = uniqueName(model.linkMap, opts.name || 'new_link');
  const jointName = uniqueName(model.jointMap, opts.jointName || `${parentName}_to_${linkName}`);
  const type = opts.type || 'revolute';
  const geom = opts.geometry || '<box size="0.05 0.05 0.1"/>';
  const color = opts.color || '0.3 0.6 0.9 1';
  const linkXml = `<link name="${linkName}">
    <visual>
      <origin xyz="0 0 0.05" rpy="0 0 0"/>
      <geometry>${geom}</geometry>
      <material name="${linkName}_color"><color rgba="${color}"/></material>
    </visual>
    <collision>
      <origin xyz="0 0 0.05" rpy="0 0 0"/>
      <geometry>${geom}</geometry>
    </collision>
    <inertial>
      <origin xyz="0 0 0.05" rpy="0 0 0"/>
      <mass value="0.1"/>
      <inertia ixx="0.0001" ixy="0" ixz="0" iyy="0.0001" iyz="0" izz="0.00005"/>
    </inertial>
  </link>`;
  const lim = type === 'revolute' ? '\n    <limit lower="-1.5708" upper="1.5708" effort="10" velocity="1"/>'
    : type === 'prismatic' ? '\n    <limit lower="0" upper="0.1" effort="10" velocity="0.5"/>' : '';
  const axis = MOVABLE.has(type) ? '\n    <axis xyz="0 0 1"/>' : '';
  const jointXml = `<joint name="${jointName}" type="${type}">
    <origin xyz="${opts.xyz || '0 0 0.1'}" rpy="0 0 0"/>
    <parent link="${parentName}"/>
    <child link="${linkName}"/>${axis}${lim}
  </joint>`;
  const frag = new DOMParser().parseFromString(`<r>${linkXml}${jointXml}</r>`, 'application/xml').documentElement;
  // insert after the parent's joint/link block to keep the file readable
  let anchor = null;
  const parentJoint = model.childrenOf.get(parentName)?.slice(-1)[0];
  if (parentJoint) anchor = parentJoint.el;
  for (const n of [...frag.children]) {
    const imp = doc.importNode(n, true);
    if (anchor && anchor.parentNode === robot) { robot.insertBefore(imp, anchor.nextSibling); anchor = imp; }
    else robot.appendChild(imp);
  }
  return { linkName, jointName };
}

// Remove a link, its whole subtree and connecting joints.
export function removeLinkSubtree(model, name) {
  const removed = [];
  const visit = (n) => {
    for (const j of model.childrenOf.get(n) || []) { visit(j.child); j.el.remove(); removed.push(j.name); }
    const l = model.linkMap.get(n);
    if (l) { l.el.remove(); removed.push(n); }
  };
  visit(name);
  const pj = model.childJoint.get(name);
  if (pj) pj.el.remove();
  return removed;
}

export function setGeometry(shapeEl, geom) {
  const doc = shapeEl.ownerDocument;
  const g = ensure(shapeEl, 'geometry');
  while (g.firstChild) g.removeChild(g.firstChild);
  const el = doc.createElement(geom.type);
  if (geom.type === 'box') el.setAttribute('size', fmtVec(geom.size));
  if (geom.type === 'sphere') el.setAttribute('radius', fmt(geom.radius));
  if (geom.type === 'cylinder' || geom.type === 'capsule') { el.setAttribute('radius', fmt(geom.radius)); el.setAttribute('length', fmt(geom.length)); }
  if (geom.type === 'mesh') { el.setAttribute('filename', geom.filename || ''); if (geom.scale) el.setAttribute('scale', fmtVec(geom.scale)); }
  g.appendChild(el);
}

export function setShapeColor(shapeEl, rgba) {
  const doc = shapeEl.ownerDocument;
  let m = kid(shapeEl, 'material');
  if (!m) { m = doc.createElement('material'); m.setAttribute('name', ''); shapeEl.appendChild(m); }
  let c = kid(m, 'color');
  if (!c) { c = doc.createElement('color'); m.appendChild(c); }
  c.setAttribute('rgba', fmtVec(rgba));
}

export function setInertial(linkEl, { mass, xyz, rpy, I }) {
  const doc = linkEl.ownerDocument;
  const inr = ensure(linkEl, 'inertial');
  setOrigin(inr, xyz, rpy);
  const m = ensure(inr, 'mass');
  m.setAttribute('value', fmt(mass));
  const i = ensure(inr, 'inertia');
  for (const k of ['ixx', 'ixy', 'ixz', 'iyy', 'iyz', 'izz']) i.setAttribute(k, fmt(I[k]));
  // keep order origin, mass, inertia
  inr.appendChild(m); inr.appendChild(i);
  void doc;
}

// Inertia tensor of a solid primitive about its own center.
export function primitiveInertia(geom, mass) {
  const m = mass;
  if (geom.type === 'box') {
    const [x, y, z] = geom.size;
    return { ixx: m / 12 * (y * y + z * z), iyy: m / 12 * (x * x + z * z), izz: m / 12 * (x * x + y * y), ixy: 0, ixz: 0, iyz: 0 };
  }
  if (geom.type === 'sphere') { const v = 0.4 * m * geom.radius ** 2; return { ixx: v, iyy: v, izz: v, ixy: 0, ixz: 0, iyz: 0 }; }
  if (geom.type === 'cylinder' || geom.type === 'capsule') {
    const r = geom.radius, h = geom.length;
    const a = m / 12 * (3 * r * r + h * h);
    return { ixx: a, iyy: a, izz: 0.5 * m * r * r, ixy: 0, ixz: 0, iyz: 0 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// XML formatting
// ---------------------------------------------------------------------------

export function serialize(doc) {
  let s = new XMLSerializer().serializeToString(doc);
  if (!s.startsWith('<?xml')) s = '<?xml version="1.0"?>\n' + s;
  return s.replace(/\?>\s*</, '?>\n<') + (s.endsWith('\n') ? '' : '\n');
}

// Re-indent the whole document with two spaces. Comments are kept.
export function formatXML(text, indent = '  ') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return text;
  const lines = [];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escA = (s) => esc(s).replace(/"/g, '&quot;');
  const open = (el) => `<${el.nodeName}${[...el.attributes].map((a) => ` ${a.name}="${escA(a.value)}"`).join('')}`;
  const rec = (node, depth) => {
    const pad = indent.repeat(depth);
    if (node.nodeType === 8) { lines.push(`${pad}<!--${node.nodeValue}-->`); return; }
    if (node.nodeType === 4) { lines.push(`${pad}<![CDATA[${node.nodeValue}]]>`); return; }
    if (node.nodeType === 3) { const t = node.nodeValue.trim(); if (t) lines.push(pad + esc(t)); return; }
    if (node.nodeType !== 1) return;
    const children = [...node.childNodes].filter((c) => !(c.nodeType === 3 && !c.nodeValue.trim()));
    if (!children.length) { lines.push(`${pad}${open(node)}/>`); return; }
    if (children.length === 1 && children[0].nodeType === 3) {
      lines.push(`${pad}${open(node)}>${esc(children[0].nodeValue.trim())}</${node.nodeName}>`); return;
    }
    lines.push(`${pad}${open(node)}>`);
    let prevTag = null;
    for (const c of children) {
      // blank line between top-level link/joint blocks for readability
      if (depth === 0 && c.nodeType === 1 && prevTag && (c.nodeName === 'link' || c.nodeName === 'joint')) lines.push('');
      rec(c, depth + 1);
      if (c.nodeType === 1) prevTag = c.nodeName;
    }
    lines.push(`${pad}</${node.nodeName}>`);
  };
  for (const n of doc.childNodes) rec(n, 0);
  return '<?xml version="1.0"?>\n' + lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Templates for "new robot"
// ---------------------------------------------------------------------------

export const TEMPLATES = {
  blank: { name: '빈 로봇', text: `<?xml version="1.0"?>
<robot name="my_robot">
  <link name="base_link">
    <visual>
      <geometry><box size="0.2 0.2 0.05"/></geometry>
      <material name="gray"><color rgba="0.6 0.6 0.6 1"/></material>
    </visual>
  </link>
</robot>
` },
  arm: { name: '2축 로봇팔', text: `<?xml version="1.0"?>
<robot name="two_link_arm">
  <material name="base"><color rgba="0.25 0.25 0.28 1"/></material>
  <material name="arm"><color rgba="0.95 0.55 0.15 1"/></material>

  <link name="base_link">
    <visual>
      <origin xyz="0 0 0.025"/>
      <geometry><cylinder radius="0.08" length="0.05"/></geometry>
      <material name="base"/>
    </visual>
    <collision>
      <origin xyz="0 0 0.025"/>
      <geometry><cylinder radius="0.08" length="0.05"/></geometry>
    </collision>
    <inertial>
      <origin xyz="0 0 0.025"/>
      <mass value="1.0"/>
      <inertia ixx="0.0018" ixy="0" ixz="0" iyy="0.0018" iyz="0" izz="0.0032"/>
    </inertial>
  </link>

  <joint name="shoulder" type="revolute">
    <origin xyz="0 0 0.05" rpy="0 0 0"/>
    <parent link="base_link"/>
    <child link="upper_arm"/>
    <axis xyz="0 1 0"/>
    <limit lower="-1.57" upper="1.57" effort="20" velocity="2"/>
  </joint>

  <link name="upper_arm">
    <visual>
      <origin xyz="0 0 0.15"/>
      <geometry><box size="0.04 0.04 0.3"/></geometry>
      <material name="arm"/>
    </visual>
    <collision>
      <origin xyz="0 0 0.15"/>
      <geometry><box size="0.04 0.04 0.3"/></geometry>
    </collision>
    <inertial>
      <origin xyz="0 0 0.15"/>
      <mass value="0.5"/>
      <inertia ixx="0.003817" ixy="0" ixz="0" iyy="0.003817" iyz="0" izz="0.000133"/>
    </inertial>
  </link>

  <joint name="elbow" type="revolute">
    <origin xyz="0 0 0.3" rpy="0 0 0"/>
    <parent link="upper_arm"/>
    <child link="forearm"/>
    <axis xyz="0 1 0"/>
    <limit lower="-2.5" upper="2.5" effort="10" velocity="2"/>
  </joint>

  <link name="forearm">
    <visual>
      <origin xyz="0 0 0.125"/>
      <geometry><box size="0.03 0.03 0.25"/></geometry>
      <material name="arm"/>
    </visual>
    <collision>
      <origin xyz="0 0 0.125"/>
      <geometry><box size="0.03 0.03 0.25"/></geometry>
    </collision>
    <inertial>
      <origin xyz="0 0 0.125"/>
      <mass value="0.3"/>
      <inertia ixx="0.001585" ixy="0" ixz="0" iyy="0.001585" iyz="0" izz="0.000045"/>
    </inertial>
  </link>
</robot>
` },
  car: { name: '차동 구동 모바일 로봇', text: `<?xml version="1.0"?>
<robot name="diff_drive">
  <material name="body"><color rgba="0.15 0.45 0.85 1"/></material>
  <material name="tire"><color rgba="0.1 0.1 0.1 1"/></material>

  <link name="base_link">
    <visual>
      <origin xyz="0 0 0.06"/>
      <geometry><box size="0.3 0.2 0.08"/></geometry>
      <material name="body"/>
    </visual>
    <collision>
      <origin xyz="0 0 0.06"/>
      <geometry><box size="0.3 0.2 0.08"/></geometry>
    </collision>
    <inertial>
      <origin xyz="0 0 0.06"/>
      <mass value="2.0"/>
      <inertia ixx="0.00773" ixy="0" ixz="0" iyy="0.01607" iyz="0" izz="0.02167"/>
    </inertial>
  </link>

  <joint name="left_wheel_joint" type="continuous">
    <origin xyz="0.05 0.12 0.05" rpy="-1.5708 0 0"/>
    <parent link="base_link"/>
    <child link="left_wheel"/>
    <axis xyz="0 0 1"/>
  </joint>
  <link name="left_wheel">
    <visual>
      <geometry><cylinder radius="0.05" length="0.03"/></geometry>
      <material name="tire"/>
    </visual>
    <collision>
      <geometry><cylinder radius="0.05" length="0.03"/></geometry>
    </collision>
    <inertial>
      <mass value="0.2"/>
      <inertia ixx="0.00014" ixy="0" ixz="0" iyy="0.00014" iyz="0" izz="0.00025"/>
    </inertial>
  </link>

  <joint name="right_wheel_joint" type="continuous">
    <origin xyz="0.05 -0.12 0.05" rpy="-1.5708 0 0"/>
    <parent link="base_link"/>
    <child link="right_wheel"/>
    <axis xyz="0 0 1"/>
  </joint>
  <link name="right_wheel">
    <visual>
      <geometry><cylinder radius="0.05" length="0.03"/></geometry>
      <material name="tire"/>
    </visual>
    <collision>
      <geometry><cylinder radius="0.05" length="0.03"/></geometry>
    </collision>
    <inertial>
      <mass value="0.2"/>
      <inertia ixx="0.00014" ixy="0" ixz="0" iyy="0.00014" iyz="0" izz="0.00025"/>
    </inertial>
  </link>

  <joint name="caster_joint" type="fixed">
    <origin xyz="-0.11 0 0.02"/>
    <parent link="base_link"/>
    <child link="caster"/>
  </joint>
  <link name="caster">
    <visual>
      <geometry><sphere radius="0.02"/></geometry>
      <material name="tire"/>
    </visual>
    <collision>
      <geometry><sphere radius="0.02"/></geometry>
    </collision>
    <inertial>
      <mass value="0.05"/>
      <inertia ixx="0.000008" ixy="0" ixz="0" iyy="0.000008" iyz="0" izz="0.000008"/>
    </inertial>
  </link>
</robot>
` },
};
