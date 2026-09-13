/**
 * D6 "Offthread" -- off-thread transform round-trip correctness (node:worker_threads).
 *
 * Focused regression tests for the three reviewer blockers, each proven directly:
 *   B1 shading parity -- on-thread and off-thread paint BYTE-IDENTICALLY, including a
 *      non-uniformly-scaled node AND a child of a non-uniform parent (the Worker
 *      propagates worldNonUnif in topo order and transfers it back).
 *   B2 bootstrap fail-closed -- frame 1 on a freshly-bound Worker does NOT project
 *      zero matrices; it stalls (offthreadStalls++) until real matrices are home.
 *   B3 unbind mid-flight -- useWorker(null) while a send is in flight defers; no
 *      frame() reads a detached lane, and main-thread mode resumes only once the
 *      in-flight reply has rebound every lane.
 *
 * @license MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createStage, geometry, material } from '../Depth.js';

const DT = 1 / 60;
const WORKER_URL = new URL('../DepthWorker.js', import.meta.url);

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

// Records the exact ctx style sequence so two backends can be compared for parity.
function recordCtx() {
  const fills = [];
  return {
    fills, fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { fills.push('f:' + this.fillStyle); },
    stroke() { fills.push('s:' + this.strokeStyle); },
  };
}

// Non-uniform parent + uniform-local child under it + uniform root -> forces BOTH
// shade branches (the child's composed world basis is non-uniform too).
function buildScene(ctx) {
  const s = createStage(ctx, { maxNodes: 16, width: 800, height: 600, camera: { theta: 0.6, phi: 1.0, radius: 14 } });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({ r: 180, g: 120, b: 90, ambient: 0.3 }));
  const a = s.addNode(g, m, { x: -2, y: 0, z: 0 }); s.setScale(a, 2, 0.5, 1);
  s.addNode(g, m, { x: 1, y: 0, z: 0.5, parent: a });
  const c = s.addNode(g, m, { x: 2, y: 1, z: 0 }); s.setScale(c, 1.4, 1.4, 1.4);
  s.setEuler(a, 0.3, 0.4, 0.1);
  return { stage: s, a };
}

// Bind a real Worker and return a round-trip driver that resolves on the reply.
function bindWorker(stage) {
  const worker = new Worker(WORKER_URL);
  let pending = null;
  stage.useWorker(worker);
  worker.on('message', () => { const r = pending; pending = null; if (r) r(); });
  const roundTrip = () => new Promise((res) => { pending = res; stage.frame(DT); });
  return { worker, roundTrip };
}

test('B1: off-thread shading is BYTE-IDENTICAL to on-thread (non-uniform node + child of non-uniform parent)', async () => {
  const rctx = recordCtx();
  const ref = buildScene(rctx);
  ref.stage.frame(DT);
  const refFills = rctx.fills.slice();
  assert.ok(refFills.length > 0, 'on-thread reference painted nothing');
  assert.ok(ref.stage.stats.nodesNonUniform >= 1, 'scene must exercise the non-uniform shade branch');

  const wctx = recordCtx();
  const wk = buildScene(wctx);
  const { worker, roundTrip } = bindWorker(wk.stage);
  await roundTrip();                 // frame 1: bootstrap stall, primes composed matrices
  await roundTrip();                 // frame 2: paints world(P)
  wctx.fills.length = 0;
  await roundTrip();                 // frame 3: paints the same world(P) -> capture
  await worker.terminate();

  assert.equal(wk.stage.stats.nodesNonUniform, ref.stage.stats.nodesNonUniform, 'nodesNonUniform must match across backends');
  assert.equal(wctx.fills.length, refFills.length, 'off-thread draw count must match on-thread');
  assert.deepEqual(wctx.fills, refFills, 'off-thread fill/shade sequence must be byte-identical to on-thread');
});

test('B2: a freshly-bound Worker STALLS frame 1 rather than projecting zero matrices', async () => {
  const wk = buildScene(makeCtx());
  const { worker, roundTrip } = bindWorker(wk.stage);

  // Frame 1 synchronously: lanes are home but NOT yet primed (no reply). It must SEND
  // and SKIP the project -- never paint the zero-initialized world matrices.
  wk.stage.frame(DT);
  assert.equal(wk.stage.stats.offthreadStalls, 1, 'frame 1 must stall exactly once (bootstrap)');
  assert.equal(wk.stage._drawCount, 0, 'frame 1 must not have projected any draws (no zero-matrix paint)');
  assert.equal(wk.stage.stats.facesDrawn, 0, 'frame 1 must not have drawn faces');
  assert.equal(wk.stage.stats.nodesInvalid, 0, 'frame 1 must not have read/validated lanes at all');

  // Drain the bootstrap reply: lanes home + primed, and the world matrix is composed
  // (finite, non-zero) -- read it NOW, while home, before the next frame re-detaches.
  await new Promise((res) => { const w = worker; const h = () => { w.off('message', h); res(); }; w.on('message', h); });
  assert.equal(wk.stage.nodes.isDetached('m0'), false, 'bootstrap reply must have rebound the lanes');
  const D = wk.stage.nodes.data, d0 = wk.stage.nodes.idx(wk.a);
  assert.ok(Number.isFinite(D.m0[d0]) && (D.m0[d0] !== 0 || D.m5[d0] !== 0), 'world matrix must be composed, not zero');

  // The primed frame projects those real matrices and draws non-degenerate geometry.
  wk.stage.frame(DT);
  assert.ok(wk.stage.stats.facesDrawn > 0, 'a primed frame must draw the composed geometry');
  // Unbind before terminate so a queued frame() can never post to a dead worker.
  wk.stage.useWorker(null);
  await worker.terminate();
  void roundTrip;
});

test('B3: useWorker(null) mid-flight defers -- no frame() reads a detached lane', async () => {
  const wk = buildScene(makeCtx());
  const worker = new Worker(WORKER_URL);
  let pending = null;
  wk.stage.useWorker(worker);
  worker.on('message', () => { const r = pending; pending = null; if (r) r(); });
  const roundTrip = () => new Promise((res) => { pending = res; wk.stage.frame(DT); });

  await roundTrip();                 // frame 1 bootstrap
  await roundTrip();                 // primed + painting
  assert.ok(wk.stage.stats.facesDrawn > 0, 'worker-backed stage should be painting before the mid-flight unbind');

  // Send a frame (lanes now detached), then unbind WHILE the reply is in flight.
  wk.stage.frame(DT);
  assert.equal(wk.stage.nodes.isDetached('m0'), true, 'a send must leave m0 detached until the reply');
  wk.stage.useWorker(null);          // deferred: lanes are out, cannot switch to main path yet

  // A frame() during the deferral must NOT read the detached lanes: it stalls whole.
  const stallsBefore = wk.stage.stats.offthreadStalls;
  const invalidBefore = wk.stage.stats.nodesInvalid;
  wk.stage.frame(DT);
  assert.equal(wk.stage.stats.offthreadStalls, stallsBefore + 1, 'a frame during deferral must stall, not read detached lanes');
  assert.equal(wk.stage.stats.nodesInvalid, invalidBefore, 'no NaN/invalid nodes -- the detached lanes were never read');

  // Drain the in-flight reply: the return handler rebinds every lane, THEN completes
  // the unbind. From here frame() is the pure main-thread path over home lanes.
  await new Promise((res) => { const h = () => { worker.off('message', h); res(); }; worker.on('message', h); });
  await worker.terminate();
  assert.equal(wk.stage.nodes.isDetached('m0'), false, 'the drained reply must have rebound the lanes');

  const inv0 = wk.stage.stats.nodesInvalid;
  wk.stage.frame(DT);                // main-thread mode now
  assert.ok(wk.stage.stats.facesDrawn > 0, 'main-thread frame after unbind must paint (home lanes)');
  assert.equal(wk.stage.stats.nodesInvalid, 0, 'main-thread frame after unbind must read no detached/NaN lane');
  assert.equal(wk.stage.stats.offthreadStalls, stallsBefore + 1, 'main-thread frames do not stall');
  void inv0;
});
