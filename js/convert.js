// convert.js — URDF → MJCF (MuJoCo) conversion of the kinematic tree.
import * as THREE from 'three';
import { MOVABLE } from './model.js';
import { basename } from './vfs.js';

const f = (v) => {
  const s = (+(+v).toPrecision(8)).toString();
  return s === '-0' ? '0' : s;
};
const fv = (a) => a.map(f).join(' ');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function quat(rpy) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
  return [q.w, q.x, q.y, q.z];
}
const isIdentity = (rpy) => rpy.every((v) => Math.abs(v) < 1e-12);
const isZero = (xyz) => xyz.every((v) => Math.abs(v) < 1e-12);

// meshStatus: ref -> { path } resolved paths (used for the <asset> file names)
export function toMJCF(model, { meshStatus = new Map() } = {}) {
  const warnings = [];
  const assets = new Map(); // key -> { name, file, scale }
  const lines = [];
  const out = (depth, s) => lines.push('  '.repeat(depth) + s);

  const meshAsset = (g) => {
    const resolved = meshStatus.get(g.filename)?.path || g.filename.replace(/^package:\/\/[^/]+\//, '').replace(/^file:\/\//, '');
    if (/\.(dae|glb|gltf|ply)$/i.test(resolved)) warnings.push(`MuJoCo 는 ${resolved.split('.').pop().toUpperCase()} 메시를 직접 읽지 못합니다: ${resolved} (STL/OBJ 로 변환 필요)`);
    const scale = g.scale || [1, 1, 1];
    const key = resolved + '|' + scale.join(',');
    if (!assets.has(key)) {
      let name = basename(resolved).replace(/\.[^.]+$/, '');
      const used = new Set([...assets.values()].map((a) => a.name));
      let n = name, i = 1;
      while (used.has(n)) n = `${name}_${i++}`;
      assets.set(key, { name: n, file: resolved, scale });
    }
    return assets.get(key).name;
  };

  const geom = (depth, s, kind, linkName, idx) => {
    const g = s.geometry;
    const attrs = [`name="${esc(`${linkName}_${kind}${idx}`)}"`];
    if (g.type === 'box') attrs.push('type="box"', `size="${fv(g.size.map((v) => v / 2))}"`);
    else if (g.type === 'cylinder') attrs.push('type="cylinder"', `size="${f(g.radius)} ${f(g.length / 2)}"`);
    else if (g.type === 'capsule') attrs.push('type="capsule"', `size="${f(g.radius)} ${f(g.length / 2)}"`);
    else if (g.type === 'sphere') attrs.push('type="sphere"', `size="${f(g.radius)}"`);
    else if (g.type === 'mesh') attrs.push('type="mesh"', `mesh="${esc(meshAsset(g))}"`);
    else { warnings.push(`${linkName}: 지원하지 않는 형상 ${g.type}`); return; }
    if (!isZero(s.xyz)) attrs.push(`pos="${fv(s.xyz)}"`);
    if (!isIdentity(s.rpy)) attrs.push(`quat="${fv(quat(s.rpy))}"`);
    if (kind === 'visual') {
      const rgba = s.rgba || model.materials.get(s.material)?.rgba;
      if (rgba) attrs.push(`rgba="${fv(rgba)}"`);
      attrs.push('class="visual"');
    } else attrs.push('class="collision"');
    out(depth, `<geom ${attrs.join(' ')}/>`);
  };

  const body = (name, depth, joint) => {
    const link = model.linkMap.get(name);
    const attrs = [`name="${esc(name)}"`];
    if (joint) {
      if (!isZero(joint.xyz)) attrs.push(`pos="${fv(joint.xyz)}"`);
      if (!isIdentity(joint.rpy)) attrs.push(`quat="${fv(quat(joint.rpy))}"`);
    }
    out(depth, `<body ${attrs.join(' ')}>`);
    if (joint && joint.type !== 'fixed') {
      if (MOVABLE.has(joint.type)) {
        const ja = [`name="${esc(joint.name)}"`, `type="${joint.type === 'prismatic' ? 'slide' : 'hinge'}"`, `axis="${fv(joint.axis)}"`];
        if (joint.type !== 'continuous' && joint.limit && joint.limit.lower != null && joint.limit.upper != null) ja.push(`range="${f(joint.limit.lower)} ${f(joint.limit.upper)}"`);
        if (joint.dynamics?.damping) ja.push(`damping="${f(joint.dynamics.damping)}"`);
        if (joint.dynamics?.friction) ja.push(`frictionloss="${f(joint.dynamics.friction)}"`);
        if (joint.limit?.effort) ja.push(`actuatorfrcrange="${f(-joint.limit.effort)} ${f(joint.limit.effort)}"`);
        out(depth + 1, `<joint ${ja.join(' ')}/>`);
      } else if (joint.type === 'floating') {
        if (depth === 2) out(depth + 1, `<freejoint name="${esc(joint.name)}"/>`);
        else warnings.push(`floating 조인트 "${joint.name}" 는 최상위 body 에서만 freejoint 로 변환됩니다`);
      } else if (joint.type === 'planar') {
        out(depth + 1, `<joint name="${esc(joint.name)}_x" type="slide" axis="1 0 0"/>`);
        out(depth + 1, `<joint name="${esc(joint.name)}_y" type="slide" axis="0 1 0"/>`);
        out(depth + 1, `<joint name="${esc(joint.name)}_rz" type="hinge" axis="${fv(joint.axis)}"/>`);
      }
    }
    const inr = link?.inertial;
    const I = inr?.I;
    const degenerate = !inr || !(inr.mass > 1e-6) || [I.ixx, I.iyy, I.izz].some((v) => !(v > 0));
    if (degenerate && joint && joint.type !== 'fixed') {
      // MuJoCo rejects massless moving bodies: give them a negligible inertia
      warnings.push(`링크 "${name}": 질량/관성이 없는 움직이는 body 에 아주 작은 관성을 넣었습니다`);
      out(depth + 1, '<inertial pos="0 0 0" mass="1e-5" diaginertia="1e-10 1e-10 1e-10"/>');
    }
    if (!degenerate) {
      const ia = [`pos="${fv(inr.xyz)}"`, `mass="${f(inr.mass)}"`, `fullinertia="${fv([I.ixx, I.iyy, I.izz, I.ixy, I.ixz, I.iyz])}"`];
      if (!isIdentity(inr.rpy)) ia.splice(1, 0, `quat="${fv(quat(inr.rpy))}"`);
      out(depth + 1, `<inertial ${ia.join(' ')}/>`);
    }
    link?.visuals.forEach((s, i) => geom(depth + 1, s, 'visual', name, i));
    link?.collisions.forEach((s, i) => geom(depth + 1, s, 'collision', name, i));
    for (const j of model.childrenOf.get(name) || []) body(j.child, depth + 1, j);
    out(depth, '</body>');
  };

  out(0, `<mujoco model="${esc(model.name || 'robot')}">`);
  out(1, '<!-- webURDF 에서 URDF 로부터 변환됨. 메시 경로와 액추에이터는 필요에 맞게 조정하세요. -->');
  out(1, '<compiler angle="radian" autolimits="true"/>');
  out(1, '<option integrator="implicitfast"/>');
  out(1, '<default>');
  out(2, '<joint armature="0.001" damping="0.05"/>');
  out(2, '<default class="visual"><geom contype="0" conaffinity="0" group="2"/></default>');
  out(2, '<default class="collision"><geom group="3"/></default>');
  out(1, '</default>');
  const assetAt = lines.length;
  out(1, '<worldbody>');
  out(2, '<light pos="0 0 3" dir="0 0 -1" directional="true"/>');
  out(2, '<geom name="floor" type="plane" size="0 0 0.05" rgba="0.8 0.8 0.8 1" contype="1" conaffinity="1"/>');
  for (const r of model.roots) {
    // a root link without geometry (e.g. "world") is merged into the world body
    const l = model.linkMap.get(r);
    if (l && r === 'world' && !l.visuals.length && !l.collisions.length) {
      for (const j of model.childrenOf.get(r) || []) body(j.child, 2, j);
    } else body(r, 2, null);
  }
  out(1, '</worldbody>');
  const assetLines = [];
  if (assets.size) {
    assetLines.push('  <asset>');
    for (const a of assets.values()) {
      const sc = a.scale.every((v) => v === 1) ? '' : ` scale="${fv(a.scale)}"`;
      assetLines.push(`    <mesh name="${esc(a.name)}" file="${esc(a.file)}"${sc}/>`);
    }
    assetLines.push('  </asset>');
  }
  lines.splice(assetAt, 0, ...assetLines);

  const mimics = model.joints.filter((j) => j.mimic && model.jointMap.has(j.mimic.joint) && MOVABLE.has(j.type));
  if (mimics.length) {
    out(1, '<equality>');
    for (const j of mimics) out(2, `<joint joint1="${esc(j.name)}" joint2="${esc(j.mimic.joint)}" polycoef="${f(j.mimic.offset)} ${f(j.mimic.multiplier)} 0 0 0"/>`);
    out(1, '</equality>');
  }
  const acts = model.joints.filter((j) => MOVABLE.has(j.type) && !j.mimic);
  if (acts.length) {
    out(1, '<actuator>');
    for (const j of acts) out(2, `<position name="${esc(j.name)}_pos" joint="${esc(j.name)}" kp="${j.type === 'prismatic' ? 1000 : 20}"/>`);
    out(1, '</actuator>');
  }
  out(0, '</mujoco>');
  if (warnings.length) lines.splice(1, 0, ...[...new Set(warnings)].map((w) => `  <!-- 경고: ${w.replace(/--/g, '—')} -->`));
  return { text: lines.join('\n') + '\n', warnings: [...new Set(warnings)] };
}
