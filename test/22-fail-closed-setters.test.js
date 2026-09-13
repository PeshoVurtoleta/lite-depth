/**
 * D6 QA adjudication -- Reviewer finding F-A: "setter-during-detach silently
 * loses the write."
 *
 * stage.setPosition/setScale/setQuaternion/setEuler write straight into the
 * arena's pose lanes with no isDetached check. While a Worker round trip is in
 * flight (lanes transferred out), those lanes are byteLength-0 views: a write
 * to them is a silent no-op -- the call appears to succeed, returns normally,
 * and the pose is simply GONE, never applied on this frame or any later one
 * (the next Worker reply rebinds fresh views that were never told about the
 * lost write).
 *
 * DECISION (QA, adjudicating against CLAUDE.md's non-negotiable "fail closed on
 * every unverified state; null is not zero"): a silently dropped write is the
 * textbook violation -- the caller receives no signal that its mutation did not
 * take effect, which is failing OPEN on an unverified (detached) state. The cold
 * setter path costs nothing on the hot per-frame body (frame() never touches
 * this guard), so there is no zero-GC/zero-alloc tension. RULING: the setters
 * MUST throw while ANY pose lane they touch is detached, naming the field and
 * suggesting the caller wait for the lanes to be home (post-reply) or issue the
 * write before binding a Worker / after unbinding.
 *
 * This test PINS that decided behavior. It is expected to FAIL against the
 * current diff (no such guard exists) -- that failure IS the QA finding: F-A is
 * a real defect and bounces back to the coder, not a false positive.
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

function neutralize(buf) { structuredClone(buf, { transfer: [buf] }); }

// A fake Worker whose postMessage neutralizes the transfer list, exactly like a
// real transferable postMessage -- enough to put the stage into "lanes detached"
// without needing a real worker_threads round trip.
function makeFakeWorker() {
  return {
    on() {},
    postMessage(_msg, xfer) { if (xfer) for (const buf of xfer) neutralize(buf); },
  };
}

function buildDetachedStage() {
  const ctx = makeCtx();
  const s = createStage(ctx, { maxNodes: 8, width: 640, height: 480 });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
  const h = s.addNode(g, m, { x: 1, y: 2, z: 3 });
  s.useWorker(makeFakeWorker());
  s.frame(DT);   // send leg detaches every arena lane, including px..sz
  assert.equal(s.nodes.isDetached('px'), true, 'setup sanity: pose lanes must be detached');
  return { stage: s, h };
}

test('F-A DECIDED: setPosition while detached must throw, not silently drop the write', () => {
  const { stage, h } = buildDetachedStage();
  const before = { px: null };   // cannot even read px (detached) -- byteLength 0
  assert.throws(() => stage.setPosition(h, 9, 9, 9), /detached/i,
    'setPosition on a detached pose lane must throw and name the detached state, ' +
    'not silently no-op the write (Depth.js:649 currently has no guard -- QA defect F-A)');
  void before;
});

test('F-A DECIDED: setScale while detached must throw, not silently drop the write', () => {
  const { stage, h } = buildDetachedStage();
  assert.throws(() => stage.setScale(h, 2, 3, 4), /detached/i,
    'setScale on a detached lane must throw (QA defect F-A)');
});

test('F-A DECIDED: setQuaternion while detached must throw, not silently drop the write', () => {
  const { stage, h } = buildDetachedStage();
  assert.throws(() => stage.setQuaternion(h, 0, 0, 0, 1), /detached/i,
    'setQuaternion on a detached lane must throw (QA defect F-A)');
});

test('F-A DECIDED: setEuler while detached must throw, not silently drop the write', () => {
  const { stage, h } = buildDetachedStage();
  assert.throws(() => stage.setEuler(h, 0.1, 0.2, 0.3), /detached/i,
    'setEuler on a detached lane must throw (QA defect F-A)');
});

test('F-A regression proof (fixed): the detached write is REFUSED, never silently swallowed', () => {
  const { stage, h } = buildDetachedStage();
  // Inverted from the original defect pin: the guard now REFUSES the write instead
  // of letting the byteLength-0 view swallow it. The lane is still detached
  // (byteLength 0) at throw time -- proving nothing was mutated -- and once the
  // lanes are home again (unbind while home requires the send to have completed;
  // here we just assert the throw + the untouched detached view).
  assert.equal(stage.nodes.data.px.byteLength, 0, 'setup: the target view is byteLength-0 (detached)');
  assert.throws(() => stage.setPosition(h, 42, 42, 42), /detached/i,
    'the detached write must throw (fail closed), not silently no-op');
  assert.equal(stage.nodes.data.px.byteLength, 0, 'the refused write left the detached lane untouched');
});
