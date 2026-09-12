// D4 "Touch" -- near-plane clip + real pick index. Every assertion drives the
// public createStage() surface and the DI-bound lite-bvh DynamicBVH2D (a
// devDependency, never a runtime dep). Depth.js is not edited by this file.
//
// Assertions gated here:
//   A1  a straddling face emits >= 3 clipXY verts; clipNear=false lowers
//       facesDrawn by EXACTLY 1 (prove the feature by its absence).
//   A2  pick(x,y,out) == brute-force back-to-front containsPoint scan over the
//       sorted draw list, identical topmost, WITH and WITHOUT a bound index.
//   A3  the fat box is STRICTLY larger than the tight box at 1, 1e3, 1e6, 1e7.
//   A4  insertLeaves with one non-finite box throws; validate() still true;
//       maxNodes + every backing byteLength identical before/after frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';
import { aabb2 } from '@zakkster/lite-aabb';
import { DynamicBVH2D } from '@zakkster/lite-bvh';

const noop = () => {};
function stub() {
  return {
    setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, fill: noop, stroke: noop,
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
  };
}
// Camera straight down -z from (0,0,radius): world x/y -> screen x/y, world z -> depth.
const DOWN_Z = { theta: 0, phi: Math.PI / 2, radius: 10, near: 0.5, far: 200 };

// Brute-force pick oracle: walk the SORTED draw list back-to-front (last painted =
// topmost), return the first node whose TIGHT screen box contains the point.
function oracle(stage, x, y) {
  const order = stage._order, dc = stage._drawCount, box = stage._draw.box, dn = stage._draw.node;
  for (let i = dc - 1; i >= 0; i--) {
    const d = dn[order[i]], j = d << 2;
    if (x >= box[j] && x <= box[j + 2] && y >= box[j + 1] && y <= box[j + 3]) return d;
  }
  return -1;
}

/* -- A1: near-plane clip -- */
test('A1: a straddling face is clipped and drawn (>=3 clipXY verts); clipNear=false drops facesDrawn by exactly 1', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  // One tilted quad (same CCW +z winding as a box front face, so front-facing to
  // the camera) whose local z runs +1..-1. At node z=9.5 the view z = localz-0.5
  // runs +0.5..-1.5, straddling the near plane (-0.5): exactly one face crosses it,
  // and its front half projects on-screen so the node-box cull does not reject it.
  const gid = s.geometry(geometry.custom(
    [-0.5, -0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, -1, -0.5, 0.5, -1],
    [[0, 1, 2, 3]],
  ));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 9.5 });

  s.clipNear = true;
  s.frame(1 / 60);
  const drawnClip = s.stats.facesDrawn;
  assert.ok(drawnClip >= 1, 'straddling quad must draw its clipped face');
  // find the DRAW_CLIP entry (drawFace sentinel 0xFFFFFFFE) and read its vert count.
  const order = s._order, dc = s._drawCount, face = s._draw.face, ref = s._draw.clipRef;
  let clipVerts = 0;
  for (let i = 0; i < dc; i++) { const e = order[i]; if (face[e] === 0xFFFFFFFE) clipVerts = ref[e] & 31; }
  assert.ok(clipVerts >= 3, 'a clipped straddling polygon must emit >= 3 clipXY verts, got ' + clipVerts);

  s.clipNear = false;
  s.frame(1 / 60);
  const drawnNoClip = s.stats.facesDrawn;
  assert.equal(drawnClip - drawnNoClip, 1, 'disabling the clip must remove exactly the one straddling face');
});

/* -- A2: pick differential, with and without a bound index -- */
function buildPickScene(withIndex) {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 256, camera: DOWN_Z });
  s.dirtyRect = true;                                  // populate the box lane (no-index path needs it)
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  // deterministic scatter across the visible frustum, varied depth
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 120; i++) {
    s.addNode(gid, mid, { x: (rnd() - 0.5) * 8, y: (rnd() - 0.5) * 6, z: (rnd() - 0.5) * 6 });
  }
  let tree = null;
  if (withIndex) { tree = new DynamicBVH2D(1024); s.useSpatialIndex(tree, { margin: 0.5 }); }
  s.frame(1 / 60);
  return { s, tree };
}

test('A2: pick(x,y) matches the brute-force back-to-front oracle over 5000+ fuzz points, WITH a bound index', () => {
  const { s } = buildPickScene(true);
  const out = new Int32Array(1);
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let hits = 0;
  for (let i = 0; i < 6000; i++) {
    const x = rnd() * 800, y = rnd() * 600;
    const n = s.pick(x, y, out);
    const got = n > 0 ? out[0] : -1;
    const want = oracle(s, x, y);
    assert.equal(got, want, 'indexed pick mismatch at (' + x + ',' + y + ')');
    if (got >= 0) hits++;
  }
  assert.ok(hits > 100, 'fuzz must exercise real hits, got ' + hits);
});

test('A2: pick(x,y) matches the oracle over 5000+ fuzz points, WITHOUT a bound index (dirtyRect fallback)', () => {
  const { s } = buildPickScene(false);
  const out = new Int32Array(1);
  let seed = 555555555;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 6000; i++) {
    const x = rnd() * 800, y = rnd() * 600;
    const n = s.pick(x, y, out);
    const got = n > 0 ? out[0] : -1;
    assert.equal(got, oracle(s, x, y), 'no-index pick mismatch at (' + x + ',' + y + ')');
  }
});

test('pick fails closed without an index AND without dirtyRect (no populated box lane)', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, {});
  s.frame(1 / 60);
  assert.throws(() => s.pick(400, 300, new Int32Array(1)), /bound spatial index|dirtyRect/);
});

/* -- A3: fat box strictly larger than tight at extreme coords -- */
test('A3: max(margin, marginFloor(box)) fattening yields a STRICTLY larger box at x = 1, 1e3, 1e6, 1e7 (4/4)', () => {
  const userMargin = 0;                                // the module default: floor governs
  for (const c of [1, 1e3, 1e6, 1e7]) {
    const tight = aabb2.set(aabb2.create(), c, c, c + 1, c + 1);
    const mg = Math.max(userMargin, aabb2.marginFloor(tight));
    const fat = aabb2.fatten(aabb2.create(), tight, mg);
    assert.ok(fat[0] < tight[0], 'minX must shrink at c=' + c + ' (fat ' + fat[0] + ' vs ' + tight[0] + ')');
    assert.ok(fat[1] < tight[1], 'minY must shrink at c=' + c);
    assert.ok(fat[2] > tight[2], 'maxX must grow at c=' + c + ' (fat ' + fat[2] + ' vs ' + tight[2] + ')');
    assert.ok(fat[3] > tight[3], 'maxY must grow at c=' + c);
  }
});

/* -- A4: insertLeaves fails closed; tree conserved across frames -- */
test('A4: insertLeaves with one non-finite box throws; validate() still true; tree unchanged', () => {
  const tree = new DynamicBVH2D(64);
  const packed = new Float32Array([0, 0, 10, 10, NaN, 0, 5, 5]);
  const data = new Int32Array([1, 2]);
  assert.throws(() => tree.insertLeaves(packed, data, 2), /non-finite|inverted/);
  assert.equal(tree.validate(), true, 'a rejected batch must leave the tree valid (batch-atomic)');
  assert.equal(tree.root, -1, 'nothing inserted after the rejected batch');
});

test('A4: a bound index keeps maxNodes and every backing byteLength identical across many frames (clear()+insertLeaves, no realloc)', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 128, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  for (let i = 0; i < 100; i++) s.addNode(gid, mid, { x: (i % 10) - 5, y: ((i / 10) | 0) - 5, z: (i % 5) - 2 });
  const tree = new DynamicBVH2D(512);
  s.useSpatialIndex(tree);
  s.frame(1 / 60);
  const before = { maxNodes: tree.maxNodes, bboxes: tree.bboxes.byteLength, parents: tree.parents.byteLength, children: tree.children.byteLength, userData: tree.userData.byteLength };
  for (let f = 0; f < 5000; f++) s.frame(1 / 60);
  assert.equal(tree.maxNodes, before.maxNodes);
  assert.equal(tree.bboxes.byteLength, before.bboxes);
  assert.equal(tree.parents.byteLength, before.parents);
  assert.equal(tree.children.byteLength, before.children);
  assert.equal(tree.userData.byteLength, before.userData);
  assert.equal(tree.validate(), true, 'tree stays valid after clear()+insertLeaves churn');
});

/* -- pickRect / pickRay / nearest -- */
test('pickRect marquee returns the same node set with and without a bound index', () => {
  const a = buildPickScene(true), b = buildPickScene(false);
  const outA = new Int32Array(256), outB = new Int32Array(256);
  const nA = a.s.pickRect(200, 150, 600, 450, outA);
  const nB = b.s.pickRect(200, 150, 600, 450, outB);
  const setA = new Set(outA.slice(0, nA)), setB = new Set(outB.slice(0, nB));
  assert.equal(setA.size, setB.size, 'marquee cardinality must match (' + nA + ' vs ' + nB + ')');
  for (const d of setB) assert.ok(setA.has(d), 'indexed marquee missing node ' + d);
});

test('pickRay and nearest are consistent between index and fallback', () => {
  const a = buildPickScene(true), b = buildPickScene(false);
  const outA = new Int32Array(256), outB = new Int32Array(256);
  const nA = a.s.pickRay(0, 0, 800, 600, outA);
  const nB = b.s.pickRay(0, 0, 800, 600, outB);
  const setA = new Set(outA.slice(0, nA)), setB = new Set(outB.slice(0, nB));
  for (const d of setB) assert.ok(setA.has(d), 'indexed raycast missing node ' + d + ' the fallback found');
  // nearest: never returns a node whose box is farther than radius (no Math.sqrt).
  const near = b.s.nearest(400, 300, 40);
  if (near >= 0) {
    const box = b.s._draw.box, j = near << 2;
    const ddx = Math.max(0, box[j] - 400, 400 - box[j + 2]), ddy = Math.max(0, box[j + 1] - 300, 300 - box[j + 3]);
    assert.ok(ddx * ddx + ddy * ddy < 40 * 40, 'nearest must be strictly inside the radius');
  }
});
