// Pipeline correctness: back-face cull == true camera-facing set, radix depth
// sort (spread + full-order monotonicity — the regression the depth-quantization
// sign bug slipped through), near/frustum culling, generational-handle safety,
// and hierarchy world transforms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glMatrix, quat } from 'gl-matrix';
import { createStage, geometry, material, mathKernels, updateCamera } from '../Depth.js';
glMatrix.setMatrixArrayType(Float64Array);

const noop = () => { };
const stubCtx = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const DEPTH_MASK = (1 << 26) - 1;

test('back-face cull == true camera-facing set over 500 random poses', () => {
  const stage = createStage(stubCtx(), { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const g = geometry.box(1, 1, 1); const gid = stage.geometry(g), mid = stage.material(material({}));
  const h = stage.addNode(gid, mid, {});
  const rng = mulberry32(99); const BAND = 0.02; let mismatches = 0;
  const classify = (q, cam) => {
    const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
    const ex = cam.radius * sp * Math.sin(cam.theta), ey = cam.radius * cp, ez = cam.radius * sp * Math.cos(cam.theta);
    const front = new Set(), back = new Set(); const nr = new Float64Array(3), pw = new Float64Array(3);
    for (let fi = 0; fi < g.F; fi++) {
      mathKernels.quatRotate(nr, q[0], q[1], q[2], q[3], g.faceNormal[fi * 3], g.faceNormal[fi * 3 + 1], g.faceNormal[fi * 3 + 2]);
      const vi = g.faceVerts[g.faceVertOffset[fi]] * 3;
      mathKernels.quatRotate(pw, q[0], q[1], q[2], q[3], g.verts[vi], g.verts[vi + 1], g.verts[vi + 2]);
      let dx = ex - pw[0], dy = ey - pw[1], dz = ez - pw[2]; const L = Math.hypot(dx, dy, dz);
      const cos = (nr[0] * dx + nr[1] * dy + nr[2] * dz) / L;
      if (cos > BAND) front.add(fi); else if (cos < -BAND) back.add(fi);
    }
    return { front, back };
  };
  for (let trial = 0; trial < 500; trial++) {
    const q = quat.create(); quat.random(q); stage.setQuaternion(h, q[0], q[1], q[2], q[3]);
    stage.camera.theta = rng() * Math.PI * 2; stage.camera.phi = 0.25 + rng() * 2.6; stage.camera.radius = 6; updateCamera(stage.camera);
    stage.frame(16);
    const drawn = new Set(); for (let i = 0; i < stage._drawCount; i++) drawn.add(stage._draw.face[stage._order[i]]);
    const { front, back } = classify(q, stage.camera);
    let ok = true; for (const f of front) if (!drawn.has(f)) { ok = false; break; }
    if (ok) for (const f of back) if (drawn.has(f)) { ok = false; break; }
    if (!ok) mismatches++;
  }
  assert.equal(mismatches, 0);
});

test('radix depth sort: keys sorted, valid bijection, spread not collapsed, paint order tracks true depth', () => {
  const stage = createStage(stubCtx(), { width: 600, height: 400, maxNodes: 128, maxVerts: 16384, maxDrawFaces: 16384, camera: { radius: 16, near: 0.5, far: 60 } });
  const gid = stage.geometry(geometry.plane(1.2, 1.2)), mid = stage.material(material({}));
  const rng = mulberry32(2024); const pos = [];
  for (let i = 0; i < 60; i++) pos.push([rng() * 16 - 8, rng() * 8 - 4, rng() * 16 - 8]);
  const addOrder = pos.map((_, i) => i).sort((a, b) => pos[a][2] - pos[b][2]); // add in a depth-shuffled order
  for (const i of addOrder) stage.addNode(gid, mid, { x: pos[i][0], y: pos[i][1], z: pos[i][2] });
  stage.frame(16);

  const D = stage._draw, ord = stage._order, dc = stage._drawCount;
  assert.ok(dc > 0);
  for (let i = 1; i < dc; i++) assert.ok(D.key[ord[i]] >= D.key[ord[i - 1]], 'keys not sorted');
  const seen = new Uint8Array(dc); for (let i = 0; i < dc; i++) { const e = ord[i]; assert.ok(e < dc && !seen[e], 'not a bijection'); seen[e] = 1; }

  let kmin = Infinity, kmax = -Infinity;
  for (let i = 0; i < dc; i++) { const k = D.key[ord[i]] & DEPTH_MASK; kmin = Math.min(kmin, k); kmax = Math.max(kmax, k); }
  assert.ok(kmax - kmin > 100000, 'depth keys collapsed (span ' + (kmax - kmin) + ') — quantization bug');

  const centZ = (e) => {
    const node = D.node[e], fi = D.face[e], base = D.vertBase[node], geo = stage._geometries[stage.nodes.data.geom[node]];
    const o0 = geo.faceVertOffset[fi], o1 = geo.faceVertOffset[fi + 1]; let s = 0, n = 0;
    for (let j = o0; j < o1; j++) { s += D.viewZ[base + geo.faceVerts[j]]; n++; } return s / n;
  };
  let prev = -Infinity; for (let i = 0; i < dc; i++) { const z = centZ(ord[i]); assert.ok(z >= prev - 1e-3, 'paint order not depth-monotonic'); prev = z; }
});

test('near-plane + frustum culling', () => {
  const stage = createStage(stubCtx(), { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6, near: 0.5, far: 50 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  const h = stage.addNode(gid, mid, {});
  stage.setPosition(h, 1000, 0, 0); stage.frame(16);
  assert.equal(stage.stats.nodesCulled, 1); assert.equal(stage.stats.facesDrawn, 0);
  stage.setPosition(h, 0, 0, 0); stage.frame(16);
  assert.ok(stage.stats.facesDrawn >= 2 && stage.stats.facesDrawn <= 3);
});

test('generational handle safety after despawn', () => {
  const stage = createStage(stubCtx(), { width: 400, height: 300, maxNodes: 16, maxVerts: 1024, maxDrawFaces: 1024 });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  const a = stage.addNode(gid, mid, { x: -1 }); const b = stage.addNode(gid, mid, { x: 1 });
  stage.remove(a);
  assert.ok(!stage.arena.isAlive(a)); assert.ok(stage.arena.isAlive(b));
  const c = stage.addNode(gid, mid, { x: 0 });
  assert.notEqual(c, a);
  stage.frame(16); assert.ok(stage.stats.facesDrawn > 0);
});

test('hierarchy: child world = parent * local', () => {
  const stage = createStage(stubCtx(), { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512 });
  const gid = stage.geometry(geometry.box(0.5, 0.5, 0.5)), mid = stage.material(material({}));
  const parent = stage.addNode(gid, mid, { x: 3, y: 0, z: 0 }); stage.setEuler(parent, 0, Math.PI / 2, 0);
  const child = stage.addNode(gid, mid, { x: 2, y: 0, z: 0, parent });
  stage.frame(16);
  const D = stage.nodes.data, dc = stage.nodes.idx(child);
  assert.ok(Math.abs(D.m3[dc] - 3) < 1e-4, 'world X ' + D.m3[dc]);
  assert.ok(Math.abs(D.m11[dc] - (-2)) < 1e-4, 'world Z ' + D.m11[dc]);
});
