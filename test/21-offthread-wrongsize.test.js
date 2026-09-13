/**
 * D6 "Offthread" -- QA gap fill for planner ASSERTIONS 3 and 7:
 *
 *   3. "rebind with a WRONG-SIZE buffer throws and NO lane is re-pointed --
 *       assert every lane's byteLength is unchanged after the throw."
 *   7. "a worker that returns a WRONG-SIZE buffer (fail-closed, no lane
 *       re-pointed)"
 *
 * test/18-substrate.test.js proves this at the lite-arena primitive level
 * (Arena/SparseSet.rebind directly). It does NOT exercise the actual D6 wire:
 * stage.useWorker()'s _onWorkerReturn handler receiving a malformed 'f' reply
 * from something claiming to be a Worker. This suite closes that gap by driving
 * the real handler stage.useWorker() registers, with a hand-crafted malformed
 * reply, and asserting:
 *   - it throws (a corrupt reply is a loud crash, per Depth.js's own contract),
 *   - NOT ONE lane got re-pointed (every arena lane stays detached, byteLength 0,
 *     exactly as before the malformed reply -- rebind validates before it writes),
 *   - the stage is left in a safe, still-fail-closed state: the next frame()
 *     stalls (never reads a detached lane) rather than silently limping on.
 *
 * Also covers useWorker() input-boundary cases the D6 entry point implies:
 * 0 (falsy-but-not-null/undefined), NaN, and a re-bind of the SAME worker
 * object (must not stack a duplicate return listener).
 *
 * @license MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';

const DT = 1 / 60;

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

// A real transfer is the ONLY thing that neutralizes a buffer -- see the same
// helper + rationale in test/18-substrate.test.js.
function neutralize(buf) { structuredClone(buf, { transfer: [buf] }); }

// A fake Worker that never actually replies on its own: the test drives its
// stored 'message' handler directly, so a malformed reply can be constructed
// by hand without needing a real DepthWorker.js round trip. It DOES neutralize
// every buffer in the transfer list on postMessage, exactly as a real
// postMessage(msg, transferList) would -- otherwise the main-thread views
// would never actually go byteLength-0 and the whole scenario would be moot.
function makeFakeWorker() {
  let handler = null;
  return {
    posted: [],
    on(ev, fn) { if (ev === 'message') handler = fn; },
    postMessage(msg, xfer) {
      this.posted.push(msg);
      if (xfer) for (const buf of xfer) neutralize(buf);
    },
    deliver(msg) { handler(msg); },
  };
}

function buildScene(ctx) {
  const s = createStage(ctx, { maxNodes: 8, width: 640, height: 480 });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
  const h = s.addNode(g, m, { x: 1, y: 2, z: 3 });
  return { stage: s, h };
}

const ARENA_LANES = [
  'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz',
  'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11',
  'flags',
];

test('D6 assertion 3/7: a wrong-size lane in a Worker reply throws and re-points NOTHING', () => {
  const { stage } = buildScene(makeCtx());
  const fw = makeFakeWorker();
  stage.useWorker(fw);

  // Capture the CORRECT byteLength BEFORE the send leg neutralizes the live
  // views -- reading it off an already-detached buffer would read 0.
  const goodM0Bytes = stage.nodes.data.m0.buffer.byteLength;
  assert.ok(goodM0Bytes > 0, 'sanity: m0 buffer must be non-empty before any send');

  // Frame 1: bootstrap send -- detaches every arena lane at the main thread.
  stage.frame(DT);
  assert.equal(stage.nodes.isDetached('m0'), true, 'the send leg must detach m0');
  const sent = fw.posted[fw.posted.length - 1];
  assert.equal(sent.kind, 'f', 'the send leg posts a kind "f" frame message');

  // Every lane is detached (byteLength 0) right now -- that IS "the byteLength
  // before the malformed reply", per the arena's own transfer contract.
  for (const lane of ARENA_LANES) assert.equal(stage.nodes.isDetached(lane), true, lane + ' must be detached pre-reply');

  // Hand-craft a malformed reply: everything correctly sized EXCEPT m0, which
  // is short by one node's worth of bytes (a Worker bug / stale buffer).
  const badLanes = {};
  for (const lane of ARENA_LANES) badLanes[lane] = sent.lanes[lane];
  badLanes.m0 = new ArrayBuffer(goodM0Bytes - 8);   // wrong size (short by one f64 node slot)

  const malformed = { kind: 'f', seq: sent.seq, lanes: badLanes, wnu: sent.wnu };

  assert.throws(() => fw.deliver(malformed), /byteLength|size/i,
    'a wrong-size lane in the reply must throw, not silently rebind');

  // Fail-closed: rebind validates EVERY buffer before repointing ANY, so a
  // throw on m0 must leave EVERY other lane untouched too -- still detached,
  // still byteLength 0, exactly as before the malformed reply.
  for (const lane of ARENA_LANES) {
    assert.equal(stage.nodes.isDetached(lane), true,
      lane + ' must remain detached after the malformed reply throws (no partial rebind)');
  }

  // The stage must still refuse to read a detached lane: the next frame() must
  // stall (whole-frame skip), never limp forward on the botched reply.
  const stallsBefore = stage.stats.offthreadStalls;
  const invalidBefore = stage.stats.nodesInvalid;
  stage.frame(DT);
  assert.equal(stage.stats.offthreadStalls, stallsBefore + 1, 'a frame after a rejected reply must stall, not read a detached lane');
  assert.equal(stage.stats.nodesInvalid, invalidBefore, 'no lane was read as NaN/invalid -- it was never read at all');
});

test('D6 assertion 7: a wrong-TYPE lane (not just wrong-size) also throws with nothing re-pointed', () => {
  const { stage } = buildScene(makeCtx());
  const fw = makeFakeWorker();
  stage.useWorker(fw);
  stage.frame(DT);
  const sent = fw.posted[fw.posted.length - 1];

  const badLanes = {};
  for (const lane of ARENA_LANES) badLanes[lane] = sent.lanes[lane];
  // flags is Uint32Array-backed; hand back a buffer sized for a DIFFERENT
  // element width entirely (garbage byteLength relative to node count * 4).
  badLanes.flags = new ArrayBuffer(3);

  assert.throws(() => fw.deliver({ kind: 'f', seq: sent.seq, lanes: badLanes, wnu: sent.wnu }));
  for (const lane of ARENA_LANES) {
    assert.equal(stage.nodes.isDetached(lane), true, lane + ' must remain detached after the wrong-type reply throws');
  }
});

test('D6 boundary: useWorker(0) and useWorker(NaN) are NOT treated as unbind -- fail closed with a did-you-mean', () => {
  const { stage } = buildScene(makeCtx());
  // 0 and NaN are falsy but are neither null nor undefined -- the unbind branch
  // must NOT swallow them; they must fall through to the Worker-shape check and
  // throw (did-you-mean), never silently no-op as "unbind".
  assert.throws(() => stage.useWorker(0), /Worker-shaped|postMessage/);
  assert.throws(() => stage.useWorker(NaN), /Worker-shaped|postMessage/);
  assert.throws(() => stage.useWorker(''), /Worker-shaped|postMessage/);
});

test('D6 boundary: re-binding the SAME worker object twice does not stack a duplicate return listener', () => {
  const { stage } = buildScene(makeCtx());
  const fw = makeFakeWorker();
  let onCalls = 0;
  const countingOn = fw.on.bind(fw);
  fw.on = (ev, fn) => { onCalls++; countingOn(ev, fn); };

  stage.useWorker(fw);
  stage.useWorker(fw);   // re-bind the SAME object (e.g. a demo toggle off/on)
  assert.equal(onCalls, 1, 'binding the same Worker object twice must register the return listener only once');
});
