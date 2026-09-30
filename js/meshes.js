// meshes.js — mesh loading through the VFS, with a parse cache so that editing
// the URDF (which rebuilds the robot) does not re-download or re-parse meshes.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { dirname, extname, normalize } from './vfs.js';

export class MeshLibrary {
  constructor() {
    this.cache = new Map();   // resolved path -> Promise<{object, info}>
    this.vfs = null;
    this.manager = new THREE.LoadingManager();
    // Loaders that fetch by themselves (textures) receive "vfs://dir/file" URLs.
    this.manager.setURLModifier((url) => {
      if (!url.startsWith('vfs://') || !this.vfs) return url;
      const path = decodeURI(url.slice(6));
      const r = this.vfs.resolve(path, '');
      return (r && (r.url || this.vfs.urlFor(r.path))) || url;
    });
    this.events = new EventTarget();
  }

  setVFS(vfs) {
    if (vfs !== this.vfs) this.clear();
    this.vfs = vfs;
  }
  clear() {
    this.cache.clear();
  }

  // Resolve a mesh reference from `from` (the URDF path). Returns the VFS path
  // or a list of guesses (URL-only mode).
  resolve(ref, from) {
    if (!this.vfs) return null;
    return this.vfs.resolve(ref, from);
  }

  async load(ref, from) {
    const r = this.resolve(ref, from);
    if (!r) throw new Error(`메시 파일을 찾을 수 없음: ${ref}`);
    const tries = r.url ? [{ url: r.url }] : [r.path, ...(r.alternatives || [])].map((p) => ({ path: p }));
    let lastErr;
    for (const t of tries) {
      const key = t.url || t.path;
      if (!this.cache.has(key)) this.cache.set(key, this.parse(t).catch((e) => { this.cache.delete(key); throw e; }));
      try {
        const res = await this.cache.get(key);
        return { object: cloneObject(res.object), path: t.path, url: t.url, fuzzy: !!r.fuzzy, info: res.info };
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async parse({ path, url }) {
    const name = path || new URL(url).pathname;
    const ext = extname(name);
    const buffer = url ? await (await fetchOk(url)).arrayBuffer() : await this.vfs.arrayBuffer(path);
    const base = path ? 'vfs://' + (dirname(normalize(path)) ? dirname(normalize(path)) + '/' : '') : THREE.LoaderUtils.extractUrlBase(url);
    let object;
    switch (ext) {
      case '.stl': {
        const geom = new STLLoader(this.manager).parse(buffer);
        geom.computeBoundingBox();
        const colored = !!geom.hasColors;
        const mat = new THREE.MeshPhongMaterial({ color: 0xcccccc, vertexColors: colored });
        object = new THREE.Mesh(geom, mat);
        object.userData.needsURDFMaterial = !colored;
        break;
      }
      case '.dae': {
        const text = new TextDecoder().decode(buffer);
        const dae = new ColladaLoader(this.manager).parse(text, base);
        object = dae.scene;
        break;
      }
      case '.glb': case '.gltf': {
        const gltf = await new Promise((res, rej) => new GLTFLoader(this.manager).parse(buffer, base, res, rej));
        object = gltf.scene;
        break;
      }
      case '.obj': {
        const text = new TextDecoder().decode(buffer);
        const loader = new OBJLoader(this.manager);
        const mtl = /^mtllib\s+(.+)$/m.exec(text);
        let hasMtl = false;
        if (mtl && path) {
          const r = this.vfs.resolve(mtl[1].trim(), path);
          if (r?.path) {
            try {
              const mtlText = await this.vfs.text(r.path);
              const mats = new MTLLoader(this.manager).setResourcePath('vfs://' + dirname(r.path) + '/').parse(mtlText, '');
              mats.preload();
              loader.setMaterials(mats);
              hasMtl = true;
            } catch { /* ignore broken mtl */ }
          }
        }
        object = loader.parse(text);
        object.userData.needsURDFMaterial = !hasMtl;
        break;
      }
      case '.ply': {
        const geom = new PLYLoader(this.manager).parse(buffer);
        geom.computeVertexNormals();
        const colored = !!geom.attributes.color;
        object = new THREE.Mesh(geom, new THREE.MeshPhongMaterial({ color: 0xcccccc, vertexColors: colored }));
        object.userData.needsURDFMaterial = !colored;
        break;
      }
      default:
        throw new Error(`지원하지 않는 메시 형식: ${ext || name}`);
    }
    let tris = 0;
    object.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = o.receiveShadow = true;
        const g = o.geometry;
        tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      }
    });
    return { object, info: { triangles: Math.round(tris), bytes: buffer.byteLength, format: ext.slice(1).toUpperCase() } };
  }

  // Adapter for URDFLoader.loadMeshCb. `from` is bound per robot.
  callback(from, onMesh = () => {}) {
    return (ref, manager, material, done) => {
      this.load(ref, from).then((res) => {
        const obj = res.object;
        // STL/OBJ/PLY without their own colors take the URDF <material>
        if (obj.userData.needsURDFMaterial && material) {
          obj.traverse((o) => {
            if (o.isMesh) o.material = material.clone();
          });
        }
        onMesh({ ref, ...res });
        done(obj);
      }).catch((err) => {
        onMesh({ ref, error: err });
        done(null, err);
      });
    };
  }
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

function cloneObject(obj) {
  // geometries are shared, materials cloned so per-robot highlighting works
  const c = obj.clone(true);
  c.traverse((o) => {
    if (o.isMesh) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    }
  });
  c.userData = { ...obj.userData };
  return c;
}
