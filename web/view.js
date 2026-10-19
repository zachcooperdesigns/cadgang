/**
 * cadgang · view — the fast file viewer.
 *
 * No document, no cells, no kernel on this page: a file comes in (drop, ⌘O, or
 * the macOS shell handing over a Finder path), it becomes one BufferGeometry,
 * and the GPU does the rest. Mesh formats parse here with three.js loaders;
 * B-rep formats go to the server, which tessellates with OpenCascade and
 * streams typed arrays back. Edges on a B-rep are the true face borders
 * (triangles on either side belong to different faces), not a crease
 * threshold guess.
 */

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { attachOrbitInput } from './orbitinput.js';
import { createMarkup } from './markup.js';
import { parseDxf } from './dxf.js';
import { createMeasure } from './measure.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';

const $ = (s) => document.querySelector(s);
const ui = { edges: true, wire: false, grid: true, look: 'shaded', ortho: false, flat: false, color: false }; // flat: a 2D drawing is open
const section = { plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), axis: '', flip: 1 };
const CAD_EXT = /\.(step|stp|iges|igs|brep)$/i;

let statusTimer = null;
function say(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isError);
  clearTimeout(statusTimer);
  if (text && !isError) statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

// ----------------------------------------------------------------- viewport

const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.localClippingEnabled = true;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
let camera = persp;
const key = new THREE.DirectionalLight(0xfffdf8, 2.4);
key.position.set(60, -80, 120);
const fill = new THREE.DirectionalLight(0xf3e9d8, 0.9);
fill.position.set(-90, 50, -30);
scene.add(key, fill, new THREE.AmbientLight(0xffffff, 1.15), new THREE.HemisphereLight(0xffffff, 0xdedbd4, 0.6));

/** Render presets. Every mesh carries its own instance so per-mesh flags (flat, wire, clipping) never leak. */
const PRESETS = {
  shaded: () => new THREE.MeshStandardMaterial({ color: 0xb9b8b3, metalness: 0.25, roughness: 0.5 }),
  metal: () => new THREE.MeshStandardMaterial({ color: 0xcfd0d2, metalness: 0.95, roughness: 0.28 }),
  plastic: () => new THREE.MeshStandardMaterial({ color: 0xe8e4dc, metalness: 0, roughness: 0.65 }),
  glass: () => new THREE.MeshPhysicalMaterial({ color: 0xdfe8ee, metalness: 0, roughness: 0.05, transmission: 0.9, thickness: 2, transparent: true, opacity: 0.6 }),
  xray: () => new THREE.MeshBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.18, depthWrite: false }),
  normals: () => new THREE.MeshNormalMaterial(),
};
// One hue per body or layer when COLOR is on; golden-ratio spacing keeps any count apart.
const partColor = (i) => new THREE.Color().setHSL((i * 0.618034) % 1, 0.6, 0.5);

// A soft studio sky for the file's own materials: metal with nothing to reflect reads black.
const studio = (() => {
  const sky = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const col = [];
  for (let i = 0, p = geo.getAttribute('position'); i < p.count; i++) { const t = (p.getY(i) / 10 + 1) / 2; col.push(0.35 + 0.65 * t, 0.35 + 0.63 * t, 0.34 + 0.6 * t); }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.rotateX(Math.PI / 2);   // the part's Z is up
  sky.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(sky, 0.04).texture;
  pm.dispose();
  return tex;
})();

/**
 * The file's appearance as a material: its colour and opacity, finished by
 * what its material or body name says (steel is metal, satin is not polished,
 * a lens is clear, rubber is matte). Anything the name does not say stays a
 * plain painted part.
 */
function appearanceMaterial({ color, opacity = 1, material = '', name = '' }) {
  const says = (re) => re.test(material) || (!material && re.test(name));
  // Real white plastic reflects ~80%; a file's 0.96 white under these lights would blow out to a flat silhouette.
  const c = color ? color.map((v) => v * Math.min(1, 0.8 / Math.max(...color, 1e-6))) : null;
  const mat = new THREE.MeshPhysicalMaterial({ color: c ? new THREE.Color().setRGB(...c, THREE.SRGBColorSpace) : 0xb9b8b3, metalness: 0.05, roughness: 0.5, envMap: studio, envMapIntensity: 0.3 });
  if (says(/steel|stainless|alumin|chrome|metal|iron|titanium|brass|bronze|copper|nickel|zinc|gold|silver|tin\b/i)) {
    mat.metalness = 0.9; mat.envMapIntensity = 1;
    mat.roughness = says(/polish|mirror|chrome/i) ? 0.12 : says(/satin|brush/i) ? 0.32 : says(/matte|blast|anodi|cast/i) ? 0.5 : 0.25;
  } else if (says(/glass|acrylic|clear|transparent|lens|sapphire|pmma/i)) {
    Object.assign(mat, { roughness: 0.05, metalness: 0, transmission: 0.6, thickness: 1, clearcoat: 1 });
    if (opacity === 1) opacity = 0.45;
  } else if (says(/rubber|silicone|tpu|tpe|foam|fabric|felt/i)) mat.roughness = 0.9;
  else if (says(/gloss|paint|lacquer|enamel/i)) Object.assign(mat, { roughness: 0.3, clearcoat: 0.6 });
  else if (says(/matte|flat|textur|pla\b|nylon/i)) mat.roughness = 0.75;
  if (opacity < 1) Object.assign(mat, { transparent: true, opacity, depthWrite: false });
  return mat;
}
/** Does a loader's material say anything, or is it the loader's blank default? */
const informative = (mat) => !!(mat && (mat.vertexColors || mat.map || (mat.color && mat.color.getHex() !== 0xffffff)));
const mats = (m) => [].concat(m.material);

function styleMesh(m) {
  const i = model.children.indexOf(m);
  if (m.isLine) {   // a drawing keeps its ink unless coloured by layer
    m.material.color.set(ui.color ? partColor(i) : inkColor());
    m.material.clippingPlanes = section.axis && bbox ? [section.plane] : [];
    return;
  }
  // AS FILE (value 'shaded') shows the part as the file paints it, grey when it says nothing, with
  // the user's material or colour on top; the other looks override all of it.
  const asFile = ui.look === 'shaded', src = asFile && m.userData.source, ov = asFile && m.userData.override;
  const next = ov?.material ? [appearanceMaterial({ color: ov.color, material: ov.material })]
    : src ? src.map((s) => s.clone()) : [PRESETS[ui.look]()];
  if (ov?.color && !ov.material) for (const mat of next) { mat.color?.setRGB(...ov.color.map((v) => v * Math.min(1, 0.8 / Math.max(...ov.color, 1e-6))), THREE.SRGBColorSpace); mat.vertexColors = false; mat.map = null; }
  for (const mat of next) {
    if (ui.color && mat.color) mat.color.copy(partColor(i));
    if (ui.color && mat.vertexColors) mat.vertexColors = false;
    mat.side = section.axis && bbox ? THREE.FrontSide : THREE.DoubleSide;
    if (m.userData.flat) mat.flatShading = true;
    mat.wireframe = ui.wire;
    mat.clippingPlanes = section.axis && bbox ? [section.plane] : [];
    if (m.userData.ghost) Object.assign(mat, { transparent: true, opacity: Math.min(mat.opacity, 0.15), depthWrite: false, transmission: 0 });
    if (selection.has(m) && mat.emissive) mat.emissive.setHex(0x2f5d8a).multiplyScalar(0.45);
  }
  m.renderOrder = m.userData.ghost ? 2 : 0;   // see-through bodies draw after the solid ones
  for (const old of mats(m)) old?.dispose();
  m.material = next.length === 1 ? next[0] : next;
}
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.85 });
const model = new THREE.Group();     // meshes
const edges = new THREE.Group();     // their edge overlays
scene.add(model, edges);
let grid = null;
let bbox = null;

function clearModel() {
  for (const g of [model, edges]) {
    for (const o of g.children) {
      o.geometry?.dispose();
      if (o.material !== edgeMaterial) for (const mt of [].concat(o.material)) mt?.dispose?.();
      for (const mt of o.userData.source ?? []) mt.dispose();
    }
    g.clear();
  }
  bbox = null; selection.clear(); selFolder = null; tree.root = null; bodyMenu.hidden = true;
  ui.flat = false; $('#sideBtn').hidden = true;
  $('#bodies').replaceChildren(); $('#bodies').hidden = true;
  $('#explode').value = 0;
}

/** The triangles of one body as their own geometry (vertices compacted so its bounding box is its own). */
function subGeometry(pos, idx, first, count) {
  const map = new Map(); const outIdx = new Uint32Array(count * 3); const outPos = [];
  for (let i = 0; i < count * 3; i++) {
    const v = idx[first * 3 + i];
    let j = map.get(v);
    if (j === undefined) { j = map.size; map.set(v, j); outPos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); }
    outIdx[i] = j;
  }
  return { pos: Float32Array.from(outPos), idx: outIdx };
}

/**
 * The same triangles with every B-rep face on vertices of its own. Shared
 * border vertices average a flat top with the fillet beside it, and the long
 * slivers of a planar face smear that average into streaks; split, each face
 * shades smooth within itself and creases cleanly at its borders.
 */
function splitByFace(pos, idx, faces) {
  const faceOf = new Int32Array(idx.length / 3).fill(-1);
  faces.forEach((f, fi) => faceOf.fill(fi, f.first, f.first + f.count));
  const map = new Map(), outPos = [], outIdx = new Uint32Array(idx.length);
  const n = pos.length / 3;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i], k = (faceOf[(i / 3) | 0] + 1) * n + v;
    let j = map.get(k);
    if (j === undefined) { j = map.size; map.set(k, j); outPos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); }
    outIdx[i] = j;
  }
  return { pos: Float32Array.from(outPos), idx: outIdx };
}

/** Face-border edges from a tessellation that knows its B-rep faces. */
function faceBorderEdges(pos, idx, faces) {
  const faceOf = new Uint32Array(idx.length / 3);
  faces.forEach((f, fi) => faceOf.fill(fi, f.first, f.first + f.count));
  const seen = new Map(); // edge key -> face id of the first triangle that used it
  const out = [];
  const n = pos.length / 3;
  for (let t = 0; t < idx.length; t += 3) {
    const f = faceOf[t / 3];
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      const k = a < b ? a * n + b : b * n + a;
      const prev = seen.get(k);
      if (prev === undefined) seen.set(k, f);
      else if (prev !== f) { out.push(pos[3 * a], pos[3 * a + 1], pos[3 * a + 2], pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]); seen.set(k, f); }
    }
  }
  return new Float32Array(out);
}

function addMesh(geo, { edgeLines, faces, flat = false, name = '', source = null, path = [], appearance = '' } = {}) {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const m = new THREE.Mesh(geo);
  m.userData.flat = flat;
  m.userData.source = source;
  m.userData.path = path;       // the assembly it came from, top first: the tree's folders
  m.userData.appearance = appearance;   // the file's material name, shown after the body's   // the file's own materials (one per geometry group), if it had any
  m.userData.name = name || `body ${model.children.length + 1}`;
  m.userData.faces = faces;   // B-rep face ranges, when the importer knew them: picked by measure
  styleMesh(m);
  model.add(m);
  // Crease edges on an arbitrary mesh are a guess; over a million triangles the
  // guess costs seconds and reads as noise, so skip it there.
  // ponytail: no edge LOD — a budget cut-off, add decimation if assemblies need outlines.
  const tris = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
  const lines = edgeLines ?? (tris < 1_000_000 ? new THREE.EdgesGeometry(geo, 25).getAttribute('position').array : null);
  if (lines?.length) {
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(lines, 3));
    const l = new THREE.LineSegments(eg, edgeMaterial);
    l.renderOrder = 1;
    edges.add(l);
    m.userData.edges = l;
  }
}

/** A DXF layer: line segments in the page's ink. Measure, markup and section see it like a body. */
function addLines(positions, name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: inkColor() }));
  l.userData.name = name;
  model.add(l);
}
const inkColor = () => (document.documentElement.dataset.theme === 'dark' ? 0xffffff : 0x000000);
const addPart = (p, name) => (p.lines ? addLines(p.lines, p.name || name) : addMesh(p.geo, p.name ? p : { ...p, name }));

// ------------------------------------------------------------------- bodies
//
// One mesh per body (a STEP assembly, a multi-body compound). The panel lists
// them with a checkbox each; EXPLODE slides every body out from the assembly
// centre along its own offset. Hiding a body hides its edges and its section cap.

// The tree: bodies sit in folders by the assembly they came from (a STEP's
// products, a glTF's nodes); a big folder also gathers like-named bodies (the
// forty copies of one resistor) into a folder of their own. A folder ticks,
// ghosts and selects everything under it, like a part or a subassembly.

const tree = { root: null };
const allBodies = (f) => [...f.bodies, ...f.folders.flatMap(allBodies)];
const stem = (n) => String(n).replace(/(\s*\(\d+\)|[_\s-]\d+)$/, '');   // "CAP_3" → "CAP", "Lead (2)" → "Lead"
const generic = (n) => !n || /^body \d+$/.test(n);
/**
 * A row reads "body_n · material": the body's own name (or its part's, when it has none), a number
 * when that name repeats in its folder, and the file's appearance.
 */
function labelOf(m) {
  const base = (m.userData.label ?? m.userData.name) + (m.userData.num ? `_${m.userData.num}` : ''), look = m.userData.appearance;
  return look && look !== base ? `${base} · ${look}` : base;
}

function buildTree() {
  const meshes = model.children;
  const paths = meshes.map((m) => (m.userData.path ?? []).filter((n, i, a) => n && n !== a[i - 1]));
  // a wrapper every body shares ("(Unsaved)", the file's own name) says nothing
  let skip = 0;
  while (paths.length && paths.every((p) => p.length > skip + 1 && p[skip] === paths[0][skip])) skip++;
  const folder = (name, parent) => ({ name, parent, folders: [], bodies: [], open: false });
  const root = folder('', null);
  meshes.forEach((m, i) => {
    let f = root;
    for (const name of paths[i].slice(skip)) {
      let next = f.folders.find((c) => c.name === name);
      if (!next) { next = folder(name, f); f.folders.push(next); }
      f = next;
    }
    f.bodies.push(m);
  });
  (function tidy(f) {
    f.folders.forEach(tidy);
    // like items: three or more bodies of one stem, in a crowded folder, get a folder
    if (f.bodies.length > 12) {
      const byStem = new Map();
      for (const m of f.bodies) { const k = stem(m.userData.name); if (!byStem.has(k)) byStem.set(k, []); byStem.get(k).push(m); }
      for (const [k, group] of byStem) {
        if (!k || group.length < 3 || group.length === f.bodies.length) continue;
        const g = folder(k, f); g.bodies = group; f.folders.push(g);
        f.bodies = f.bodies.filter((m) => !group.includes(m));
      }
    }
    // a folder of one body is just that body, named for the part
    f.folders = f.folders.filter((c) => {
      if (c.folders.length || c.bodies.length !== 1) return true;
      const m = c.bodies[0];
      m.userData.label = generic(m.userData.name) || m.userData.name === c.name ? c.name : `${c.name} · ${m.userData.name}`;
      f.bodies.push(m);
      return false;
    });
  })(root);
  (function own(f) {
    const seen = new Map(), base = (m) => m.userData.label ?? m.userData.name;
    for (const m of f.bodies) seen.set(base(m), (seen.get(base(m)) ?? 0) + 1);
    const n = new Map();
    for (const m of f.bodies) {
      m.userData.folder = f;
      if (seen.get(base(m)) > 1) { n.set(base(m), (n.get(base(m)) ?? 0) + 1); m.userData.num = n.get(base(m)); }
    }
    f.folders.forEach(own);
  })(root);
  root.open = true;
  if (meshes.length <= 30) (function openAll(f) { f.open = true; f.folders.forEach(openAll); })(root);
  tree.root = root;
}

function listBodies() {
  const panel = $('#bodies');
  panel.replaceChildren();
  panel.hidden = model.children.length < 2;
  const centre = bbox.getCenter(new THREE.Vector3());
  for (const m of model.children) {
    m.geometry.computeBoundingBox();
    m.userData.offset = m.geometry.boundingBox.getCenter(new THREE.Vector3()).sub(centre);
  }
  if (panel.hidden) return;
  buildTree();
  const see = (on) => { const b = Object.assign(document.createElement('button'), { className: 'ghost see', textContent: '◐', title: 'See-through (T)' }); b.addEventListener('click', on); return b; };
  const row = (depth, ...kids) => { const r = document.createElement('div'); r.className = 'row'; r.style.paddingLeft = `${depth * 12}px`; r.append(...kids); return r; };
  const name = (text, tip, onClick) => { const n = Object.assign(document.createElement('span'), { className: 'nm', textContent: text, title: tip }); n.addEventListener('click', onClick); return n; };
  function folderEl(f, depth) {
    const box = document.createElement('div');
    const twisty = Object.assign(document.createElement('button'), { className: 'ghost twisty', textContent: f.open ? '▾' : '▸' });
    const kids = document.createElement('div'); kids.hidden = !f.open;
    let filled = false;
    const fill = () => { if (filled) return; filled = true; for (const c of f.folders) kids.appendChild(folderEl(c, depth + 1)); for (const m of f.bodies) kids.appendChild(bodyEl(m, depth + 1)); };
    f.reveal = () => { fill(); f.open = true; kids.hidden = false; twisty.textContent = '▾'; };
    twisty.addEventListener('click', () => { f.open = !f.open; if (f.open) f.reveal(); else { kids.hidden = true; twisty.textContent = '▸'; } });
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox' });
    cb.addEventListener('change', () => { for (const m of allBodies(f)) setBodyVisible(m, cb.checked); syncRows(); });
    const n = allBodies(f).length;
    const r = row(depth, twisty, cb, name(f.name, `${f.name} · ${n} bodies\nClick: select the part · Shift-click: add`, (e) => { selectFolder(f, e.shiftKey); showBodyMenu(e.clientX, e.clientY); }),
      Object.assign(document.createElement('span'), { className: 'count', textContent: n }),
      see(() => { const on = !allBodies(f).every((m) => m.userData.ghost); for (const m of allBodies(f)) setBodyGhost(m, on); syncRows(); }));
    r.classList.add('folder');
    f.row = r; f.cb = cb;
    box.append(r, kids);
    if (f.open) fill();
    return box;
  }
  function bodyEl(m, depth) {
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox' });
    cb.addEventListener('change', () => { setBodyVisible(m, cb.checked); syncRows(); });
    const label = labelOf(m);
    const r = row(depth, Object.assign(document.createElement('span'), { className: 'twisty' }), cb,
      name(label, `${label}\nClick: select · Shift-click: add`, (e) => { select([m], { add: e.shiftKey }); showBodyMenu(e.clientX, e.clientY); }),
      see(() => { setBodyGhost(m, !m.userData.ghost); syncRows(); }));
    m.userData.row = r; m.userData.cb = cb;
    return r;
  }
  const top = tree.root;
  for (const c of top.folders) panel.appendChild(folderEl(c, 0));
  for (const m of top.bodies) panel.appendChild(bodyEl(m, 0));
  paintRows();
  syncRows();
}
// The panel's right edge drags to resize it; long names then end in an ellipsis
// (the full name is the row's tooltip). The width outlives the page.
const BODIES_W_KEY = 'cadgang-bodies-width';
const grip = $('#bodiesGrip');
function placeGrip() {
  const p = $('#bodies');
  grip.hidden = p.hidden;
  if (p.hidden) return;
  Object.assign(grip.style, { left: `${p.offsetLeft + p.offsetWidth}px`, top: `${p.offsetTop}px`, height: `${p.offsetHeight}px` });
}
try { const w = +localStorage.getItem(BODIES_W_KEY); if (w) $('#bodies').style.width = `${w}px`; } catch {}
new ResizeObserver(placeGrip).observe($('#bodies'));
new MutationObserver(placeGrip).observe($('#bodies'), { attributes: true, attributeFilter: ['hidden'] });
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('on');
  const p = $('#bodies'), x0 = e.clientX, w0 = p.offsetWidth;
  const move = (ev) => { p.style.width = `${Math.max(120, Math.min(viewport.clientWidth - 40, w0 + ev.clientX - x0))}px`; };
  const up = () => {
    grip.classList.remove('on');
    grip.removeEventListener('pointermove', move);
    try { localStorage.setItem(BODIES_W_KEY, String(p.offsetWidth)); } catch {}
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
});

/** Ticks, see-through toggles and the selection follow the bodies; a folder ticks if any of it shows. */
function syncRows() {
  if (!tree.root) return;
  (function walk(f) {
    for (const m of f.bodies) {
      if (!m.userData.row) continue;
      m.userData.cb.checked = m.visible;
      m.userData.row.classList.toggle('ghosted', !!m.userData.ghost);
      m.userData.row.classList.toggle('sel', selection.has(m));
    }
    for (const c of f.folders) {
      walk(c);
      if (!c.row) continue;
      const ms = allBodies(c), shown = ms.filter((m) => m.visible).length;
      c.cb.checked = shown > 0; c.cb.indeterminate = shown > 0 && shown < ms.length;
      c.row.classList.toggle('ghosted', ms.every((m) => m.userData.ghost));
      c.row.classList.toggle('sel', ms.every((m) => selection.has(m)));
    }
  })(tree.root);
}
/** The tick of each body row takes its colour when COLOR is on. */
function paintRows() {
  model.children.forEach((m, i) => { if (m.userData.cb) m.userData.cb.style.accentColor = ui.color ? `#${partColor(i).getHexString()}` : ''; });
}
function setBodyVisible(m, on) {
  m.visible = on;
  if (m.userData.edges) m.userData.edges.visible = on;
  if (!on && selection.has(m)) { selection.delete(m); styleMesh(m); }
  measure.invalidate();
}
function setBodyGhost(m, on) {
  if (m.isLine || !!m.userData.ghost === on) return;
  m.userData.ghost = on;
  styleMesh(m);
  buildCaps();
}

// ---------------------------------------------------------------- selection
//
// Click a body, in the view or the tree, to select it; click a folder to select
// the part. Selected bodies tint, their rows light up, and a small menu hides
// them, ghosts them, shows them alone, or changes their material and colour.
// U widens the selection to the part around it, and again to the assembly.
// Clicks in the view pass through see-through bodies to what is inside.

const selection = new Set();
let selFolder = null;   // the folder the selection is, when it is one
const bodyMenu = Object.assign(document.createElement('div'), { id: 'bodyMenu', hidden: true });
document.body.appendChild(bodyMenu);

/** The body under the pointer: visible, on the kept side of a section, solid ones before see-through ones. */
function bodyAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hits = raycaster.intersectObjects(model.children.filter((m) => m.visible && !m.isLine), false)
    .filter((h) => !section.axis || section.plane.distanceToPoint(h.point) >= -1e-6);
  return (hits.find((h) => !h.object.userData.ghost) ?? hits[0])?.object ?? null;
}
function select(ms, { add = false, folder = null } = {}) {
  const before = new Set(selection);
  if (!add) selection.clear();
  for (const m of ms) if (add && before.has(m) && ms.length === 1) selection.delete(m); else selection.add(m);
  selFolder = add ? null : folder;
  for (const m of new Set([...before, ...selection])) styleMesh(m);
  if (!selection.size) bodyMenu.hidden = true;
  syncRows();
  // open the tree down to the first selected row and bring it into view
  const first = selFolder ?? [...selection][0];
  if (first) {
    const chain = [];
    for (let f = selFolder ? selFolder.parent : first.userData.folder; f; f = f.parent) chain.unshift(f);
    chain.forEach((f) => f.reveal?.());
    (selFolder ? selFolder.row : first.userData.row)?.scrollIntoView({ block: 'nearest' });
  }
}
const selectFolder = (f, add = false) => select(allBodies(f), { add, folder: f });
/** U: the part around the selection, then the assembly around that. */
function selectUp() {
  const first = [...selection][0];
  if (!first) return;
  const f = selFolder ? selFolder.parent : first.userData.folder;
  if (f && f !== tree.root) selectFolder(f);
}
const sel = () => [...selection];
const BODY_CMDS = [
  { key: 'h', label: 'Hide', run: () => { for (const m of sel()) setBodyVisible(m, false); syncRows(); } },
  { key: 't', label: 'See-through', run: () => { const on = !sel().every((m) => m.userData.ghost); for (const m of sel()) setBodyGhost(m, on); syncRows(); }, on: () => selection.size && sel().every((m) => m.userData.ghost) },
  { key: 's', label: 'Show only these', run: () => { if (!selection.size) return; for (const o of model.children) setBodyVisible(o, selection.has(o)); syncRows(); } },
  { key: 'u', label: 'Select the part around', run: selectUp },
  { key: 'h', shift: true, label: 'Show all', run: () => { for (const o of model.children) { setBodyVisible(o, true); setBodyGhost(o, false); } syncRows(); } },
];

// --- appearance: a material from the list and/or a colour, on top of what the file says.
// Saved per file in this browser, undoable like everything else.
const MATERIALS = [
  ['Plastic - Matte', [0.92, 0.91, 0.88]], ['Plastic - Glossy', [0.92, 0.91, 0.88]], ['Rubber - Soft', [0.08, 0.08, 0.08]],
  ['Paint - Gloss', [0.75, 0.1, 0.08]], ['Aluminum - Satin', [0.91, 0.92, 0.92]], ['Aluminum - Anodized', [0.2, 0.2, 0.22]],
  ['Steel - Satin', [0.66, 0.66, 0.67]], ['Stainless Steel - Polished', [0.8, 0.8, 0.81]], ['Chrome - Polished', [0.9, 0.9, 0.92]],
  ['Brass - Polished', [0.88, 0.72, 0.4]], ['Copper - Satin', [0.95, 0.64, 0.54]], ['Gold - Polished', [1, 0.84, 0.45]],
  ['Glass - Clear', [0.9, 0.95, 1]], ['PCB - Solder Mask', [0.05, 0.35, 0.15]],
];
const hexOf = (rgb) => `#${new THREE.Color().setRGB(...rgb, THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace)}`;
const rgbOf = (hex) => { const c = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace); const o = {}; c.getRGB(o, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; };
function shownColor(m) {
  if (m.userData.override?.color) return m.userData.override.color;
  const c = [].concat(m.userData.source ?? [])[0]?.color;
  if (!c) return [0.73, 0.72, 0.7];
  const o = {}; c.getRGB(o, THREE.SRGBColorSpace); return [o.r, o.g, o.b];
}
function setAppearance(ms, patch) {
  for (const m of ms) {
    if (patch === null) delete m.userData.override;
    else m.userData.override = { ...m.userData.override, ...patch };
    styleMesh(m);
  }
  if (ui.look !== 'shaded') { ui.look = $('#look').value = 'shaded'; for (const m of model.children) styleMesh(m); }
  saveAppearance();
}
const appearanceKey = () => `cadgang-appearance:${subject}`;
function saveAppearance() {
  const items = {};
  model.children.forEach((m, i) => { if (m.userData.override) items[i] = m.userData.override; });
  try { if (Object.keys(items).length) localStorage.setItem(appearanceKey(), JSON.stringify({ n: model.children.length, items })); else localStorage.removeItem(appearanceKey()); } catch {}
}
function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(appearanceKey()));
    if (saved?.n !== model.children.length) return;   // the file changed shape: its old choices no longer line up
    for (const [i, o] of Object.entries(saved.items)) { const m = model.children[i]; if (m) { m.userData.override = o; styleMesh(m); } }
  } catch {}
}

function showBodyMenu(x, y) {
  if (!selection.size) return;
  const ms = sel(), one = ms.length === 1 ? ms[0] : null;
  const title = Object.assign(document.createElement('div'), { className: 'title',
    textContent: selFolder ? `${selFolder.name} · ${ms.length} bodies` : one ? labelOf(one) : `${ms.length} bodies` });
  // material and colour
  const mat = document.createElement('select');
  mat.className = 'ghost';
  mat.append(new Option('As file', ''), ...MATERIALS.map(([n]) => new Option(n, n)));
  const mats0 = new Set(ms.map((m) => m.userData.override?.material ?? ''));
  mat.value = mats0.size === 1 ? [...mats0][0] : '';
  mat.addEventListener('change', () => {
    const preset = MATERIALS.find(([n]) => n === mat.value);
    setAppearance(ms, preset ? { material: preset[0], color: preset[1] } : null);
    color.value = hexOf(shownColor(ms[0]));
  });
  const color = Object.assign(document.createElement('input'), { type: 'color', value: hexOf(shownColor(ms[0])), title: 'Colour' });
  color.addEventListener('input', () => setAppearance(ms, { color: rgbOf(color.value) }));
  const appear = Object.assign(document.createElement('div'), { className: 'appear' });
  appear.append(mat, color);
  bodyMenu.replaceChildren(title, ...BODY_CMDS.map((c) => {
    const b = document.createElement('button');
    b.className = 'ghost' + (c.on?.() ? ' on' : '');
    b.append(Object.assign(document.createElement('span'), { textContent: c.label }), Object.assign(document.createElement('kbd'), { textContent: keyLabel(c) }));
    b.addEventListener('click', () => { c.run(); if (c.key === 'u') showBodyMenu(x, y); else bodyMenu.hidden = true; });
    return b;
  }), appear);
  bodyMenu.hidden = false;
  bodyMenu.style.left = `${Math.min(x + 12, innerWidth - bodyMenu.offsetWidth - 8)}px`;
  bodyMenu.style.top = `${Math.min(y + 12, innerHeight - bodyMenu.offsetHeight - 8)}px`;
}
document.addEventListener('pointerdown', (e) => { if (!bodyMenu.contains(e.target) && e.target !== renderer.domElement && !e.target.closest?.('#bodies')) bodyMenu.hidden = true; });
function applyExplode() {
  const k = parseFloat($('#explode').value) / 100;
  for (const m of model.children) {
    const off = m.userData.offset ?? new THREE.Vector3();
    m.position.copy(off).multiplyScalar(k * 2);
    if (m.userData.edges) m.userData.edges.position.copy(m.position);
  }
  measure.invalidate();
}
$('#explode').addEventListener('input', applyExplode);

function finishLoad(name, ms) {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) { say(`${name}: nothing to show`, true); return; }
  bbox = box;
  measure.clear();
  history.list = []; history.i = -1; queueMicrotask(commit);
  const size = box.getSize(new THREE.Vector3());
  let tris = 0, verts = 0, segs = 0;
  for (const m of model.children) {
    const g = m.geometry, n = g.index ? g.index.count : g.getAttribute('position').count;
    verts += g.getAttribute('position').count;
    if (m.isLine) segs += n / 2; else tris += n / 3;
  }
  $('#fileName').textContent = name;
  document.title = `cadgang · ${name}`;
  $('#measures').textContent = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  $('#stats').textContent = `${model.children.length} BOD${model.children.length === 1 ? 'Y' : 'IES'} · ${segs ? `${segs.toLocaleString()} SEGS · ` : ''}${tris ? `${tris.toLocaleString()} TRIS · ` : ''}${verts.toLocaleString()} VERTS · ${ms} MS`;
  $('#drop').hidden = true; $('#loadError').textContent = '';
  // A file that paints itself opens as painted, whatever look the last file was left in.
  const painted = model.children.some((m) => m.userData.source);
  if (painted && ui.look !== 'shaded') { ui.look = $('#look').value = 'shaded'; for (const m of model.children) styleMesh(m); }
  placeGrid();
  loadAppearance();
  listBodies();
  setupSection();
  // A flat drawing is read from above and handled like paper: pan, turn in quarters, flip over.
  ui.flat = size.z < 1e-9; $('#sideBtn').hidden = !ui.flat;
  if (ui.flat) setView('3');
  fit();
  edges.visible = ui.edges;
  say(`${name} in ${ms} ms${painted ? ' · its own colours (L: other looks)' : ''}`);
  loadMarkup();
  postSnapshot();
}

function placeGrid() {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid = null; }
  if (!bbox) return;
  const size = bbox.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y) * 2 || 100;
  const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
  const divs = Math.max(2, Math.round(span / step));
  grid = new THREE.GridHelper(divs * step, divs, 0xbdbdbd, 0xe3e3e3);
  grid.rotation.x = Math.PI / 2;            // the part's Z is up
  grid.position.set((bbox.min.x + bbox.max.x) / 2, (bbox.min.y + bbox.max.y) / 2, bbox.min.z - step * 0.01); // a hair under a flat drawing
  grid.visible = ui.grid;
  scene.add(grid);
}

// ------------------------------------------------------------------- camera

const orbit = { yaw: -0.6, pitch: 0.5, dist: 160, target: new THREE.Vector3() };
function applyCamera() {
  const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
  camera.position.set(
    orbit.target.x + orbit.dist * cp * Math.sin(orbit.yaw),
    orbit.target.y - orbit.dist * cp * Math.cos(orbit.yaw),
    orbit.target.z + orbit.dist * sp
  );
  camera.up.set(-sp * Math.sin(orbit.yaw), sp * Math.cos(orbit.yaw), cp);   // follows the orbit: no pole, no limit
  camera.lookAt(orbit.target);
  if (camera === persp) {
    camera.near = Math.max(orbit.dist / 1000, 0.01);
    camera.far = orbit.dist * 100;
  } else {
    // Same framing as the perspective view at this distance: the visible half-height at the target.
    const h = orbit.dist * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    camera.top = h; camera.bottom = -h; camera.left = -h * persp.aspect; camera.right = h * persp.aspect;
    camera.near = -orbit.dist * 100; camera.far = orbit.dist * 100;
  }
  camera.updateProjectionMatrix();
}

function fit() {
  if (!bbox) return;
  bbox.getCenter(orbit.target);
  const r = bbox.getSize(new THREE.Vector3()).length() / 2;
  orbit.dist = r / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2)) * 1.1;
}

const VIEWS = { 1: [0, 0], 2: [Math.PI, 0], 3: [0, Math.PI / 2 - 1e-4], 4: [0, -Math.PI / 2 + 1e-4], 5: [Math.PI / 2, 0], 6: [-Math.PI / 2, 0], 7: [-0.6, 0.5] };
function setView(n) { const v = VIEWS[n]; if (v) { orbit.yaw = v[0]; orbit.pitch = v[1]; } }

let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  bodyMenu.hidden = true;
  // SolidWorks mouse: middle drag rotates, ctrl+middle pans, shift+middle zooms. Left drag
  // rotates too and right drag pans, since nothing here selects by dragging.
  if (e.button === 1) e.preventDefault();
  const zoom = e.button === 1 && e.shiftKey;
  drag = { x: e.clientX, y: e.clientY, zoom, pan: !zoom && (e.button === 2 || e.shiftKey || (e.button === 1 && e.ctrlKey)), downX: e.clientX, downY: e.clientY, click: e.button === 0 };
  if (e.button === 0 && !e.shiftKey && !measure.on && onCap(e)) drag.sect = sectionScreenAxis(e);
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) { if (measure.on) measure.hover(e); else renderer.domElement.classList.toggle('oncap', onCap(e)); return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.sect) {
    // slide the plane along its axis by the pointer's travel projected onto that axis on screen
    const { sx, sy } = drag.sect;
    const i = 'xyz'.indexOf(section.axis);
    const lo = bbox.min.getComponent(i), hi = bbox.max.getComponent(i);
    const at = lo + (hi - lo) * ($('#sectPos').value / 1000) + dx * sx + dy * sy;
    $('#sectPos').value = Math.round(THREE.MathUtils.clamp((at - lo) / (hi - lo), 0, 1) * 1000);
    updateSection();
    return;
  }
  if (drag.zoom) { orbit.dist *= Math.exp(dy * 0.005); return; }   // drag up: closer
  if (drag.pan || ui.flat) {
    const k = orbit.dist * 0.0015;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  } else {
    orbit.yaw -= dx * 0.006;   // the part follows the pointer: drag left, its front turns left
    orbit.pitch += dy * 0.006;
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  const still = drag && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 4;
  if (drag?.click && measure.on && still) measure.click(e);
  else if (drag?.click && still && !drag.sect && !ui.flat) {
    const m = bodyAt(e);
    select(m ? [m] : [], { add: e.shiftKey });
    showBodyMenu(e.clientX, e.clientY);
  } else if (still && e.button !== 2) bodyMenu.hidden = true;
  if (e.button === 2 && still) showMenu(e.clientX, e.clientY);
  if (drag?.sect) commit();
  drag = null;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
const raycaster = new THREE.Raycaster();
function hitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return raycaster.intersectObjects(model.children, false)[0]?.point ?? null;
}
attachOrbitInput(renderer.domElement, { orbit, getCamera: () => camera, THREE, hitAt, isFlat: () => ui.flat });

// Is the pointer over a cut face? The first hit on the kept side of the plane
// being a back face means the ray entered the solid through the cut.
function onCap(e) {
  if (!section.axis || !bbox) return false;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(model.children, true).find((h) => h.object.visible && h.object.parent.visible && section.plane.distanceToPoint(h.point) > -1e-6);
  return !!hit && hit.object.material === capMaterial;
}
// World units the plane moves per pixel of pointer travel in x and y: one unit
// along the axis, projected to screen at the grabbed cap point, then inverted.
// ponytail: onCap raycasts every hover; a BVH is the upgrade if huge models drag.
function sectionScreenAxis(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const i = 'xyz'.indexOf(section.axis);
  const p0 = raycaster.ray.intersectPlane(section.plane, new THREE.Vector3()) ?? orbit.target.clone(); // raycaster set by onCap
  const p1 = p0.clone(); p1.setComponent(i, p1.getComponent(i) + 1);
  const a = p0.project(camera), b = p1.project(camera);
  const sx = (b.x - a.x) * r.width / 2, sy = -(b.y - a.y) * r.height / 2;
  const len2 = sx * sx + sy * sy || 1;
  return { sx: sx / len2, sy: sy / len2 };
}

// ------------------------------------------------------------------ section

// Caps: when a section is on, each body renders front faces only and a twin
// mesh renders its BACK faces in a flat cap colour. Looking into the cut you see
// solid material, hollow walls read as rings, and nothing depends on stencil
// parity — the stencil version held on a shelled box and failed on a merged
// STEP in WebKit.
const capMaterial = new THREE.MeshBasicMaterial({ color: 0x8e8c86, side: THREE.BackSide });
function buildCaps() {
  for (const m of model.children) {
    if (m.userData.cap) { m.remove(m.userData.cap); m.userData.cap = null; }
    if (m.isLine) continue;
    const on = !!section.axis && !!bbox;
    for (const mt of mats(m)) mt.side = on ? THREE.FrontSide : THREE.DoubleSide;
    if (!on || m.userData.ghost) continue;
    const cap = new THREE.Mesh(m.geometry, capMaterial);
    cap.renderOrder = -1;
    m.add(cap);
    m.userData.cap = cap;
  }
  capMaterial.clippingPlanes = section.axis && bbox ? [section.plane] : [];
}

function setSectionAxis(axis) {
  $('#sectAxis').dataset.axis = axis;
  for (const b of $('#sectAxis').querySelectorAll('[data-sect]')) b.classList.toggle('on', b.dataset.sect === axis);
  setupSection();
}
function setupSection() {
  const axis = $('#sectAxis').dataset.axis;
  section.axis = axis;
  $('#sectPos').disabled = $('#sectFlip').disabled = !axis;
  const planes = axis && bbox ? [section.plane] : [];
  for (const m of model.children) for (const mt of mats(m)) mt.clippingPlanes = planes;
  edgeMaterial.clippingPlanes = planes; // edges follow the cut, or they float over the cap
  updateSection();
  buildCaps();
}
function updateSection() {
  if (!section.axis || !bbox) return;
  const i = 'xyz'.indexOf(section.axis);
  const lo = bbox.min.getComponent(i), hi = bbox.max.getComponent(i);
  const at = lo + (hi - lo) * ($('#sectPos').value / 1000);
  const n = new THREE.Vector3(); n.setComponent(i, -section.flip);
  section.plane.set(n, section.flip * at);
}
for (const b of $('#sectAxis').querySelectorAll('[data-sect]')) b.addEventListener('click', () => setSectionAxis(b.dataset.sect));
$('#sectPos').addEventListener('input', updateSection);
$('#sectFlip').addEventListener('click', () => { section.flip *= -1; updateSection(); });

// ------------------------------------------------------------------ loaders

const loaders = {
  stl: () => new STLLoader(), obj: () => new OBJLoader(), ply: () => new PLYLoader(),
  gltf: () => new GLTFLoader(), glb: () => new GLTFLoader(), '3mf': () => new ThreeMFLoader(), fbx: () => new FBXLoader(),
};

/** Every mesh in a loaded scene, baked to world space, with its materials when they say anything. */
function collectGeometries(obj, out = []) {
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const list = [].concat(o.material);
    // glTF splits a node per material into one mesh each (named node_1, node_2…): those keep the
    // node's name, and their material tells them apart. The folders are the named ancestors, top first.
    const split = list.length === 1 && o.parent && o.parent !== obj && o.parent.children.filter((c) => c.isMesh).length > 1;
    const path = [];
    for (let a = o.parent; a && a !== obj; a = a.parent) if (a.name) path.unshift(a.name);
    const name = (split ? path[path.length - 1] : o.name) || '';
    out.push({ geo, source: list.some(informative) ? list : null, name, path, appearance: list.length === 1 ? list[0].name ?? '' : '' });
  });
  return out;
}
/** STL and PLY carry colour per vertex, if at all. */
const vertexColored = (geo) => (geo.getAttribute('color')
  ? [new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.5, ...(geo.alpha < 1 ? { transparent: true, opacity: geo.alpha } : {}) })]
  : null);

async function parseMesh(ext, buffer, name) {
  if (ext === 'dxf') {
    const { parts, skipped } = parseDxf(new TextDecoder().decode(buffer), { THREE, NURBSCurve });
    const n = Object.values(skipped).reduce((a, b) => a + b, 0);
    if (n) say(`${name}: ${n} ${Object.keys(skipped).join('/')} entit${n === 1 ? 'y' : 'ies'} not drawn`);
    if (!parts.length) throw new Error('no drawable entities');
    return parts;
  }
  const loader = loaders[ext]();
  if (ext === 'stl') { const geo = loader.parse(buffer); return [{ geo, flat: true, source: vertexColored(geo) }]; }
  if (ext === 'ply') { const geo = loader.parse(buffer); return [{ geo, source: vertexColored(geo) }]; }
  if (ext === 'obj') return collectGeometries(loader.parse(new TextDecoder().decode(buffer)));
  if (ext === '3mf' || ext === 'fbx') return collectGeometries(loader.parse(buffer, ''));
  const gltf = await new Promise((ok, bad) => loader.parse(buffer, '', ok, bad));
  return collectGeometries(gltf.scene);
}

function parseCad(buffer) {
  const [nPos, nIdx, nFaces, nBodies, nMetaBytes] = new Uint32Array(buffer, 0, 5);
  let off = 20;
  const pos = new Float32Array(buffer, off, nPos); off += nPos * 4;
  const idx = new Uint32Array(buffer, off, nIdx); off += nIdx * 4;
  const fr = new Uint32Array(buffer, off, nFaces * 2); off += nFaces * 8;
  const br = new Uint32Array(buffer, off, nBodies * 2); off += nBodies * 8;
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off, nMetaBytes)));
  const faces = Array.from({ length: nFaces }, (_, i) => ({ first: fr[2 * i], count: fr[2 * i + 1] }));
  for (const [i, r, g, b] of meta.faceColors ?? []) faces[i].color = [r, g, b];
  const parts = [];
  for (let b = 0; b < nBodies; b++) {
    const first = br[2 * b], count = br[2 * b + 1];
    const sub = subGeometry(pos, idx, first, count);
    const ownFaces = faces.filter((f) => f.first >= first && f.first < first + count);
    const own = ownFaces.map((f) => ({ first: f.first - first, count: f.count }));
    const shade = splitByFace(sub.pos, sub.idx, own);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(shade.pos, 3));
    geo.setIndex(new THREE.BufferAttribute(shade.idx, 1));
    const look = meta.bodies[b];
    parts.push({ geo, edgeLines: faceBorderEdges(sub.pos, sub.idx, own), faces: own, name: look.name, path: look.path ?? [], appearance: look.material ?? '', source: bodyMaterials(geo, look, ownFaces, first) });
  }
  return parts;
}

/**
 * The materials of one B-rep body: its own appearance, plus one per distinct face
 * colour, laid on with geometry groups (faces are contiguous triangle runs). Null
 * when the file says nothing, so SHADED falls back to the plain preset.
 */
function bodyMaterials(geo, look, faces, first) {
  if (!look.color && !look.material && look.opacity === 1 && !faces.some((f) => f.color)) return null;
  const list = [appearanceMaterial(look)];
  if (!faces.some((f) => f.color)) return list;
  const slot = new Map();
  let run = null;
  for (const f of faces) {
    const key = f.color ? f.color.join() : '';
    if (!slot.has(key)) { slot.set(key, list.length); list.push(appearanceMaterial({ ...look, color: f.color })); }
    const mi = key ? slot.get(key) : 0;
    if (run && run.materialIndex === mi && run.start + run.count === (f.first - first) * 3) run.count += f.count * 3;
    else { run = { start: (f.first - first) * 3, count: f.count * 3, materialIndex: mi }; geo.groups.push(run); }
  }
  return list;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/view' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchBuffer(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** A load that failed shows its reason in the empty viewport, not only in the footer. */
function loadFailed(name, e) {
  say(`${name}: ${e.message}`, true);
  const drop = $('#drop');
  drop.hidden = false;
  $('#loadError').textContent = `${name}: ${e.message}`;
}

// Each open takes a ticket; an older one still loading drops its result instead of stacking onto the newer.
let loadTicket = 0;

/** Open from bytes (drop / file picker). Several files stack into one scene. */
async function openBuffers(files) {
  const t0 = performance.now(), ticket = ++loadTicket;
  clearModel();
  subject = files.map((f) => f.name).join('|');   // bytes have no path: markups attach by name

  let shown = 0, label = '';
  for (const { name, buffer } of files) {
    const ext = name.toLowerCase().split('.').pop();
    say(`loading ${name}…`);
    try {
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?name=${encodeURIComponent(name)}`, { method: 'POST', body: buffer }))
        : await parseMesh(ext, buffer, name);
      if (ticket !== loadTicket) return;
      for (const p of parts) addPart(p, name);
      shown++; label = name;
    } catch (e) { if (ticket === loadTicket) loadFailed(name, e); return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0));
}

/** Open from absolute paths — the macOS shell calls this with what Finder handed it. */
window.cadgangOpen = async function cadgangOpen(paths) {
  const t0 = performance.now(), ticket = ++loadTicket;
  clearModel();
  subject = [].concat(paths).join('|');   // markups attach to the file by path
  let shown = 0, label = '';
  for (const p of [].concat(paths)) {
    const name = p.split('/').pop();
    say(`loading ${name}…`);
    try {
      const q = `path=${encodeURIComponent(p)}`;
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?${q}`, { method: 'POST' }))
        : await parseMesh(name.toLowerCase().split('.').pop(), await fetchBuffer(`/api/view/file?${q}`), name);
      if (ticket !== loadTicket) return;
      for (const part of parts) addPart(part, name);
      shown++; label = name;
    } catch (e) { if (ticket === loadTicket) loadFailed(name, e); return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0));
};

async function filesToBuffers(fileList) {
  return Promise.all([...fileList].map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })));
}
// The whole page is the drop zone: a file let go over the toolbar should open too.
document.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('dragover'); });
document.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
document.addEventListener('drop', async (e) => {
  e.preventDefault(); viewport.classList.remove('dragover');
  if (e.dataTransfer.files.length) openBuffers(await filesToBuffers(e.dataTransfer.files));
});
$('#openBtn').addEventListener('click', () => $('#fileInput').click());
// Only the Mac shell can register file associations; the button exists only inside it.
$('#defaultBtn').hidden = !window.cadgangDesktop;
$('#defaultBtn').addEventListener('click', () => window.webkit?.messageHandlers?.cadgang?.postMessage({ cmd: 'defaultApp' }));
window.cadgangNotify = (text, bad) => say(text, bad);
$('#fileInput').addEventListener('change', async (e) => { if (e.target.files.length) openBuffers(await filesToBuffers(e.target.files)); e.target.value = ''; });

// ----------------------------------------------------------------- toggles

function toggle(name, btn) {
  ui[name] = !ui[name];
  $(btn).classList.toggle('on', ui[name]);
  edges.visible = ui.edges;
  if (grid) grid.visible = ui.grid;
  for (const m of model.children) styleMesh(m);
  paintRows();
}
$('#colorBtn').addEventListener('click', () => toggle('color', '#colorBtn'));
$('#edgesBtn').addEventListener('click', () => toggle('edges', '#edgesBtn'));
$('#wireBtn').addEventListener('click', () => toggle('wire', '#wireBtn'));
$('#gridBtn').addEventListener('click', () => toggle('grid', '#gridBtn'));
$('#fitBtn').addEventListener('click', fit);
$('#look').addEventListener('change', (e) => { ui.look = e.target.value; for (const m of model.children) styleMesh(m); });
function setOrtho(on) {
  ui.ortho = on;
  camera = on ? ortho : persp;
  $('#orthoBtn').classList.toggle('on', on);
}
$('#orthoBtn').addEventListener('click', () => setOrtho(!ui.ortho));

// ------------------------------------------------------------------ measure
// Snapping dimensions that stay on the page; see measure.js. They live in the
// undo history as data, so ⌘Z removes the last one.

const measure = createMeasure({
  THREE, scene, renderer, model, layer: $('#measureLayer'),
  getCamera: () => camera, getOrbit: () => orbit, say, onChange: () => commit(),
});
function setMeasure(on) {
  measure.setOn(on);
  $('#measureBtn').classList.toggle('on', on);
}
$('#measureBtn').addEventListener('click', () => setMeasure(!measure.on));

// ------------------------------------------------------------------- theme

const THEME_KEY = 'cwt-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#themeToggle').textContent = t === 'dark' ? 'LIGHT' : 'DARK';
  scene.background = new THREE.Color(t === 'dark' ? 0x1a1a18 : 0xffffff);
  for (const m of model.children) if (m.isLine) styleMesh(m);
  try { localStorage.setItem(THEME_KEY, t); } catch {}
}
$('#themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
let theme = 'light';
try { theme = localStorage.getItem(THEME_KEY) || theme; } catch {}
applyTheme(theme);


// ------------------------------------------------------------------ markup

const markup = createMarkup({
  THREE, renderer, scene, orbit, layer: $('#markupLayer'), tools: $('#markupTools'),
  getCamera: () => camera, getTargets: () => model.children,
  onChange: (items) => { markupChanged(items); commit(); },
});
let markupTimer = null;
let subject = '';   // what is open: the file path(s) from the shell, or the dropped file name(s)
function markupChanged(items) {
  clearTimeout(markupTimer);
  markupTimer = setTimeout(() => {
    if (subject) api('/markup', { method: 'PUT', body: { subject, markups: items } }).catch((e) => say(e.message, true));
    postSnapshot();
  }, 400);
}
function loadMarkup() {
  if (!subject) return;
  api(`/markup?subject=${encodeURIComponent(subject)}`).then((d) => { markup.load(d.markups); commit(); }).catch(() => {});
}
let snapshotTimer = null;
/** Post what is on screen; coalesced, since a stroke is many change events. */
function postSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    try {
      const png = markup.snapshot();
      fetch('/api/view/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ png, subject, camera: { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist, target: orbit.target.toArray() } }) }).catch(() => {});
    } catch {}
  }, 150);
}

// The server restarts under the app (a deploy); reconnect, and when
// it comes back as a NEWER version reload so the page is never older than its server.
let pageVersion = null;
(function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello' && msg.version) { if (pageVersion && pageVersion !== msg.version) location.reload(); pageVersion = msg.version; }
    if (msg.type === 'snapshot_request') postSnapshot();
    if (msg.type === 'markup_changed' && msg.subject === subject) loadMarkup();
    if (msg.type === 'open' && msg.paths?.length) window.cadgangOpen(msg.paths);   // pushed from MCP
  };
  ws.onclose = () => setTimeout(connect, 1500);
})();

// -------------------------------------------------------------------- loop

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (renderer.domElement.width !== w * renderer.getPixelRatio() || renderer.domElement.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h);
    persp.aspect = w / h;
    persp.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(viewport);
(function loop() {
  resize();
  applyCamera();
  renderer.render(scene, camera);
  measure.projectLabels();
  markup.projectLabels();
  requestAnimationFrame(loop);
})();

fetch('/api/health').then((r) => r.json()).then((h) => { $('#version').textContent = 'v' + h.version; }).catch(() => {});
// For headless drives: the scene objects behind the page.
window.__view = { model, section, orbit, ui, measure, THREE, get camera() { return camera; },
  project: (x, y, z) => { const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3(x, y, z).project(camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; } };
// Files queued by the shell before the page was ready.
if (window.cadgangPending?.length) window.cadgangOpen(window.cadgangPending);
// ?open=/abs/a.step|/abs/b.stl — the same local-path door, for the shell and for headless tests.
// ?section=z:0.3 and ?explode=0.4 set the tools once the file is in (a pushed view, a test harness).
const params = new URLSearchParams(location.search);
const openArg = params.get('open');
if (openArg) window.cadgangOpen(openArg.split('|')).then(() => {
  const sec = params.get('section')?.match(/^([xyz]):([\d.]+)$/);
  if (sec) { $('#sectPos').value = Math.round(parseFloat(sec[2]) * 1000); setSectionAxis(sec[1]); }
  const ex = parseFloat(params.get('explode'));
  if (ex > 0) { $('#explode').value = Math.round(ex * 100); applyExplode(); }
});

// ------------------------------------------------------------- commands
// One table drives the hotkeys, the right-click menu and the hover tips.

const CMDS = [
  { key: 'f', label: 'Fit', run: fit, btn: '#fitBtn' },
  { key: 'e', label: 'Edges', run: () => toggle('edges', '#edgesBtn'), btn: '#edgesBtn', on: () => ui.edges },
  { key: 'w', label: 'Wireframe', run: () => toggle('wire', '#wireBtn'), btn: '#wireBtn', on: () => ui.wire },
  { key: 'g', label: 'Grid', run: () => toggle('grid', '#gridBtn'), btn: '#gridBtn', on: () => ui.grid },
  { key: 'c', label: 'Color parts', run: () => toggle('color', '#colorBtn'), btn: '#colorBtn', on: () => ui.color },
  { key: 'o', label: 'Orthographic', run: () => setOrtho(!ui.ortho), btn: '#orthoBtn', on: () => ui.ortho },
  { key: 'l', label: 'Next look', btn: '#look', run: () => { const s = $('#look'); s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event('change', { bubbles: true })); } },
  { key: 'm', label: 'Measure', run: () => setMeasure(!measure.on), btn: '#measureBtn', on: () => measure.on },
  { sep: true },
  ...BODY_CMDS.map((c) => ({ ...c, label: { h: 'Hide selected', t: 'Selected see-through', s: 'Show only selected', u: 'Select the part around' }[c.shift ? '' : c.key] ?? c.label })),
  { sep: true },
  { key: 'b', label: 'Flip drawing over', btn: '#sideBtn', run: () => { orbit.pitch = -orbit.pitch; } },
  { key: '[', label: 'Turn left 90°', run: () => { orbit.yaw -= Math.PI / 2; } },
  { key: ']', label: 'Turn right 90°', run: () => { orbit.yaw += Math.PI / 2; } },
  { sep: true },
  ...['x', 'y', 'z'].map((a) => ({ key: a, label: `Section ${a.toUpperCase()}`, btn: `[data-sect="${a}"]`, run: () => setSectionAxis(section.axis === a ? '' : a), on: () => section.axis === a })),
  { key: 'i', label: 'Invert section', btn: '#sectFlip', run: () => { if (section.axis) { section.flip *= -1; updateSection(); } } },
  { key: 'Escape', label: 'Section off', btn: '[data-sect=""]', run: () => { if (measure.cancel()) return; if (selection.size) { select([]); return; } setSectionAxis(''); setMeasure(false); } },
  { sep: true },
  ...['front', 'back', 'top', 'bottom', 'right', 'left', 'iso'].map((n, i) => ({ key: String(i + 1), label: `View ${n}`, run: () => setView(String(i + 1)) })),
  { sep: true },
  ...[['p', 'pen', 'Pen'], ['a', 'arrow', 'Arrow'], ['n', 'note', 'Note'], ['r', 'erase', 'Erase']].map(([key, t, label]) => ({ key, label, btn: `[data-tool="${t}"]`, run: () => markup.setTool(t), on: () => $(`[data-tool="${t}"]`).classList.contains('on') })),
  { key: 'Backspace', label: 'Clear markup', btn: '[data-clear]', run: () => $('[data-clear]').click() },
  { sep: true },
  { key: 'd', label: 'Dark / light', btn: '#themeToggle', run: () => $('#themeToggle').click(), on: () => document.documentElement.dataset.theme === 'dark' },
  { key: 'o', meta: true, label: 'Open…', btn: '#openBtn', run: () => $('#fileInput').click() },
  { key: 'z', meta: true, label: 'Undo', run: undo },
  { key: 'z', meta: true, shift: true, label: 'Redo', run: redo },
];
const keyLabel = (c) => (c.shift ? '⇧' : '') + (c.meta ? '⌘' : '') + ({ Escape: 'Esc', Backspace: '⌫' }[c.key] ?? c.key.toUpperCase());

window.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input,select,textarea') || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const c = CMDS.find((c) => c.key === key && !!c.meta === (e.metaKey || e.ctrlKey) && !!c.shift === e.shiftKey);
  if (!c) return;
  e.preventDefault(); hideMenu(); bodyMenu.hidden = true; c.run(); commit();
});

// --- undo: a snapshot of the view state after every action; ⌘Z walks back.
// ponytail: whole-state JSON snapshots, not deltas — the state is a few hundred bytes.
const history = { list: [], i: -1 };
function snap() {
  return JSON.stringify({ look: ui.look, edges: ui.edges, wire: ui.wire, grid: ui.grid, color: ui.color, ortho: ui.ortho,
    section: { axis: section.axis, pos: $('#sectPos').value, flip: section.flip }, explode: $('#explode').value,
    bodies: model.children.map((m) => m.visible), ghosts: model.children.map((m) => !!m.userData.ghost), looks: model.children.map((m) => m.userData.override ?? null), markup: markup.items, dims: measure.dims });
}
function commit() {
  const s = snap();
  if (s === history.list[history.i]) return;
  history.list.splice(history.i + 1); history.list.push(s); history.i = history.list.length - 1;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ look: ui.look, edges: ui.edges, wire: ui.wire, grid: ui.grid, color: ui.color, ortho: ui.ortho })); } catch {}
}
// View preferences outlive the page, like the theme. Section, explode and body
// visibility belong to a file and start fresh with it.
const PREFS_KEY = 'cadgang-view';
try {
  const p = JSON.parse(localStorage.getItem(PREFS_KEY));
  if (p?.look in PRESETS) ui.look = $('#look').value = p.look;
  for (const k of ['edges', 'wire', 'grid', 'color']) if (typeof p?.[k] === 'boolean' && ui[k] !== p[k]) toggle(k, `#${k}Btn`);
  if (p?.ortho) setOrtho(true);
} catch {}
function apply(s) {
  const st = JSON.parse(s);
  if (st.look !== ui.look) { ui.look = $('#look').value = st.look; for (const m of model.children) styleMesh(m); }
  for (const k of ['edges', 'wire', 'grid', 'color']) if (ui[k] !== st[k]) toggle(k, `#${k}Btn`);
  if (ui.ortho !== st.ortho) setOrtho(st.ortho);
  $('#sectPos').value = st.section.pos; section.flip = st.section.flip; setSectionAxis(st.section.axis);
  $('#explode').value = st.explode; applyExplode();
  model.children.forEach((m, i) => {
    setBodyVisible(m, st.bodies[i] ?? true); setBodyGhost(m, !!st.ghosts?.[i]);
    const ov = st.looks?.[i] ?? null;
    if (JSON.stringify(m.userData.override ?? null) !== JSON.stringify(ov)) { if (ov) m.userData.override = ov; else delete m.userData.override; styleMesh(m); }
  });
  saveAppearance();
  syncRows();
  if (JSON.stringify(markup.items) !== JSON.stringify(st.markup)) { markup.load(st.markup); markupChanged(st.markup); }
  if (JSON.stringify(measure.dims) !== JSON.stringify(st.dims ?? [])) measure.load(st.dims ?? []);
}
function undo() { if (history.i > 0) apply(history.list[--history.i]); }
function redo() { if (history.i < history.list.length - 1) apply(history.list[++history.i]); }
document.addEventListener('click', commit);   // after every button handler has run
document.addEventListener('change', commit);  // sliders on release, selects, body ticks

// --- right-click menu
const menu = Object.assign(document.createElement('div'), { id: 'ctx', hidden: true });
document.body.appendChild(menu);
function showMenu(x, y) {
  menu.replaceChildren(...CMDS.map((c) => {
    if (c.sep) return document.createElement('hr');
    const b = document.createElement('button');
    b.className = 'ghost' + (c.on?.() ? ' on' : '');
    b.append(Object.assign(document.createElement('span'), { textContent: c.label }), Object.assign(document.createElement('kbd'), { textContent: keyLabel(c) }));
    b.addEventListener('click', () => { hideMenu(); c.run(); });
    return b;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}
function hideMenu() { menu.hidden = true; }
document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) hideMenu(); });

// --- hover tips: the element's title, shown at once and with its hotkey
const tip = Object.assign(document.createElement('div'), { id: 'tip', hidden: true });
document.body.appendChild(tip);
for (const c of CMDS) {
  const el = c.btn && $(c.btn);
  if (el) { el.dataset.tip = `${(el.title || c.label).replace(/\s*\([^)]*\)\s*$/, '')} · ${keyLabel(c)}`; el.removeAttribute('title'); }
}
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip],[title]');
  if (!el) { tip.hidden = true; return; }
  if (el.title) { el.dataset.tip = el.title; el.removeAttribute('title'); }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${r.bottom + 6}px`;
});
document.addEventListener('pointerout', (e) => { if (!e.relatedTarget?.closest?.('[data-tip],[title]')) tip.hidden = true; });
document.addEventListener('pointerdown', () => { tip.hidden = true; });
