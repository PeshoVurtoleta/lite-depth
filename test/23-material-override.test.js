/**
 * D6.5 "spend the lanes D5 already paid for" -- boundary + adversarial coverage
 * for the shipped-but-untested v1.9.0 surface:
 *
 *   - stage.setMaterialOverride(h, matId | -1) -- cold, fail-closed setter over a
 *     new persistent per-node `matEff` lane (Int32Array, Depth.js:379, seeded in
 *     addNode at :656).
 *   - stats.facesClipped -- per-frame counter, reset every frame() (:1130 / :1505),
 *     incremented once per clipped-polygon emit in clipFace (:1958).
 *   - stats.pickHits -- monotonic counter, incremented at both pick() success
 *     returns (:942, :950), never reset in frame().
 *
 * Every claim reads the ACTUAL draw lane (stage._draw.matOverride keyed by
 * stage._draw.node / stage._draw.face) or the actual matEff SoA lane
 * (stage.nodes.data.matEff) -- never a rendered "look". This file does not edit
 * Depth.js. Reviewer note: the diff was APPROVED with no blockers but ZERO test
 * coverage existed for D6.5 before this file.
 *
 * @license MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createStage, geometry, material } from '../Depth.js';

const DT = 1 / 60;
const DOWN_Z = { theta: 0, phi: Math.PI / 2, radius: 12, near: 0.5, far: 200 };
// Reused verbatim from test/17-layers.test.js: the exact camera + node z that
// proves near-plane straddling for a single-triangle custom geometry.
const CLIP_CAM = { theta: 0, phi: Math.PI / 2, radius: 10, near: 0.5, far: 200 };
const DRAW_SHADOW = 0xFFFFFFFD;
const WORKER_URL = new URL('../DepthWorker.js', import.meta.url);

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

// Every draw-entry matOverride value for a given dense node index, in painted
// order, read straight from the real per-frame draw lanes (never a canvas look).
function drawEntriesFor(s, d) {
  const D = s._draw, dc = s._drawCount, order = s._order;
  const out = [];
  for (let i = 0; i < dc; i++) {
    const e = order[i];
    if (D.node[e] === d) out.push({ mat: D.matOverride[e], face: D.face[e] >>> 0 });
  }
  return out;
}

function snapshotMatEff(s) {
  return Array.from(s.nodes.data.matEff);
}

const straddleTriGeom = geometry.custom(
  [-0.5, -0.5, 1, 0.5, -0.5, -1, -0.5, 0.5, -1],
  [[0, 1, 2]],
);

// ============================================================================
// Assertion 1: override applied, read from the real draw lane.
// ============================================================================

test('D6.5 assertion 1: setMaterialOverride(h, matB) makes every draw entry for that node read matB; -1 restores 100% matA', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const matA = s.material(material({}));
  const matB = s.material(material({ r: 200, g: 10, b: 10 }));
  const h = s.addNode(gid, matA, { x: 0, y: 0, z: 0 });
  const d = s.nodes.idx(h);

  s.frame(DT);
  let entries = drawEntriesFor(s, d);
  assert.ok(entries.length > 0, 'precondition: the node actually painted faces');
  assert.ok(entries.every((e) => e.mat === matA), 'baseline: every entry reads the node\'s own material');

  s.setMaterialOverride(h, matB);
  s.frame(DT);
  entries = drawEntriesFor(s, d);
  assert.ok(entries.length > 0, 'precondition: entries still emitted after override');
  assert.ok(entries.every((e) => e.mat === matB), 'every draw entry must read matB after the override, 100%');

  s.setMaterialOverride(h, -1);
  s.frame(DT);
  entries = drawEntriesFor(s, d);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.mat === matA), '-1 must restore 100% of entries to the node\'s own material matA');
});

// ============================================================================
// Assertion 2: shadow non-leak, BOTH directions -- named test.
// ============================================================================

test('D6.5 assertion 2 (named): a shadow-casting node with an override paints the override on its OWN faces and the stage shadow material on its GROUND-SHADOW faces -- no leak either direction', () => {
  const s = createStage(makeCtx(), { width: 800, height: 600, maxNodes: 8, camera: { theta: 0.5, phi: 0.9, radius: 8, near: 0.5, far: 200 } });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const matA = s.material(material({}));
  const matOv = s.material(material({ r: 50, g: 60, b: 70 }));
  const smat = s.material(material({ r: 5, g: 5, b: 5 }));
  s.setShadowMaterial(smat);
  const h = s.addNode(gid, matA, { x: 0, y: 2, z: 0, castShadow: true });
  const d = s.nodes.idx(h);
  s.setMaterialOverride(h, matOv);
  s.frame(DT);

  const entries = drawEntriesFor(s, d);
  const own = entries.filter((e) => e.face !== DRAW_SHADOW);
  const shadow = entries.filter((e) => e.face === DRAW_SHADOW);
  assert.ok(own.length > 0, 'precondition: the caster itself painted faces');
  assert.ok(shadow.length > 0, 'precondition: the caster emitted ground-shadow faces');

  // Direction 1: the override must not leak OUT into the shadow faces.
  assert.ok(own.every((e) => e.mat === matOv), 'every own-face entry must read the override material');
  assert.ok(shadow.every((e) => e.mat !== matOv), 'the override must NOT leak into the caster\'s own ground-shadow faces');
  // Direction 2: the shadow material must not leak IN to the node's own faces.
  assert.ok(shadow.every((e) => e.mat === smat), 'every shadow-face entry must read the stage shadow material');
  assert.ok(own.every((e) => e.mat !== smat), 'the stage shadow material must NOT leak into the caster\'s own faces');
});

// ============================================================================
// Assertion 3: fail closed both ways, byte-compared before/after (mutates NO lane).
// Boundary matrix on matId: 0, 1, N-1, N, N+1, empty, null, undefined, NaN, -0.
// ============================================================================

test('D6.5 assertion 3 / boundary matId: 0, 1, N-1 are accepted; N and N+1 (unregistered) THROW and mutate NO lane', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  const m1 = s.material(material({ r: 1, g: 1, b: 1 }));
  const m2 = s.material(material({ r: 2, g: 2, b: 2 })); // N = 3 registered materials
  const h = s.addNode(gid, m0, { x: 0, y: 0, z: 0 });

  assert.doesNotThrow(() => s.setMaterialOverride(h, 0), 'matId=0 is registered');
  assert.doesNotThrow(() => s.setMaterialOverride(h, 1), 'matId=1 (N-2) is registered');
  assert.doesNotThrow(() => s.setMaterialOverride(h, 2), 'matId=N-1=2 (the last registered id) is registered');

  const before = snapshotMatEff(s);
  assert.throws(() => s.setMaterialOverride(h, 3), /registered material id/, 'matId=N=3 is exactly one past the registry -- must throw, never clamp');
  assert.deepEqual(snapshotMatEff(s), before, 'matId=N throw must mutate NO lane');
  assert.throws(() => s.setMaterialOverride(h, 4), /registered material id/, 'matId=N+1=4 must throw');
  assert.deepEqual(snapshotMatEff(s), before, 'matId=N+1 throw must mutate NO lane');
  void m1; void m2;
});

test('D6.5 boundary matId: empty string, null, undefined, NaN all THROW and mutate NO lane', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  const h = s.addNode(gid, m0, { x: 0, y: 0, z: 0 });
  const before = snapshotMatEff(s);

  assert.throws(() => s.setMaterialOverride(h, ''), /registered material id/, 'matId="" must throw, not coerce to 0');
  assert.deepEqual(snapshotMatEff(s), before, '"" throw mutates nothing');

  assert.throws(() => s.setMaterialOverride(h, null), /registered material id/, 'matId=null must throw');
  assert.deepEqual(snapshotMatEff(s), before, 'null throw mutates nothing');

  assert.throws(() => s.setMaterialOverride(h, undefined), /registered material id/, 'matId=undefined (omitted) must throw, never fall back to a silent default');
  assert.deepEqual(snapshotMatEff(s), before, 'undefined throw mutates nothing');

  assert.throws(() => s.setMaterialOverride(h, NaN), /registered material id/, 'matId=NaN must throw');
  assert.deepEqual(snapshotMatEff(s), before, 'NaN throw mutates nothing');
});

test('D6.5 boundary matId: -0 is accepted as material id 0 (NOT treated as the -1 "clear" sentinel)', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  s.material(material({ r: 9, g: 9, b: 9 }));
  const h = s.addNode(gid, m0, { x: 0, y: 0, z: 0 });
  const d = s.nodes.idx(h);
  assert.doesNotThrow(() => s.setMaterialOverride(h, -0), '-0 must be accepted (Number.isInteger(-0) is true, -0 >= 0 is true)');
  assert.equal(s.nodes.data.matEff[d], 0, '-0 must land as material id 0, not as a clear (-1 is the ONLY clear sentinel)');
  s.frame(DT);
  const entries = drawEntriesFor(s, d);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.mat === m0), '-0 paints material 0, exactly like +0');
});

test('D6.5 assertion 3: a dead handle THROWS before any write, proven by an unchanged matEff lane', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  const m1 = s.material(material({ r: 3, g: 3, b: 3 }));
  const alive = s.addNode(gid, m0, { x: -1, y: 0, z: 0 });
  const dead = s.addNode(gid, m0, { x: 1, y: 0, z: 0 });
  s.remove(dead);

  const before = snapshotMatEff(s);
  assert.throws(() => s.setMaterialOverride(dead, m1), /dead or recycled/, 'a despawned handle must be rejected before any lane write');
  assert.deepEqual(snapshotMatEff(s), before, 'the refused write must mutate NO lane, including the survivor\'s slot');
  void alive;
});

test('D6.5 assertion 3: a RECYLED handle (stale generation aliasing a reissued slot) THROWS and never repoints the new occupant', () => {
  const s = createStage(makeCtx(), { maxNodes: 1, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  const m1 = s.material(material({ r: 4, g: 4, b: 4 }));
  const h1 = s.addNode(gid, m0, { x: 0, y: 0, z: 0 });
  s.remove(h1);
  const h2 = s.addNode(gid, m0, { x: 0, y: 0, z: 0 }); // capacity 1 -> guaranteed to reuse the same slot

  const before = snapshotMatEff(s);
  assert.throws(() => s.setMaterialOverride(h1, m1), /dead or recycled/, 'the stale handle from BEFORE the recycle must never alias the new occupant');
  assert.deepEqual(snapshotMatEff(s), before, 'the refused write over a recycled slot must mutate NO lane');
  assert.equal(s.nodes.data.matEff[s.nodes.idx(h2)], m0, 'the new occupant keeps its own seeded material, untouched by the stale-handle attempt');
});

// ============================================================================
// Assertion 4: recycled slot -- addNode reseeds unconditionally.
// ============================================================================

test('D6.5 assertion 4: addNode into a recycled slot reseeds matEff to the NEW node\'s own matId, never the prior occupant\'s override', () => {
  const s = createStage(makeCtx(), { maxNodes: 1, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const matA = s.material(material({}));
  const matB = s.material(material({ r: 111, g: 22, b: 33 })); // the prior occupant's override
  const matC = s.material(material({ r: 44, g: 55, b: 66 })); // the new occupant's OWN material

  const h1 = s.addNode(gid, matA, { x: 0, y: 0, z: 0 });
  s.setMaterialOverride(h1, matB);
  assert.equal(s.nodes.data.matEff[s.nodes.idx(h1)], matB, 'sanity: the override took effect on the prior occupant');
  s.remove(h1);

  const h2 = s.addNode(gid, matC, { x: 0, y: 0, z: 0 }); // maxNodes=1 -> guaranteed slot reuse
  const d2 = s.nodes.idx(h2);
  assert.equal(s.nodes.data.matEff[d2], matC, 'the new node\'s matEff must equal its OWN matId, never matB (the prior occupant\'s override)');
  assert.notEqual(s.nodes.data.matEff[d2], matB, 'the prior override must never survive into the reissued slot');

  s.frame(DT);
  const entries = drawEntriesFor(s, d2);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.mat === matC), 'the reissued slot paints its OWN material, not the stale override');
});

// ============================================================================
// Assertion 5: facesClipped -- exact per-frame count, 0 gates, resets each frame.
// ============================================================================

function buildStraddleScene(n, clipNear) {
  const s = createStage(makeCtx(), { width: 800, height: 600, maxNodes: 16, camera: CLIP_CAM });
  const gid = s.geometry(straddleTriGeom);
  const mid = s.material(material({}));
  for (let i = 0; i < n; i++) s.addNode(gid, mid, { x: (i - (n - 1) / 2) * 0.3, y: 0, z: 9.5 });
  s.clipNear = clipNear;
  return s;
}

test('D6.5 assertion 5: facesClipped counts EXACTLY the number of clipped-polygon emits on a straddling fixture', () => {
  const s = buildStraddleScene(5, true);
  s.frame(DT);
  assert.equal(s.stats.facesClipped, 5, 'exactly 5 straddling triangles -> exactly 5 clipped-polygon emits');
});

test('D6.5 assertion 5: facesClipped === 0 with clipNear=false (the straddling face is culled whole, not clipped)', () => {
  const s = buildStraddleScene(5, false);
  s.frame(DT);
  assert.equal(s.stats.facesClipped, 0, 'clipNear=false must never emit a clipped polygon');
  assert.ok(s.stats.facesCulled > 0, 'sanity: the straddling faces were rejected via facesCulled instead');
});

test('D6.5 assertion 5: facesClipped === 0 with no straddling geometry at all', () => {
  const s = createStage(makeCtx(), { width: 800, height: 600, maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  s.clipNear = true;
  s.frame(DT);
  assert.equal(s.stats.facesClipped, 0, 'a fully-front scene must never touch the clip path');
  assert.ok(s.stats.facesDrawn > 0, 'sanity: the node did paint');
});

test('D6.5 assertion 5: facesClipped RESETS to 0 every frame -- it is per-frame, NOT monotonic', () => {
  const s = buildStraddleScene(5, true);
  s.frame(DT);
  assert.equal(s.stats.facesClipped, 5, 'frame 1: 5 clipped emits');
  s.frame(DT);
  assert.equal(s.stats.facesClipped, 5, 'frame 2: the SAME 5 again, never 10 -- proves per-frame reset, not accumulation');
  s.frame(DT);
  assert.equal(s.stats.facesClipped, 5, 'frame 3: still exactly 5');
});

// ============================================================================
// Assertion 6: pickHits -- +1 per success, +0 on miss, never via other pick*
// entry points, and MONOTONIC (never reset by frame()).
// ============================================================================

test('D6.5 assertion 6: pickHits increments exactly +1 per successful pick(), +0 on a miss, and is NEVER reset across 100 frames (=== 100 after 100 hits)', () => {
  const s = createStage(makeCtx(), { width: 800, height: 600, maxNodes: 8, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0 });

  assert.equal(s.stats.pickHits, 0, 'boundary: 0 before any pick');
  const out = new Int32Array(1);

  s.frame(DT);
  assert.equal(s.pick(400, 300, out), 1, 'sanity: center screen must hit the on-screen box');
  assert.equal(s.stats.pickHits, 1, 'boundary: 1 after exactly one successful pick');

  assert.equal(s.pick(-9999, -9999, out), 0, 'a wildly off-screen point is a MISS');
  assert.equal(s.stats.pickHits, 1, 'a miss must add +0');

  for (let f = 0; f < 99; f++) {
    s.frame(DT);
    assert.equal(s.pick(400, 300, out), 1);
  }
  assert.equal(s.stats.pickHits, 100, 'boundary: === 100 after 100 successful picks across 100 frames total');

  // frame() must never touch pickHits (unlike facesClipped) -- run several more
  // frames with no further picks and confirm it holds at 100.
  for (let f = 0; f < 5; f++) s.frame(DT);
  assert.equal(s.stats.pickHits, 100, 'pickHits must NOT be reset by frame() -- monotonic like offthreadStalls');
});

test('D6.5 assertion 6: pickRect/pickRay/pickSet/nearest never touch pickHits, hits or misses', () => {
  const s = createStage(makeCtx(), { width: 800, height: 600, maxNodes: 8, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0, pickable: true });
  s.frame(DT);

  const out = new Int32Array(8);
  s.pickRect(0, 0, 800, 600, out);       // a broad hit
  s.pickRect(-9999, -9999, -9998, -9998, out); // a miss
  s.pickRay(0, 300, 800, 300, out);
  s.pickRay(0, -9999, 800, -9999, out);
  s.pickSet(out);
  s.nearest(400, 300, 50);
  s.nearest(-9999, -9999, 1);
  assert.equal(s.stats.pickHits, 0, 'pickRect/pickRay/pickSet/nearest are separate entry points -- pickHits is pick()-only');
});

// ============================================================================
// Assertion 7: off-thread parity -- matEff is main-thread-owned, never transferred.
// ============================================================================

// Structural fail-closed check first (fast, deterministic): capture the actual
// per-frame message a real useWorker() send leg posts and assert neither 'mat'
// nor 'matEff' is in the transferred lane key set -- the persistent override lane
// physically cannot be dropped/raced by a round trip because it never leaves the
// main thread.
function makeCapturingWorker() {
  const posted = [];
  return {
    posted,
    on() {},
    postMessage(msg, xfer) {
      posted.push(msg);
      if (xfer) for (const buf of xfer) { try { structuredClone(buf, { transfer: [buf] }); } catch { /* already detached */ } }
    },
  };
}

test('D6.5 assertion 7 (structural, fail-closed): matEff/mat are ABSENT from the off-thread send-lane key list -- the override lane is never transferred', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, width: 640, height: 480 });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  s.addNode(gid, m0, { x: 0, y: 0, z: 0 });
  const fw = makeCapturingWorker();
  s.useWorker(fw);
  s.frame(DT);
  const sent = fw.posted[fw.posted.length - 1];
  assert.ok(sent && sent.lanes, 'precondition: a per-frame lane message was sent');
  const keys = Object.keys(sent.lanes);
  assert.ok(!keys.includes('matEff'), 'matEff must never appear in the transferred lane set (main-thread-owned)');
  assert.ok(!keys.includes('mat'), 'mat must never appear in the transferred lane set either');
});

// Real worker_threads round trip: an override set BEFORE an off-thread frame must
// still be honored on the reply, because it was never sent out and never came back.
test('D6.5 assertion 7 (real worker round trip): an override set before an off-thread frame is honored on the reply', async () => {
  const s = createStage(makeCtx(), { maxNodes: 8, width: 800, height: 600, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const matA = s.material(material({}));
  const matB = s.material(material({ r: 77, g: 88, b: 99 }));
  const h = s.addNode(gid, matA, { x: 0, y: 0, z: 0 });
  const d = s.nodes.idx(h);
  s.setMaterialOverride(h, matB);

  const worker = new Worker(WORKER_URL);
  let pending = null;
  s.useWorker(worker);
  worker.on('message', () => { const r = pending; pending = null; if (r) r(); });
  const roundTrip = () => new Promise((res) => { pending = res; s.frame(DT); });

  await roundTrip();   // frame 1: bootstrap stall, primes composed matrices
  await roundTrip();   // frame 2: paints world(P) off-thread

  const entries = drawEntriesFor(s, d);
  assert.ok(entries.length > 0, 'precondition: the off-thread reply produced paintable entries');
  assert.ok(entries.every((e) => e.mat === matB), 'the pre-existing override must still read matB after the off-thread round trip');

  await worker.terminate();
});

// ============================================================================
// Boundary: duplicate dispose.
// ============================================================================

test('D6.5 boundary: duplicate dispose -- removing the same handle twice is a safe no-op, and setMaterialOverride stays refused both times', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  const m1 = s.material(material({ r: 6, g: 6, b: 6 }));
  const h = s.addNode(gid, m0, { x: 0, y: 0, z: 0 });
  s.remove(h);
  assert.doesNotThrow(() => s.remove(h), 'a second remove() of an already-dead handle must not throw (arena despawn no-ops)');
  const before = snapshotMatEff(s);
  assert.throws(() => s.setMaterialOverride(h, m1), /dead or recycled/, 'still refused after a duplicate dispose');
  assert.deepEqual(snapshotMatEff(s), before);
});

// ============================================================================
// Boundary: dispose-during-iteration.
// ============================================================================

test('D6.5 boundary: dispose-during-iteration -- despawning a not-yet-processed handle mid-batch does not corrupt sibling overrides via swap-and-pop', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({}));
  const m1 = s.material(material({ r: 7, g: 7, b: 7 }));
  const handles = [];
  for (let i = 0; i < 5; i++) handles.push(s.addNode(gid, m0, { x: (i - 2) * 0.4, y: 0, z: 0 }));

  for (let i = 0; i < handles.length; i++) {
    if (i === 2) s.remove(handles[4]);   // despawn a handle still pending later in this SAME loop
    if (i === 4) {
      assert.throws(() => s.setMaterialOverride(handles[4], m1), /dead or recycled/, 'the despawned-mid-loop handle must be refused, not silently applied to whatever now sits in its old slot');
      continue;
    }
    assert.doesNotThrow(() => s.setMaterialOverride(handles[i], m1));
  }
  for (let i = 0; i < 4; i++) {
    const d = s.nodes.idx(handles[i]);
    assert.equal(s.nodes.data.matEff[d], m1, 'handle ' + i + ' must carry its OWN override, unaffected by the mid-loop despawn/swap-and-pop of handle 4');
  }
});

// ============================================================================
// Boundary: re-entrant write.
// ============================================================================

test('D6.5 boundary: re-entrant write -- a handle argument that triggers a nested setMaterialOverride during its own ToInt32 coercion corrupts neither write', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mA = s.material(material({}));
  const mB = s.material(material({ r: 8, g: 8, b: 8 }));   // outer target
  const mC = s.material(material({ r: 12, g: 12, b: 12 })); // nested/re-entrant target
  const h1 = s.addNode(gid, mA, { x: -1, y: 0, z: 0 });
  const h2 = s.addNode(gid, mA, { x: 1, y: 0, z: 0 });

  let reentered = false;
  // arena.isAlive(h) computes `h & INDEX_MASK`, which ToInt32-coerces a non-number
  // handle via valueOf -- a real, exploitable re-entrancy hook for a malicious or
  // buggy caller-supplied handle-like object.
  const trickyHandle = {
    valueOf() {
      if (!reentered) { reentered = true; s.setMaterialOverride(h2, mC); }
      return h1;
    },
  };

  assert.doesNotThrow(() => s.setMaterialOverride(trickyHandle, mB));
  assert.equal(s.nodes.data.matEff[s.nodes.idx(h1)], mB, 'the outer write (whose coercion triggered the reentry) must still land correctly on h1');
  assert.equal(s.nodes.data.matEff[s.nodes.idx(h2)], mC, 'the nested reentrant write to h2 must also land correctly, uncorrupted by the outer call in progress');
});

// ============================================================================
// Adversarial case the planner did not name: reserve() growth must preserve
// the matEff lane (it is part of the arena-registered node SoA component, but
// D6.5's own brief never mentions reserve() at all -- D5's own reserve() test
// only proved the cull-stamp lane; this closes the same gap for matEff).
// ============================================================================

test('D6.5 adversarial (planner gap): stage.reserve() growing capacity preserves the matEff override lane and its live draw effect', () => {
  const s = createStage(makeCtx(), { maxNodes: 2, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const matA = s.material(material({}));
  const matB = s.material(material({ r: 13, g: 14, b: 15 }));
  const h = s.addNode(gid, matA, { x: 0, y: 0, z: 0 });
  s.setMaterialOverride(h, matB);

  assert.equal(s.reserve(64), true, 'the grow must actually happen (64 > maxNodes=2)');
  const d = s.nodes.idx(h);
  assert.equal(s.nodes.data.matEff[d], matB, 'matEff must survive stage.reserve() -- it is part of the SAME arena-registered SoA component as px..bias');

  // A freshly-added node after the grow must still reseed correctly (no cross-talk
  // between the grow's fresh tail and the pre-existing override).
  const h2 = s.addNode(gid, matA, { x: 3, y: 0, z: 0 });
  assert.equal(s.nodes.data.matEff[s.nodes.idx(h2)], matA, 'a node added after the grow reseeds to its own material, not the survivor\'s override');

  s.frame(DT);
  const entries = drawEntriesFor(s, d);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.mat === matB), 'the override is still honored in the real draw output after a capacity grow');
});
