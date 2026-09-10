// demo/alloc-smoke.mjs -- headless proof that the demo's cold setup + one frame
// resolve against the FROZEN v1.5.0 library surface under the repinned peers.
// NOT a package file (never in package.json files[]); a dev sanity harness only.
//   node demo/alloc-smoke.mjs
import { createStage, geometry, material, updateCamera, FORMAT_VERSION } from '../Depth.js';

// Minimal Canvas2D stub: the demo never runs frame() in Node, but we run one here
// to read stats.nodesNonUniform / nodesCulled and the dirtyRect getters. All paint
// calls are no-ops; the arena math is real.
const noop = () => {};
const ctx = {
  canvas: { width: 800, height: 512 },
  setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
  closePath: noop, fill: noop, stroke: noop, save: noop, restore: noop, rect: noop,
  set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {}, set lineJoin(_) {},
};

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('  FAIL ' + msg); } else console.log('  ok   ' + msg); };

ok(FORMAT_VERSION === 1, 'FORMAT_VERSION === 1 (createStage assert will not throw)');

// Task 3 -- wireframe: all three materials pre-registered, fill/stroke combinations.
const w = createStage(ctx, { width: 800, height: 512, maxNodes: 8, maxVerts: 2048, maxDrawFaces: 2048,
  camera: { radius: 8.5, theta: 0.6, phi: 1.05, near: 0.1, far: 60 } });
const wGeo = w.geometry(geometry.sphere(0.95, 14, 10));
w.addNode(wGeo, w.material(material({ r: 95, g: 227, b: 161, fill: false, stroke: '#5fe3a1', lineWidth: 1.4 })), { x: -2.7 });
w.addNode(wGeo, w.material(material({ r: 79, g: 217, b: 232, ambient: 0.34, fill: true, stroke: '#05070a', lineWidth: 1.4 })), {});
w.addNode(wGeo, w.material(material({ r: 232, g: 107, b: 208, fill: false })), { x: 2.7 });
updateCamera(w.camera);
ok(w.frame(16).drawCalls >= 1, 'wireframe stage frames (fill/stroke style-runs)');

// Task 4 -- hierarchy: non-uniform rotated parent + uniform child, setParent at setup.
const h = createStage(ctx, { width: 800, height: 512, maxNodes: 8, maxVerts: 2048, maxDrawFaces: 2048,
  camera: { radius: 9.5, theta: 0.7, phi: 1.02, near: 0.1, far: 60 } });
const hp = h.addNode(h.geometry(geometry.box(1.6, 1.6, 1.6)), h.material(material({ r: 232, g: 180, b: 95 })), {});
const hc = h.addNode(h.geometry(geometry.box(0.9, 0.9, 0.9)), h.material(material({ r: 79, g: 217, b: 232 })), { y: 1.7 });
h.setScale(hp, 2.1, 0.6, 1.0);
h.setScale(hc, 0.85);
h.setParent(hc, hp);
h.setEuler(hp, 0.3, 0.7, 0.2);
updateCamera(h.camera);
ok(h.frame(16).nodesNonUniform === 1, 'stats.nodesNonUniform === 1 (parent flagged, uniform child not)');

// Task 5 + 6 -- cull, dirtyRect, sceneBox/prevSceneBox getters, clear/reserve.
const C_N = 48, C_CAP = 64;
const c = createStage(ctx, { width: 800, height: 512, maxNodes: C_CAP, maxVerts: C_CAP * 8, maxDrawFaces: C_CAP * 6,
  camera: { radius: 15, theta: 0.6, phi: 1.05, near: 0.5, far: 120 } });
const cBox = c.geometry(geometry.box(1, 1, 1));
const cMat = c.material(material({ r: 95, g: 227, b: 161 }));
const nodes = [];
const build = () => { for (let i = 0; i < C_N; i++) nodes[i] = c.addNode(cBox, cMat, { x: Math.cos(i) * (6 + (i % 8) * 1.7), z: Math.sin(i) * (6 + (i % 8) * 1.7) }); };
build();
updateCamera(c.camera);
c.dirtyRect = true;
const cs = c.frame(16);
ok(typeof cs.nodesCulled === 'number' && typeof cs.facesCulled === 'number', 'stats.nodesCulled / facesCulled present');
ok(c.sceneBox instanceof Float32Array && c.sceneBox.length === 4, 'stage.sceneBox is a packed Float32Array[4]');
ok(c.prevSceneBox instanceof Float32Array && c.prevSceneBox.length === 4, 'stage.prevSceneBox is a packed Float32Array[4]');
const rem0 = c.remainingNodes, ep0 = c.structureEpoch;
ok(rem0 === C_CAP - C_N, 'remainingNodes === capacity - live (' + rem0 + ')');
c.clear();
ok(c.remainingNodes === C_CAP, 'clear() frees all node slots');
ok(c.structureEpoch !== ep0, 'clear() bumps structureEpoch');
build();
const cap = c.remainingNodes + C_N;   // live count is C_N -> this is capacity
c.reserve(cap + 32);                   // demo's "reserve +32": grow capacity by 32
ok(c.remainingNodes === 48, 'reserve(+32) grows capacity -> 48 free slots (16 + 32)');

console.log(fails === 0 ? 'SMOKE ok' : ('SMOKE FAIL (' + fails + ')'));
process.exitCode = fails === 0 ? 0 : 1;
