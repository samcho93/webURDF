// viewer.js — three.js scene: robot display, overlays (frames, joint axes, COM,
// inertia), selection by clicking, joint dragging, screenshots and GLB export.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { PointerURDFDragControls } from 'urdf-loader/src/URDFDragControls.js';
import { eigenSym3, inertiaMatrix } from './model.js';

const HIGHLIGHT = new THREE.Color(0x3b82f6);
const HOVER = new THREE.Color(0x60a5fa);

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.robot = null;
    this.model = null;
    this.opts = {
      visual: true, collision: false, wireframe: false, opacity: 1,
      frames: false, jointAxes: false, com: false, inertia: false, labels: false,
      grid: true, shadows: true, upAxis: 'Z', drag: true, autoRotate: false,
    };
    this.selected = null;

    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    const scene = this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    this.camera.position.set(1.2, 0.9, 1.2);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-4, 2, -3);
    scene.add(fill);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.18 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground);
    this.grid = new THREE.Group();
    scene.add(this.grid);
    this.worldAxes = new THREE.AxesHelper(0.1);
    scene.add(this.worldAxes);

    // world <- ROS frame conversion (Z-up)
    this.world = new THREE.Group();
    scene.add(this.world);
    this.overlays = new THREE.Group();
    this.overlays.name = '__overlays';

    const controls = this.controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;

    this.drag = new PointerURDFDragControls(scene, this.camera, renderer.domElement);
    this.drag.onDragStart = () => { controls.enabled = false; this.dragMoved = false; };
    this.drag.onDragEnd = () => { controls.enabled = true; };
    this.drag.onHover = (joint) => this.setHoverJoint(joint);
    this.drag.onUnhover = () => this.setHoverJoint(null);
    this.drag.updateJoint = (joint, angle) => {
      this.dragMoved = true;
      this.robot?.setJointValue(joint.name, angle);
      this.dispatchEvent(new CustomEvent('joint-change', { detail: { name: joint.name, value: angle, source: 'drag' } }));
    };

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    let downAt = null;
    renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; this.dragMoved = false; });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || this.dragMoved) return;
      const link = this.pick(e);
      this.dispatchEvent(new CustomEvent('pick', { detail: { link: link?.name || null, shift: e.shiftKey } }));
    });
    renderer.domElement.addEventListener('dblclick', (e) => {
      const link = this.pick(e);
      if (link) this.focusLink(link.name);
    });

    this.clock = new THREE.Clock();
    this.animators = new Set();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.buildGrid(1);
    const loop = () => {
      const dt = this.clock.getDelta();
      for (const a of this.animators) a(dt);
      controls.autoRotate = this.opts.autoRotate;
      controls.update();
      this.updateOverlays();
      renderer.render(scene, this.camera);
      if (this.opts.labels) this.labelRenderer.render(scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setTheme(dark) {
    this.dark = dark;
    this.buildGrid(this.gridSize || 1);
  }

  buildGrid(size) {
    this.gridSize = size;
    this.grid.clear();
    const step = 10 ** Math.floor(Math.log10(Math.max(size, 1e-3) / 2));
    const extent = Math.max(step * 20, Math.ceil(size * 3 / step) * step);
    const divisions = Math.round(extent / step);
    const c1 = this.dark ? 0x4b5563 : 0x9ca3af, c2 = this.dark ? 0x2a303a : 0xd8dce2;
    const g = new THREE.GridHelper(extent, divisions, c1, c2);
    g.material.transparent = true;
    g.material.opacity = 0.8;
    this.grid.add(g);
    this.ground.scale.set(extent, extent, 1);
    this.worldAxes.scale.setScalar(Math.max(step * 2, 0.02) / 0.1);
    this.grid.visible = this.opts.grid;
    this.dispatchEvent(new CustomEvent('grid', { detail: { step } }));
  }

  applyUpAxis() {
    this.world.rotation.set(this.opts.upAxis === 'Z' ? -Math.PI / 2 : 0, 0, 0);
    this.world.updateMatrixWorld(true);
  }

  setRobot(robot, model, { keepView = false } = {}) {
    if (this.robot) {
      this.world.remove(this.robot);
      disposeTree(this.robot, false);
    }
    this.robot = robot;
    this.model = model;
    this.selected = null;
    this.drag.setGrabbed?.(null);
    if (robot) {
      this.world.add(robot);
      robot.add(this.overlays);
      robot.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
    }
    this.applyUpAxis();
    this.rebuildOverlays();
    this.applyDisplay();
    if (!keepView) this.fit();
  }

  // Called when meshes finish loading (bounds change).
  meshesLoaded({ fit = false } = {}) {
    this.robot?.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
    this.applyDisplay();
    this.rebuildOverlays();
    if (fit) this.fit();
  }

  bounds() {
    const box = new THREE.Box3();
    if (!this.robot) return box;
    this.world.updateMatrixWorld(true);
    this.robot.traverse((o) => {
      if (!o.isMesh || !o.visible || isOverlay(o)) return;
      if (o.parent && o.parent.isURDFCollider && !this.opts.collision) return;
      o.geometry.computeBoundingBox?.();
      const b = o.geometry.boundingBox;
      if (b) box.union(b.clone().applyMatrix4(o.matrixWorld));
    });
    if (box.isEmpty()) {
      this.robot.traverse((o) => { if (o.isURDFLink) box.expandByPoint(o.getWorldPosition(new THREE.Vector3())); });
      if (!box.isEmpty()) box.expandByScalar(0.05);
    }
    return box;
  }

  fit(box = this.bounds()) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.01);
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.1;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(1, 0.7, 1).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 1e-4);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    // ground just below the robot
    this.grid.position.y = this.ground.position.y = Math.min(box.min.y, 0);
    this.worldAxes.position.y = this.grid.position.y + 1e-4;
    this.buildGrid(Math.max(size.x, size.z, size.y));
    const s = this.sun.shadow.camera;
    const r = radius * 2.5;
    s.left = -r; s.right = r; s.top = r; s.bottom = -r; s.near = 0.01; s.far = r * 20;
    s.updateProjectionMatrix();
    this.sun.position.copy(center).add(new THREE.Vector3(r * 0.6, r * 2, r * 0.8));
    this.sun.target.position.copy(center);
    this.robotRadius = radius;
    this.rebuildOverlays();
  }

  setView(name) {
    const target = this.controls.target.clone();
    const d = this.camera.position.distanceTo(target);
    // ROS frame directions mapped into three.js (Z-up => three Y-up)
    const dirs = { front: [1, 0, 0], back: [-1, 0, 0], left: [0, 1, 0], right: [0, -1, 0], top: [0, 0, 1], iso: [1, -0.8, 0.7] };
    const v = new THREE.Vector3(...dirs[name]).normalize();
    if (this.opts.upAxis === 'Z') v.set(v.x, v.z, -v.y);
    if (name === 'top') v.add(new THREE.Vector3(0.0001, 0, 0.0001)).normalize();
    this.camera.position.copy(target).addScaledVector(v, d);
    this.controls.update();
  }

  focusLink(name) {
    const link = this.robot?.links[name];
    if (!link) return;
    const box = new THREE.Box3();
    link.traverse((o) => {
      if (o.isMesh && !isOverlay(o) && (o.parent === link || !o.parent.isURDFLink)) {
        const own = findLink(o) === link;
        if (own) box.expandByObject(o);
      }
    });
    if (box.isEmpty()) box.setFromCenterAndSize(link.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.1, 0.1, 0.1));
    this.fit(box);
  }

  set(key, value) {
    this.opts[key] = value;
    if (key === 'upAxis') { this.applyUpAxis(); this.fit(); }
    else if (key === 'grid') { this.grid.visible = value; this.worldAxes.visible = value; }
    else if (key === 'shadows') { this.renderer.shadowMap.enabled = value; this.ground.visible = value; this.sun.castShadow = value; this.robot?.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }
    else if (key === 'drag') { this.drag.enabled = value; }
    else if (key === 'labels') { this.labelRenderer.domElement.style.display = value ? '' : 'none'; this.rebuildOverlays(); }
    else if (['frames', 'jointAxes', 'com', 'inertia'].includes(key)) this.rebuildOverlays();
    else this.applyDisplay();
  }

  applyDisplay() {
    if (!this.robot) return;
    const o = this.opts;
    this.robot.traverse((c) => {
      if (c.isURDFVisual) c.visible = o.visual;
      if (c.isURDFCollider) c.visible = o.collision;
      if (!c.isMesh || isOverlay(c)) return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      const inCollider = !!findAncestor(c, (a) => a.isURDFCollider);
      for (const m of mats) {
        if (!m) continue;
        if (m.userData.baseColor === undefined && m.color) {
          m.userData.baseColor = m.color.clone();
          m.userData.baseOpacity = m.opacity;
          m.userData.baseTransparent = m.transparent;
        }
        if (inCollider) {
          m.transparent = true; m.opacity = 0.35; m.depthWrite = false;
          if (m.color) m.color.set(0xf59e0b);
          m.wireframe = o.wireframe;
          continue;
        }
        m.wireframe = o.wireframe;
        const op = Math.min(o.opacity, m.userData.baseOpacity ?? 1);
        m.transparent = op < 1 || m.userData.baseTransparent;
        m.opacity = op;
        m.depthWrite = op >= 1;
      }
    });
    this.applyHighlight();
  }

  // ------------------------------------------------------------------ selection
  pick(e) {
    if (!this.robot) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.robot, true).filter((h) => h.object.visible && isVisibleChain(h.object) && !isOverlay(h.object));
    for (const h of hits) { const l = findLink(h.object); if (l) return l; }
    return null;
  }

  select(name) {
    this.selected = name;
    this.applyHighlight();
    this.rebuildOverlays();
  }

  setHoverJoint(joint) {
    this.hoverLink = joint ? joint.children.find((c) => c.isURDFLink)?.name || null : null;
    this.applyHighlight();
  }

  applyHighlight() {
    if (!this.robot) return;
    this.robot.traverse((c) => {
      if (!c.isMesh || isOverlay(c)) return;
      if (findAncestor(c, (a) => a.isURDFCollider)) return;
      const l = findLink(c)?.name;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) {
        if (!m || !m.emissive) continue;
        if (m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.emissive.clone();
        if (l && l === this.selected) m.emissive.copy(HIGHLIGHT).multiplyScalar(0.55);
        else if (l && l === this.hoverLink) m.emissive.copy(HOVER).multiplyScalar(0.35);
        else m.emissive.copy(m.userData.baseEmissive);
      }
    });
  }

  // ------------------------------------------------------------------ overlays
  rebuildOverlays() {
    const g = this.overlays;
    for (const c of [...g.children]) disposeTree(c, true);
    g.clear();
    // overlays attached to links live in the link; remove previous ones
    const stale = [];
    this.robot?.traverse((o) => { if (o.userData.__overlayRoot) stale.push(o); });
    for (const o of stale) { o.parent.remove(o); disposeTree(o, true); }
    if (!this.robot || !this.model) return;

    const size = this.robotRadius || 0.5;
    const frameSize = Math.max(size * 0.12, 0.01);
    const tag = (o) => { o.userData.__overlayRoot = true; o.userData.__overlay = true; o.traverse((c) => { c.userData.__overlay = true; c.raycast = () => {}; }); return o; };

    for (const [name, link] of Object.entries(this.robot.links)) {
      const sel = name === this.selected;
      if (this.opts.frames || sel) {
        const ax = new THREE.AxesHelper(sel ? frameSize * 1.5 : frameSize);
        ax.material.depthTest = false;
        ax.renderOrder = 999;
        link.add(tag(ax));
      }
      if (this.opts.labels) {
        const div = document.createElement('div');
        div.className = 'link-label' + (sel ? ' selected' : '');
        div.textContent = name;
        const lbl = new CSS2DObject(div);
        link.add(tag(lbl));
      }
      const ml = this.model.linkMap.get(name);
      const inr = ml?.inertial;
      if (inr && (this.opts.com || this.opts.inertia) && inr.mass > 0) {
        const holder = new THREE.Group();
        holder.position.set(...inr.xyz);
        holder.quaternion.copy(rpyQuat(inr.rpy));
        if (this.opts.com) {
          const r = Math.max(frameSize * 0.18 * Math.cbrt(inr.mass / Math.max(this.totalMass() / this.model.links.length, 1e-6)), frameSize * 0.06);
          const s = new THREE.Mesh(new THREE.SphereGeometry(Math.min(r, frameSize * 0.5), 16, 12), comMaterial());
          s.renderOrder = 998;
          holder.add(s);
        }
        if (this.opts.inertia) {
          const box = inertiaBox(inr);
          if (box) holder.add(box);
        }
        link.add(tag(holder));
      }
    }
    if (this.opts.jointAxes || this.selected) {
      for (const [name, j] of Object.entries(this.robot.joints)) {
        const mj = this.model.jointMap.get(name);
        if (!mj || !['revolute', 'continuous', 'prismatic', 'planar'].includes(mj.type)) continue;
        const child = j.children.find((c) => c.isURDFLink)?.name;
        if (!this.opts.jointAxes && child !== this.selected) continue;
        const axis = new THREE.Vector3(...mj.axis).normalize();
        const color = mj.type === 'prismatic' ? 0x22c55e : 0xef4444;
        const len = frameSize * 1.8;
        const arrow = new THREE.ArrowHelper(axis, new THREE.Vector3(), len, color, len * 0.25, len * 0.12);
        arrow.traverse((c) => { if (c.material) { c.material.depthTest = false; c.renderOrder = 999; } });
        // joint frame (the joint object is at the joint origin, before the motion)
        const holder = new THREE.Group();
        holder.add(arrow);
        if (mj.type !== 'prismatic') {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(len * 0.35, len * 0.02, 6, 32, Math.PI * 1.5),
            new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }));
          ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
          ring.renderOrder = 999;
          holder.add(ring);
        }
        j.parent.add(tag(holder));
        holder.position.copy(j.origPosition || j.position);
        holder.quaternion.copy(j.origQuaternion || j.quaternion);
      }
    }
  }

  updateOverlays() { /* overlays follow their parents automatically */ }

  totalMass() {
    return this.model ? this.model.links.reduce((s, l) => s + (l.inertial?.mass || 0), 0) : 1;
  }

  // ------------------------------------------------------------------ export
  screenshot(scale = 2) {
    const { renderer, camera } = this;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const pr = renderer.getPixelRatio();
    renderer.setPixelRatio(scale);
    renderer.setSize(w, h);
    renderer.render(this.scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h);
    return url;
  }

  async exportGLB() {
    if (!this.robot) throw new Error('로봇이 없습니다');
    const hidden = [];
    this.robot.traverse((o) => { if ((o.userData.__overlay || o.isCSS2DObject) && o.visible) { o.visible = false; hidden.push(o); } });
    try {
      const exp = new GLTFExporter();
      const res = await exp.parseAsync(this.world, { binary: true, onlyVisible: true });
      return new Blob([res], { type: 'model/gltf-binary' });
    } finally {
      for (const o of hidden) o.visible = true;
    }
  }

  linkWorldMatrix(name, relativeTo = null) {
    const link = this.robot?.links[name];
    if (!link) return null;
    this.robot.updateMatrixWorld(true);
    const m = link.matrixWorld.clone();
    const base = relativeTo ? this.robot.links[relativeTo]?.matrixWorld : this.robot.matrixWorld;
    return base ? base.clone().invert().multiply(m) : m;
  }
}

// --------------------------------------------------------------------------- helpers

function isOverlay(o) { for (let a = o; a; a = a.parent) if (a.userData.__overlay) return true; return false; }
function findAncestor(o, pred) { for (let a = o.parent; a; a = a.parent) if (pred(a)) return a; return null; }
function findLink(o) { for (let a = o; a; a = a.parent) if (a.isURDFLink) return a; return null; }
function isVisibleChain(o) { for (let a = o; a; a = a.parent) if (!a.visible) return false; return true; }

export function rpyQuat([r, p, y]) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
}

let _comMat;
function comMaterial() {
  if (!_comMat) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#111' : '#fbbf24'; ctx.fillRect((i % 2) * 32, (i >> 1) * 32, 32, 32); }
    ctx.fillStyle = '#111'; ctx.fillRect(32, 0, 32, 32); ctx.fillStyle = '#fbbf24'; ctx.fillRect(32, 32, 32, 32); ctx.fillStyle = '#111'; ctx.fillRect(0, 32, 32, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    _comMat = new THREE.MeshBasicMaterial({ map: tex, depthTest: false });
  }
  return _comMat;
}

// Box with the same principal moments as the inertia tensor.
function inertiaBox(inr) {
  const { mass, I } = inr;
  const { values, vectors } = eigenSym3(inertiaMatrix(I));
  const [a, b, c] = values;
  const k = 6 / mass;
  const x = Math.sqrt(Math.max(k * (b + c - a), 0));
  const y = Math.sqrt(Math.max(k * (a + c - b), 0));
  const z = Math.sqrt(Math.max(k * (a + b - c), 0));
  if (!(x + y + z > 0) || ![x, y, z].every(Number.isFinite)) return null;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x || 1e-4, y || 1e-4, z || 1e-4),
    new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.25, depthWrite: false }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0xa855f7 }));
  mesh.add(edges);
  const m = new THREE.Matrix4().set(
    vectors[0][0], vectors[0][1], vectors[0][2], 0,
    vectors[1][0], vectors[1][1], vectors[1][2], 0,
    vectors[2][0], vectors[2][1], vectors[2][2], 0,
    0, 0, 0, 1);
  if (m.determinant() < 0) m.elements[8] *= -1, m.elements[9] *= -1, m.elements[10] *= -1;
  mesh.quaternion.setFromRotationMatrix(m);
  return mesh;
}

function disposeTree(obj, disposeGeometry) {
  obj.traverse((o) => {
    if (o.isCSS2DObject) o.element?.remove();
    if (disposeGeometry && o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m !== _comMat) m.dispose(); });
  });
}
