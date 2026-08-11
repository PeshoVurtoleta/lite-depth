// Boundary coverage for the NEW cold-observability surface added to Depth.js:
//   stage.stats.nodesTotal / .facesOverflowed / .nodesInvalid  -- set in frame()'s
//     cold preamble, outside both hot loops (nodesTotal == live node count;
//     the other two are always-zero hooks D3 will populate later).
//   stage._order / stage._drawCount -- now READ-ONLY getters (no setter) over
//     internal ping-pong buffers, re-pointed each frame().
//
// Matrix: 0, 1, N-1, N, N+1, empty, null, undefined, NaN, -0, duplicate
// dispose, dispose-during-iteration, re-entrant write, and one adversarial
// case (Object.defineProperty bypassing the getter-only contract entirely).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';

const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });

// Small stage with N=5 node capacity, nodes spread so all are visible/unculled.
function mkStage(maxNodes) {
  const stage = createStage(stub(), { width: 400, height: 300, maxNodes, maxVerts: maxNodes * 80, maxDrawFaces: maxNodes * 80, camera: { radius: 20, near: 0.5, far: 200 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  return { stage, gid, mid };
}

function addSpread(stage, gid, mid, count) {
  const H = new Array(count);
  for (let i = 0; i < count; i++) H[i] = stage.addNode(gid, mid, { x: (i - count / 2) * 2, y: 0, z: 0 });
  return H;
}

// -- nodesTotal: boundary counts (0, 1, N-1, N, N+1) -------------------------

test('nodesTotal === 0 on an empty stage after frame() (boundary: 0 / empty)', () => {
  const { stage } = mkStage(8);
  const st = stage.frame(16);
  assert.equal(st.nodesTotal, 0);
  assert.equal(stage.stats.nodesTotal, 0);
});

test('nodesTotal === 1 for a single added node (boundary: 1)', () => {
  const { stage, gid, mid } = mkStage(8);
  stage.addNode(gid, mid, {});
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, 1);
});

test('nodesTotal EQUALS the number of nodes added, K in general', () => {
  const { stage, gid, mid } = mkStage(16);
  const K = 11;
  addSpread(stage, gid, mid, K);
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, K);
});

test('nodesTotal boundary: N-1 (capacity minus one) and N (exactly at capacity)', () => {
  const N = 5;
  const { stage, gid, mid } = mkStage(N);
  addSpread(stage, gid, mid, N - 1);
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, N - 1, 'N-1: below capacity');

  stage.addNode(gid, mid, { x: 99 }); // the Nth node -- fills capacity exactly
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, N, 'N: exactly at capacity');
});

test('nodesTotal boundary: N+1 -- addNode at capacity throws, nodesTotal stays pinned at N', () => {
  const N = 5;
  const { stage, gid, mid } = mkStage(N);
  addSpread(stage, gid, mid, N);
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, N);

  assert.throws(() => stage.addNode(gid, mid, { x: 99 }), 'the (N+1)th addNode must throw -- arena is at capacity');
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, N, 'a rejected N+1th add must not phantom-inflate nodesTotal');
});

test('nodesTotal tracks the LIVE count across add/remove/re-frame cycles', () => {
  const { stage, gid, mid } = mkStage(16);
  const H = addSpread(stage, gid, mid, 6);
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, 6);

  stage.remove(H[0]); stage.remove(H[1]);
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, 4, 'removed 2 of 6 -> live count 4');

  stage.addNode(gid, mid, { x: 50 });
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, 5, 'add 1 back -> live count 5');

  for (let i = 2; i < 6; i++) stage.remove(H[i]); // remove the remaining 4 original nodes
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, 1, 'all originals removed, only the re-added node remains');
});

test('duplicate dispose: removing the same handle twice does not double-decrement nodesTotal', () => {
  const { stage, gid, mid } = mkStage(8);
  const H = addSpread(stage, gid, mid, 3);
  stage.remove(H[0]);
  stage.remove(H[0]); // duplicate dispose -- must be a safe no-op (lite-arena despawn returns false)
  stage.frame(16);
  assert.equal(stage.stats.nodesTotal, 2, 'duplicate dispose must not underflow the live count');
  assert.ok(stage.stats.nodesTotal >= 0, 'nodesTotal must never go negative');
});

test('dispose-during-iteration: removing nodes while iterating stage._order does not corrupt state', () => {
  const { stage, gid, mid } = mkStage(8);
  const H = addSpread(stage, gid, mid, 5);
  stage.frame(16);
  const dc = stage._drawCount;
  assert.ok(dc > 0, 'precondition: non-empty draw list to iterate');

  // Iterate the published draw list and remove nodes mid-walk. The order/
  // drawCount handles are observation-only snapshots of the frame that just
  // ran; removing live nodes must not throw or corrupt the array being read.
  const D = stage._draw;
  let removed = 0;
  assert.doesNotThrow(() => {
    for (let i = 0; i < stage._drawCount; i++) {
      const e = stage._order[i];
      const node = D.node[e];
      if (removed < 2 && node < H.length) {
        // best-effort: remove by dense-index guess is unsafe, so remove by handle
        // directly instead -- the point is dispose calls interleaved with reads
        // of the just-published (frozen-for-this-frame) _order/_draw arrays.
        stage.remove(H[removed]);
        removed++;
      }
    }
  }, 'iterating _order while disposing nodes must not throw');

  // The just-read _order/_draw snapshot must still be internally consistent
  // (same length, same content) after disposal -- it is not live-mutated by remove().
  assert.equal(stage._drawCount, dc, '_drawCount snapshot is unaffected by remove() until the next frame()');

  stage.frame(16); // now commit the removals
  assert.equal(stage.stats.nodesTotal, 5 - removed, 'next frame() reflects the disposals made during iteration');
});

// -- facesOverflowed / nodesInvalid: pinned-zero hooks -----------------------

test('facesOverflowed === 0 and nodesInvalid === 0 after frame() (always-zero hooks, pinned)', () => {
  const { stage, gid, mid } = mkStage(8);
  addSpread(stage, gid, mid, 5);
  const st = stage.frame(16);
  assert.equal(st.facesOverflowed, 0);
  assert.equal(st.nodesInvalid, 0);
});

test('facesOverflowed / nodesInvalid stay 0 across the node-count boundary matrix (0, 1, N)', () => {
  const { stage, gid, mid } = mkStage(8);
  let st = stage.frame(16); // 0 nodes
  assert.equal(st.facesOverflowed, 0); assert.equal(st.nodesInvalid, 0);

  stage.addNode(gid, mid, {});
  st = stage.frame(16); // 1 node
  assert.equal(st.facesOverflowed, 0); assert.equal(st.nodesInvalid, 0);

  addSpread(stage, gid, mid, 4);
  st = stage.frame(16); // N nodes (5 total, capacity 8)
  assert.equal(st.facesOverflowed, 0); assert.equal(st.nodesInvalid, 0);
});

test('facesOverflowed / nodesInvalid are exactly +0, not -0 or any other falsy-but-distinct value', () => {
  const { stage, gid, mid } = mkStage(4);
  addSpread(stage, gid, mid, 2);
  const st = stage.frame(16);
  assert.ok(Object.is(st.facesOverflowed, 0), 'must be +0, Object.is guards against a stray -0 regression');
  assert.ok(Object.is(st.nodesInvalid, 0), 'must be +0');
});

// -- _order / _drawCount: readable, correct, and read-only ------------------

test('_order / _drawCount are readable after frame() and reflect the draw list', () => {
  const { stage, gid, mid } = mkStage(8);
  addSpread(stage, gid, mid, 5);
  stage.frame(16);
  const dc = stage._drawCount;
  assert.ok(dc > 0, '_drawCount > 0 for a non-empty visible stage');
  const order = stage._order;
  const seen = new Uint8Array(dc);
  for (let i = 0; i < dc; i++) {
    const e = order[i];
    assert.ok(Number.isInteger(e) && e >= 0 && e < dc, '_order[i] indexable within [0,_drawCount)');
    assert.equal(seen[e], 0, '_order is a bijection over [0,_drawCount)');
    seen[e] = 1;
  }
});

test('_drawCount === 0 for an empty stage (no nodes) after frame()', () => {
  const { stage } = mkStage(8);
  stage.frame(16);
  assert.equal(stage._drawCount, 0);
});

test('_order / _drawCount are READ-ONLY: plain assignment throws and the published value is unchanged', () => {
  const { stage, gid, mid } = mkStage(8);
  addSpread(stage, gid, mid, 3);
  stage.frame(16);
  const dcBefore = stage._drawCount, orderBefore = stage._order;

  assert.throws(() => { stage._drawCount = 999; }, TypeError, 'assigning stage._drawCount must throw TypeError (getter-only, ESM strict mode)');
  assert.equal(stage._drawCount, dcBefore, '_drawCount unchanged after a failed assignment');

  assert.throws(() => { stage._order = new Uint32Array(1); }, TypeError, 'assigning stage._order must throw TypeError (getter-only, ESM strict mode)');
  assert.equal(stage._order, orderBefore, '_order unchanged after a failed assignment');
});

test('_drawCount rejects null/undefined/NaN/-0 assignment attempts identically (all throw, value unchanged)', () => {
  const { stage, gid, mid } = mkStage(8);
  addSpread(stage, gid, mid, 3);
  stage.frame(16);
  const dcBefore = stage._drawCount;

  for (const bad of [null, undefined, NaN, -0]) {
    assert.throws(() => { stage._drawCount = bad; }, TypeError, 'assigning ' + String(bad) + ' must throw, not silently coerce');
    assert.equal(stage._drawCount, dcBefore, 'value unchanged after attempted assignment of ' + String(bad));
  }
});

test('re-entrant write: assigning stage._drawCount from WITHIN the paint callback (mid-frame()) throws and does not corrupt the in-flight frame', () => {
  let attempted = false, threw = false, caughtType = null;
  const reentrantStub = () => ({
    setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
    fill: () => {
      // Re-entrant mutation attempt from inside stage.frame()'s own paint hot loop.
      attempted = true;
      try { stageRef._drawCount = -1; }
      catch (e) { threw = true; caughtType = e.constructor.name; }
    },
    stroke: noop,
    set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { },
  });
  const stage = createStage(reentrantStub(), { width: 400, height: 300, maxNodes: 8, maxVerts: 640, maxDrawFaces: 640, camera: { radius: 20, near: 0.5, far: 200 } });
  var stageRef = stage; // referenced by the ctx.fill closure above
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  addSpread(stage, gid, mid, 3);

  assert.doesNotThrow(() => stage.frame(16), 'a caught re-entrant write attempt must not abort the in-flight frame()');
  assert.equal(attempted, true, 'precondition: the re-entrant write was actually attempted mid-frame');
  assert.equal(threw, true, 're-entrant assignment must throw exactly like an out-of-frame assignment');
  assert.equal(caughtType, 'TypeError');
  assert.ok(stage._drawCount > 0, 'post-frame _drawCount reflects the real draw list, unaffected by the failed re-entrant write');
});

// -- stats shape stability: existing fields survive the new additions -------

test('existing stats fields remain present and numeric alongside the new observability fields', () => {
  const { stage, gid, mid } = mkStage(8);
  addSpread(stage, gid, mid, 5);
  const st = stage.frame(16);
  for (const k of ['facesDrawn', 'facesCulled', 'nodesCulled', 'drawCalls', 'tTransform', 'tProject', 'tSort', 'tPaint']) {
    assert.equal(typeof st[k], 'number', k + ' must remain a number');
    assert.ok(Number.isFinite(st[k]), k + ' must remain finite');
  }
  for (const k of ['nodesTotal', 'facesOverflowed', 'nodesInvalid']) {
    assert.equal(typeof st[k], 'number', k + ' must be a number');
    assert.ok(Number.isInteger(st[k]), k + ' must be an integer');
  }
});

// -- adversarial: Object.defineProperty bypasses the getter-only contract ---

test('adversarial: Object.defineProperty can silently replace the getter-only _drawCount (a real gap in the "read-only" contract)', () => {
  // Plain assignment (`stage._drawCount = x`) throws because the accessor has
  // no setter in ESM strict mode. But the property, as declared in the object
  // literal, is CONFIGURABLE -- so Object.defineProperty does not go through
  // the setter at all; it can replace the accessor outright with a plain data
  // property. This is not a hypothetical: pin the measured, current behavior
  // so nobody mistakes "throws on `=`" for "cannot be mutated by any means."
  const { stage, gid, mid } = mkStage(8);
  addSpread(stage, gid, mid, 3);
  stage.frame(16);
  const liveBefore = stage._drawCount;
  assert.ok(liveBefore > 0);

  assert.doesNotThrow(() => {
    Object.defineProperty(stage, '_drawCount', { value: 424242, writable: true, configurable: true, enumerable: true });
  }, 'defineProperty bypasses the getter-only accessor entirely -- unlike `=`, it does not throw');
  assert.equal(stage._drawCount, 424242, 'the getter has been fully replaced by a plain data property');

  // The real, damning consequence: the property is now PERMANENTLY desynced
  // from the live frame data. frame() re-points the internal `_pubDrawCount`
  // closure variable every call, but that write no longer reaches `stage`,
  // because the accessor it used to flow through is gone.
  addSpread(stage, gid, mid, 2);
  stage.frame(16);
  assert.equal(stage._drawCount, 424242, 'once defineProperty replaces the accessor, frame() can no longer update it -- the "read-only" guarantee is a `=`-assignment guard only, not a true freeze');
});
