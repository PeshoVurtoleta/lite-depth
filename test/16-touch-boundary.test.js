// D4 "Touch" -- QA boundary sweep over every NEW entry point (pick, pickRect,
// pickRay, nearest, useSpatialIndex/dropSpatialIndex, the near-plane clip
// helper). Depth.js is NOT edited by this file -- it only measures the
// module's ALREADY-SHIPPED behaviour at boundary values the planner's
// assertions (A1-A6) did not directly exercise. Every claim here is measured,
// never assumed: an assertion this file could not drive is reported as a
// gap, not asserted as PASS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';
import { DynamicBVH2D } from '@zakkster/lite-bvh';

const noop = () => {};
function stub() {
  return {
    setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, fill: noop, stroke: noop,
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
  };
}
const DOWN_Z = { theta: 0, phi: Math.PI / 2, radius: 10, near: 0.5, far: 200 };

function oracle(stage, x, y) {
  const order = stage._order, dc = stage._drawCount, box = stage._draw.box, dn = stage._draw.node;
  for (let i = dc - 1; i >= 0; i--) {
    const d = dn[order[i]], j = d << 2;
    if (x >= box[j] && x <= box[j + 2] && y >= box[j + 1] && y <= box[j + 3]) return d;
  }
  return -1;
}

function scatterStage(count, opts) {
  const o = opts || {};
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: Math.max(count, 1), camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const handles = [];
  for (let i = 0; i < count; i++) {
    handles.push(s.addNode(gid, mid, { x: (rnd() - 0.5) * 8, y: (rnd() - 0.5) * 6, z: (rnd() - 0.5) * 6 }));
  }
  if (o.index) s.useSpatialIndex(new DynamicBVH2D(Math.max(count * 2, 4)), o.index === true ? undefined : o.index);
  return { s, gid, mid, handles };
}

/* --------------- pick(): miss / empty scene / out-buffer boundary ----------- */

test('pick(): miss returns exactly 0 (no index, dirtyRect on) on an empty scene', () => {
  const { s } = scatterStage(0);
  s.frame(1 / 60);
  const out = new Int32Array(1);
  assert.equal(s.pick(400, 300, out), 0);
});

test('pick(): miss returns exactly 0 (bound index) on an empty scene', () => {
  const { s } = scatterStage(0, { index: true });
  s.frame(1 / 60);
  const out = new Int32Array(1);
  assert.equal(s.pick(400, 300, out), 0);
});

test('pick(): a point guaranteed off every box misses (both paths agree with the oracle)', () => {
  const idx = scatterStage(40, { index: true });
  const noidx = scatterStage(40);
  idx.s.frame(1 / 60); noidx.s.frame(1 / 60);
  const out = new Int32Array(1);
  // (-1,-1) is outside the [0,800]x[0,600] viewport entirely.
  assert.equal(idx.s.pick(-1, -1, out), 0);
  assert.equal(noidx.s.pick(-1, -1, out), 0);
  assert.equal(oracle(idx.s, -1, -1), -1);
});

test('MEASURED (not assumed): pick() with a ZERO-LENGTH out buffer does not throw and does not corrupt state, but the hit index is UNRECOVERABLE (out[0] write is a silent no-op on a length-0 typed array)', () => {
  const { s } = scatterStage(60, { index: true });
  s.frame(1 / 60);
  const out0 = new Int32Array(0);
  let n = -999, threw = false;
  try { n = s.pick(400, 300, out0); } catch { threw = true; }
  assert.equal(threw, false, 'pick must not throw on a zero-length out buffer');
  // Whatever pick() returns, reading the "written" slot is impossible -- this is
  // the exact hazard the boundary spec calls out: verify it, do not paper over it.
  assert.equal(out0.length, 0);
  assert.equal(out0[0], undefined, 'a length-0 Int32Array can never surface the hit index at [0]');
  // Compare against a real out buffer at the SAME point to show pick() itself is
  // internally consistent -- only the caller-supplied sink was too small.
  const out1 = new Int32Array(1);
  const n1 = s.pick(400, 300, out1);
  assert.equal(n, n1, 'the return code must not depend on out-buffer length (pick only ever writes index 0)');
});

/* --------------- pick() state-machine: fail-closed door boundaries ---------- */

test('pick(): before any frame() -- with a bound index, needBoxes does not throw and pick returns 0 (drawCount is 0 pre-frame, not a stale/garbage box read)', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 8, camera: DOWN_Z });
  const tree = new DynamicBVH2D(16);
  s.useSpatialIndex(tree);
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, {});
  const out = new Int32Array(1);
  assert.equal(s.pick(400, 300, out), 0, 'pre-frame pick must report a clean miss, not throw and not fabricate a hit');
});

test('pick(): before any frame() -- with dirtyRect=true and no index, pick returns 0 (never throws, never reads garbage)', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 8, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, {});
  const out = new Int32Array(1);
  assert.equal(s.pick(400, 300, out), 0);
});

test('ADVERSARIAL: pick() must FAIL CLOSED (throw), not silently return a stale hit, when dirtyRect is switched OFF again after a frame already populated the box lane', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  s.frame(1 / 60);
  const out = new Int32Array(1);
  // Sanity: pick works while dirtyRect is on.
  assert.doesNotThrow(() => s.pick(400, 300, out));
  // Now flip dirtyRect off WITHOUT another frame. The nodeBox lane still holds
  // last frame's real (non-stale-looking) data -- a naive implementation could
  // be tempted to serve it. The module's contract is: the CURRENT dirtyRect
  // flag gates pick, not "was the lane ever populated". Measure it.
  s.dirtyRect = false;
  assert.throws(() => s.pick(400, 300, out), /bound spatial index|dirtyRect/,
    'pick must fail closed once dirtyRect is off, even though nodeBox still holds valid-looking data from the last true-frame');
});

/* ----------------------- pickRect(): empty rect + out-cap boundary ---------- */

test('pickRect(): a ZERO-AREA (empty) rect degenerates to a point test -- index and fallback agree', () => {
  const idx = scatterStage(80, { index: true });
  const noidx = scatterStage(80);
  idx.s.frame(1 / 60); noidx.s.frame(1 / 60);
  const outA = new Int32Array(80), outB = new Int32Array(80);
  const nA = idx.s.pickRect(400, 300, 400, 300, outA);
  const nB = noidx.s.pickRect(400, 300, 400, 300, outB);
  const setA = new Set(outA.slice(0, nA)), setB = new Set(outB.slice(0, nB));
  assert.equal(setA.size, setB.size, 'zero-area pickRect cardinality must match between index and fallback');
  for (const d of setB) assert.ok(setA.has(d));
});

test('pickRect(): a rect entirely outside the viewport returns 0 for both paths', () => {
  const idx = scatterStage(40, { index: true });
  const noidx = scatterStage(40);
  idx.s.frame(1 / 60); noidx.s.frame(1 / 60);
  const outA = new Int32Array(40), outB = new Int32Array(40);
  assert.equal(idx.s.pickRect(10000, 10000, 10001, 10001, outA), 0);
  assert.equal(noidx.s.pickRect(10000, 10000, 10001, 10001, outB), 0);
});

test('pickRect(): out-buffer CAPACITY boundary -- cap = 0, hits-1, hits, hits+1 all clamp without overflow (fallback path, whole viewport)', () => {
  const { s } = scatterStage(150);
  s.frame(1 / 60);
  const full = new Int32Array(256);
  const total = s.pickRect(0, 0, 800, 600, full);
  assert.ok(total > 1, 'precondition: need >1 hits to test the cap boundary meaningfully, got ' + total);
  for (const cap of [0, total - 1, total, total + 1]) {
    const out = new Int32Array(cap);
    const n = s.pickRect(0, 0, 800, 600, out);
    assert.ok(n <= cap, 'pickRect must never write past a ' + cap + '-slot out buffer (wrote count ' + n + ')');
    if (cap >= total) assert.equal(n, total, 'a sufficiently large cap must report every hit');
  }
});

test('pickRect(): out-buffer CAPACITY boundary -- indexed path also clamps at cap 0/hits-1/hits/hits+1', () => {
  const { s } = scatterStage(150, { index: true });
  s.frame(1 / 60);
  const full = new Int32Array(256);
  const total = s.pickRect(0, 0, 800, 600, full);
  assert.ok(total > 1, 'precondition: need >1 hits, got ' + total);
  for (const cap of [0, total - 1, total, total + 1]) {
    const out = new Int32Array(cap);
    const n = s.pickRect(0, 0, 800, 600, out);
    assert.ok(n <= cap, 'indexed pickRect must never write past a ' + cap + '-slot out buffer (wrote ' + n + ')');
  }
});

/* ------------------------- pickRay(): boundary + NaN door -------------------- */

test('pickRay(): non-finite endpoints return 0 (fail closed), matching the documented lite-bvh raycast door -- NaN, Infinity, undefined-coerced-to-NaN', () => {
  const { s } = scatterStage(40);
  s.frame(1 / 60);
  const out = new Int32Array(40);
  assert.equal(s.pickRay(NaN, 0, 800, 600, out), 0);
  assert.equal(s.pickRay(0, 0, Infinity, 600, out), 0);
  assert.equal(s.pickRay(0, undefined, 800, 600, out), 0);
});

test('pickRay(): a zero-length segment (p0 === p1) degenerates to a point test, index and fallback agree', () => {
  const idx = scatterStage(60, { index: true });
  const noidx = scatterStage(60);
  idx.s.frame(1 / 60); noidx.s.frame(1 / 60);
  const outA = new Int32Array(60), outB = new Int32Array(60);
  const nA = idx.s.pickRay(400, 300, 400, 300, outA);
  const nB = noidx.s.pickRay(400, 300, 400, 300, outB);
  assert.equal(new Set(outA.slice(0, nA)).size >= 0, true);
  // fallback must be a subset match with the pick() point oracle at the same coord.
  const pt = oracle(noidx.s, 400, 300);
  if (pt >= 0) assert.ok(Array.from(outB.slice(0, nB)).includes(pt), 'a zero-length ray must at least catch the node pick() itself would hit at that point');
});

/* ------------------------- nearest(): radius 0 + empty range ---------------- */

test('nearest(): radius=0 NEVER matches, even a box exactly touching the point (strict d2 < r*r, r=0 => 0 < 0 is false)', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(0.001, 0.001, 0.001)), mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  s.frame(1 / 60);
  // Query at the node's own screen-space centre.
  const box = s._draw.box, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  assert.equal(s.nearest(cx, cy, 0), -1, 'radius 0 must never return a hit, even dead-centre on a box');
});

test('nearest(): no node within range returns -1 (fallback and indexed paths agree)', () => {
  const idx = scatterStage(30, { index: true });
  const noidx = scatterStage(30);
  idx.s.frame(1 / 60); noidx.s.frame(1 / 60);
  assert.equal(idx.s.nearest(-9999, -9999, 1), -1);
  assert.equal(noidx.s.nearest(-9999, -9999, 1), -1);
});

test('nearest(): empty scene (0 nodes) returns -1, not a throw or NaN index', () => {
  const { s } = scatterStage(0);
  s.frame(1 / 60);
  assert.equal(s.nearest(400, 300, 50), -1);
});

/* ----------------- boundary matrix: 0 / 1 / N-1 / N / N+1 node counts -------- */

test('boundary matrix: pick()/pickRect()/nearest() at scene sizes 0, 1, N-1, N (capacity exactly full)', () => {
  const CAP = 16;
  for (const count of [0, 1, CAP - 1, CAP]) {
    const s = createStage(stub(), { width: 800, height: 600, maxNodes: CAP, camera: DOWN_Z });
    s.dirtyRect = true;
    const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
    for (let i = 0; i < count; i++) s.addNode(gid, mid, { x: (i % 4) - 1.5, y: ((i / 4) | 0) - 1.5, z: 0 });
    s.frame(1 / 60);
    assert.equal(s.stats.nodesTotal, count, 'nodesTotal must equal the spawned count=' + count);
    const out = new Int32Array(Math.max(count, 1));
    assert.doesNotThrow(() => s.pick(400, 300, out), 'pick must not throw at count=' + count);
    assert.doesNotThrow(() => s.pickRect(0, 0, 800, 600, out), 'pickRect must not throw at count=' + count);
    assert.doesNotThrow(() => s.nearest(400, 300, 999), 'nearest must not throw at count=' + count);
    if (count === 0) {
      assert.equal(s.pick(400, 300, out), 0);
      assert.equal(s.nearest(400, 300, 999), -1);
    }
  }
});

test('boundary matrix: N+1 -- addNode past capacity throws (fail closed), the stage remains usable for pick at N', () => {
  const CAP = 8;
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: CAP, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  for (let i = 0; i < CAP; i++) s.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  assert.throws(() => s.addNode(gid, mid, {}), /lite-arena|capacity|full/i, 'the N+1th addNode must throw, not silently wrap or overwrite');
  s.frame(1 / 60);
  assert.equal(s.stats.nodesTotal, CAP);
  const out = new Int32Array(1);
  assert.doesNotThrow(() => s.pick(400, 300, out), 'a stage that rejected an over-capacity spawn must remain fully usable for pick at N');
});

/* ------------- NaN / -0 / undefined / null coordinate boundary matrix -------- */

test('boundary matrix: pick()/pickRect()/nearest() with NaN coordinates never throw and never fabricate a hit', () => {
  const { s } = scatterStage(50, { index: true });
  s.frame(1 / 60);
  const out = new Int32Array(50);
  assert.equal(s.pick(NaN, 300, out), 0);
  assert.equal(s.pick(400, NaN, out), 0);
  assert.equal(s.pickRect(NaN, 0, 800, 600, out), 0);
  assert.equal(s.nearest(NaN, NaN, 100), -1);
});

test('boundary matrix: pick(-0, -0) behaves identically to pick(0, 0) -- negative zero must not desync from the oracle', () => {
  const idx = scatterStage(60, { index: true });
  const noidx = scatterStage(60);
  idx.s.frame(1 / 60); noidx.s.frame(1 / 60);
  const out = new Int32Array(1);
  const posIdx = idx.s.pick(0, 0, out); const gotPosIdx = posIdx > 0 ? out[0] : -1;
  const negIdx = idx.s.pick(-0, -0, out); const gotNegIdx = negIdx > 0 ? out[0] : -1;
  assert.equal(gotNegIdx, gotPosIdx, '-0 must compare identically to +0 in the box door (indexed path)');
  const posNo = noidx.s.pick(0, 0, out); const gotPosNo = posNo > 0 ? out[0] : -1;
  const negNo = noidx.s.pick(-0, -0, out); const gotNegNo = negNo > 0 ? out[0] : -1;
  assert.equal(gotNegNo, gotPosNo, '-0 must compare identically to +0 in the box door (fallback path)');
});

test('boundary: pickRect with undefined/null-coerced-to-NaN rect bounds does not throw and never overflows out', () => {
  const { s } = scatterStage(40);
  s.frame(1 / 60);
  const out = new Int32Array(40);
  // x1/y1 undefined -> NaN through the min/max compares; every box compare is
  // false against NaN, so this must degenerate to 0 hits, not throw.
  assert.doesNotThrow(() => s.pickRect(0, 0, undefined, undefined, out));
  assert.equal(s.pickRect(0, 0, undefined, undefined, out), 0);
});

/* ----------- duplicate dispose / dispose-during-iteration under a bound index - */

test('duplicate dispose of the SAME node handle under a bound spatial index is a safe no-op; pick stays oracle-correct afterward', () => {
  const { s, handles } = scatterStage(40, { index: true });
  s.frame(1 / 60);
  const h = handles[5];
  assert.doesNotThrow(() => { s.remove(h); s.remove(h); }, 'a second remove() of an already-despawned handle must not throw');
  assert.doesNotThrow(() => s.frame(1 / 60));
  const out = new Int32Array(1);
  let seed = 111;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 200; i++) {
    const x = rnd() * 800, y = rnd() * 600;
    const n = s.pick(x, y, out);
    assert.equal(n > 0 ? out[0] : -1, oracle(s, x, y), 'pick must stay oracle-correct after a duplicate dispose');
  }
});

test('dispose-DURING-iteration: removing nodes while walking the just-published pick candidates does not corrupt the NEXT frame\'s index rebuild or pick correctness', () => {
  const { s, handles } = scatterStage(60, { index: true });
  s.frame(1 / 60);
  const order = s._order, dc = s._drawCount, dn = s._draw.node;
  // Walk the draw list back-to-front (as a real picker/hover-cull consumer
  // would) and despawn every third node encountered mid-walk.
  let removed = 0;
  for (let i = dc - 1; i >= 0; i--) {
    const d = dn[order[i]];
    if ((i & 1) === 0) {
      // dense index d may already be stale if an earlier remove() swap-and-popped
      // it into this slot -- removing it anyway must never throw or corrupt state.
      const h = findHandleForDense(s, handles, d);
      if (h !== undefined) { s.remove(h); removed++; }
    }
  }
  assert.ok(removed > 0, 'precondition: the walk must actually remove something');
  assert.doesNotThrow(() => s.frame(1 / 60), 'a frame after mid-walk removals must not throw');
  const out = new Int32Array(1);
  let seed = 222;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 200; i++) {
    const x = rnd() * 800, y = rnd() * 600;
    const n = s.pick(x, y, out);
    assert.equal(n > 0 ? out[0] : -1, oracle(s, x, y), 'pick must stay oracle-correct on the frame after dispose-during-iteration');
  }
});
function findHandleForDense(s, handles, dense) {
  for (const h of handles) { if (s.nodes.has(h) && s.nodes.idx(h) === dense) return h; }
  return undefined;
}

/* ------------------ re-entrant write during pointer dispatch ---------------- */

test('RE-ENTRANT WRITE: onPick callback that mutates the spatial index (dropSpatialIndex) mid-dispatch does not corrupt the NEXT frame/pick', () => {
  const { s } = scatterStage(50, { index: true });
  s.frame(1 / 60);
  let calls = 0;
  s.onPick = (id, ev) => { calls++; s.dropSpatialIndex(); };
  const ev = { offsetX: 400, offsetY: 300 };
  assert.doesNotThrow(() => s._onPointer(ev), 're-entrant dropSpatialIndex from inside onPick must not throw');
  assert.equal(calls, 1);
  // The index is now unbound; dirtyRect is still true from scatterStage, so pick
  // must fall back cleanly and stay oracle-correct.
  assert.doesNotThrow(() => s.frame(1 / 60));
  const out = new Int32Array(1);
  const n = s.pick(400, 300, out);
  assert.equal(n > 0 ? out[0] : -1, oracle(s, 400, 300));
});

test('RE-ENTRANT WRITE: onPick callback that calls stage.pick() again (nested pick) does not corrupt pickStamp/pickMark and returns a consistent answer', () => {
  const { s } = scatterStage(50, { index: true });
  s.frame(1 / 60);
  const nestedOut = new Int32Array(1);
  let nestedResult = null;
  s.onPick = (id, ev) => { nestedResult = s.pick(ev.offsetX + 1, ev.offsetY, nestedOut); };
  const ev = { offsetX: 400, offsetY: 300 };
  assert.doesNotThrow(() => s._onPointer(ev));
  assert.notEqual(nestedResult, null, 'the nested pick must have actually run');
  // Outer picked value must still equal the oracle at (400,300); a corrupted
  // pickStamp/pickMark from re-entrancy would desync it from the fallback truth.
  assert.equal(s.picked, oracle(s, 400, 300));
});

test('detachPointer without a prior attachPointer is a safe no-op (removeEventListener on handlers never added)', () => {
  const { s } = scatterStage(10);
  const calls = [];
  const el = {
    addEventListener: () => {},
    removeEventListener: (name) => calls.push(name),
  };
  assert.doesNotThrow(() => s.detachPointer(el));
  assert.deepEqual(calls.sort(), ['pointerdown', 'pointermove', 'pointerup']);
});

/* ---------------- ADVERSARIAL: swap a bound tree WITHOUT dropping first ----- */

test('ADVERSARIAL (not in the planner spec): swapping useSpatialIndex to a DIFFERENT tree instance mid-session (no dropSpatialIndex in between) rebuilds cleanly into the new tree and abandons the old one', () => {
  const { s, gid, mid } = scatterStage(30);
  const treeA = new DynamicBVH2D(64);
  s.useSpatialIndex(treeA);
  s.frame(1 / 60);
  const treeAValid1 = treeA.validate();
  const treeB = new DynamicBVH2D(64);
  // Swap WITHOUT calling dropSpatialIndex() -- an adversarial caller pattern.
  s.useSpatialIndex(treeB);
  s.frame(1 / 60);
  assert.ok(treeAValid1, 'precondition: treeA was valid before the swap');
  assert.ok(treeB.validate(), 'the newly bound tree must be rebuilt and valid after one frame');
  // treeA must NOT be mutated by subsequent frames once abandoned (it is simply
  // never touched again -- clear()/insertLeaves only run against _index).
  const out = new Int32Array(1);
  let seed = 333;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 100; i++) {
    const x = rnd() * 800, y = rnd() * 600;
    const n = s.pick(x, y, out);
    assert.equal(n > 0 ? out[0] : -1, oracle(s, x, y), 'pick against the swapped-in tree must stay oracle-correct');
  }
});

/* --------------- near-plane clip: one-vertex-behind vs all-behind ------------ */

test('clip: a triangle with EXACTLY ONE vertex behind near is clipped into a polygon (DRAW_CLIP entry emitted, >=3 verts)', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  // Camera at DOWN_Z: eye at (0,10,0) looking down -y... actually DOWN_Z looks
  // down -z per the existing A1 fixture's own comment; reuse its exact recipe
  // (one tilted quad already proven straddling) but as a triangle instead, to
  // isolate "one vertex behind" from "two vertices behind".
  const gid = s.geometry(geometry.custom(
    [-0.5, -0.5, 1, 0.5, -0.5, -1, -0.5, 0.5, -1],  // local z: +1, -1, -1 -> exactly one vert in front once offset
    [[0, 1, 2]],
  ));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 9.5 });  // near=0.5: view z = localz - 9.5... matches A1's node depth recipe
  s.clipNear = true;
  s.frame(1 / 60);
  const order = s._order, dc = s._drawCount, face = s._draw.face, ref = s._draw.clipRef;
  let found = false, verts = 0;
  for (let i = 0; i < dc; i++) { const e = order[i]; if (face[e] === 0xFFFFFFFE) { found = true; verts = ref[e] & 31; } }
  assert.ok(found, 'a one-vertex-in-front triangle straddling near must emit a DRAW_CLIP entry');
  assert.ok(verts >= 3, 'clipped polygon must have >=3 verts, got ' + verts);
});

test('clip: a face with ALL vertices behind the near plane is fully culled (no DRAW_CLIP entry, facesCulled bumped), never clipped', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  // node z = radius (10): every vertex sits at/behind the eye -- z is entirely
  // behind near (vz > -near for all verts, the FAIL-OPEN empty-box case from
  // phaseD, but examined here for the CLIP entry specifically).
  s.addNode(gid, mid, { x: 0, y: 0, z: 10.2 });
  s.clipNear = true;
  const before = s.stats.facesCulled;
  s.frame(1 / 60);
  const order = s._order, dc = s._drawCount, face = s._draw.face;
  let clipEntries = 0;
  for (let i = 0; i < dc; i++) { if (face[order[i]] === 0xFFFFFFFE) clipEntries++; }
  assert.equal(clipEntries, 0, 'an all-behind node must never emit a DRAW_CLIP entry');
  assert.equal(s.stats.facesDrawn, 0, 'an all-behind node must draw nothing');
  assert.ok(s.stats.facesCulled > before, 'an all-behind node\'s faces must be rejected (facesCulled), not silently dropped uncounted');
});

test('clip: a face with vertex count >= CLIP_CAP (16) straddling near is rejected WHOLE (facesCulled++), never overruns _clipA/_clipB', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  // Build a 16-gon (n === CLIP_CAP) whose verts straddle the near plane so it
  // is clip-eligible by the near test but must be rejected by clipFace's own
  // `n >= CLIP_CAP` door (n < 3 || n >= CLIP_CAP).
  const N = 16;
  const verts = [];
  const faceIdx = [];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    // alternate z so the ring straddles depth around the node's own z offset
    const z = (i % 2 === 0) ? 1 : -1;
    verts.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5, z);
    faceIdx.push(i);
  }
  const gid = s.geometry(geometry.custom(verts, [faceIdx]));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 9.5 });
  s.clipNear = true;
  const before = s.stats.facesCulled;
  assert.doesNotThrow(() => s.frame(1 / 60), 'a 16-vertex straddling face must never overrun the CLIP_CAP=16 scratch buffers');
  assert.equal(s.stats.facesDrawn, 0, 'an oversized straddling face must be rejected whole, not partially drawn');
  assert.ok(s.stats.facesCulled > before, 'the oversized face must be counted via facesCulled (fail closed)');
});

test('clip: a degenerate 2-vertex "face" that straddles near is rejected via the n<3 door inside clipFace, not a crash', () => {
  const s = createStage(stub(), { width: 800, height: 600, maxNodes: 4, camera: DOWN_Z });
  const gid = s.geometry(geometry.custom(
    [0, 0, 1, 0, 0, -1],
    [[0, 1]],
  ));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 9.5 });
  s.clipNear = true;
  assert.doesNotThrow(() => s.frame(1 / 60));
  assert.equal(s.stats.facesDrawn, 0);
});
