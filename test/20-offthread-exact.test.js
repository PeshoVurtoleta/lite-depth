/**
 * D6 "Offthread" -- QA gap fill for planner ASSERTION 1:
 *
 *   "Round trip proven TWICE: detach -> transfer -> compose -> transfer back ->
 *    rebind, world m0..m11 byte-identical (f64 EXACT, Object.is / not epsilon) vs
 *    the single-threaded path. Confirm the 'twice' -- two independent round trips,
 *    not one."
 *
 * The existing B1 test (test/19-offthread.test.js) and torture Phase G only
 * compare the PAINTED fillStyle/strokeStyle SEQUENCE across backends, never the
 * raw m0..m11 lanes themselves, and never with Object.is (deepEqual on strings
 * tolerates nothing looser than exact anyway, but it is once, not twice, and it
 * never reads the matrix lanes directly). This suite closes that gap directly:
 * it reads stage.nodes.data.m0..m11 after each round trip and asserts EVERY
 * lane, for EVERY node, is Object.is-identical to a same-pose main-thread
 * reference compose -- across TWO independent round trips driven by two
 * independent pose mutations.
 *
 * @license MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createStage, geometry, material } from '../Depth.js';

const DT = 1 / 60;
const WORKER_URL = new URL('../DepthWorker.js', import.meta.url);
const M_LANES = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'];

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

// Deterministic hierarchy: root + a non-uniformly-scaled child + a grandchild
// under it (exercises composeTRS AND mulAffine parent-chaining identically on
// both backends).
function buildScene(ctx) {
  const s = createStage(ctx, { maxNodes: 8, width: 640, height: 480 });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
  const root = s.addNode(g, m, { x: 1, y: -2, z: 3 });
  s.setEuler(root, 0.2, 0.4, 0.1);
  const child = s.addNode(g, m, { x: 0.5, y: 0, z: -1, parent: root });
  s.setScale(child, 2, 0.5, 1.25);
  s.setEuler(child, 0.05, -0.3, 0.9);
  const grand = s.addNode(g, m, { x: -0.2, y: 0.3, z: 0.1, parent: child });
  s.setEuler(grand, 1.1, 0, 0.2);
  return { stage: s, root, child, grand };
}

// Assert every world-matrix lane of every dense node is Object.is-EXACT between
// two stages -- f64 exact, no epsilon tolerance.
function assertExactWorldMatrices(a, b, label) {
  const count = a.nodes.count;
  assert.equal(count, b.nodes.count, label + ': node count must match');
  const A = a.nodes.data, B = b.nodes.data;
  for (let d = 0; d < count; d++) {
    for (const lane of M_LANES) {
      const av = A[lane][d], bv = B[lane][d];
      assert.ok(Object.is(av, bv),
        label + ': ' + lane + '[' + d + '] not f64-exact (Object.is) -- ref=' + av + ' worker=' + bv);
    }
  }
}

test('D6 assertion 1: TWO independent off-thread round trips are f64-EXACT (Object.is) vs the single-threaded path', async () => {
  const ref = buildScene(makeCtx());
  const wk = buildScene(makeCtx());

  const worker = new Worker(WORKER_URL);
  let pending = null;
  wk.stage.useWorker(worker);
  worker.on('message', () => { const r = pending; pending = null; if (r) r(); });
  const roundTrip = () => new Promise((res) => { pending = res; wk.stage.frame(DT); });

  // -- Round trip #1: the INITIAL pose (set at buildScene time). ---------------
  // frame() ALWAYS sends the live poses even on the unprimed bootstrap frame, so
  // one awaited round trip is a complete detach -> transfer -> compose ->
  // transfer-back -> rebind cycle over the initial pose.
  await roundTrip();
  ref.stage.frame(DT);   // main-thread compose of the SAME initial pose
  assertExactWorldMatrices(ref.stage, wk.stage, 'round trip #1 (initial pose)');

  // -- Round trip #2: an INDEPENDENT pose mutation, applied identically to both
  // backends while lanes are home (post-reply), then round-tripped again. -----
  ref.stage.setPosition(ref.root, -4, 5, -6);
  ref.stage.setEuler(ref.root, -0.7, 1.2, 0.3);
  ref.stage.setScale(ref.grand, 3, 1, 0.2);
  wk.stage.setPosition(wk.root, -4, 5, -6);
  wk.stage.setEuler(wk.root, -0.7, 1.2, 0.3);
  wk.stage.setScale(wk.grand, 3, 1, 0.2);

  // ONE round trip is a complete cycle: frame() sends the CURRENT (mutated)
  // poses at its send leg, and the awaited reply rebinds with their compose.
  await roundTrip();
  ref.stage.frame(DT);   // main-thread compose of the SAME second pose
  assertExactWorldMatrices(ref.stage, wk.stage, 'round trip #2 (independent mutated pose)');

  await worker.terminate();
});
