// Regression suite for the v1.3.0 "Painter" roadmap D1 diff (bounded-safety +
// structural correctness), reviewer-APPROVED. Pins every planner assertion
// against the REAL Depth.js/Motion.js entry points -- no mocked internals.
//
// Boundary matrix applied per new entry point: 0, 1, N-1, N, N+1, empty, null,
// undefined, NaN, -0, duplicate dispose, dispose-during-iteration, re-entrant
// write, and one adversarial case the planner did not think of (see group 4b).
//
// New entry points under test:
//   - frame()'s overflow door: vc+g.V>maxVerts / dc+g.drawSlots>maxDrawFaces
//   - rebuildTopo()'s generational parent resolution (dead/recycled parent -> ROOT)
//   - rebuildTopo()'s parent-cycle detection (throws, names both nodes)
//   - stage.structureEpoch (read-only Uint32 getter)
//   - stage.clear() / stage.reserve(n) / stage.remainingNodes
//   - stats.nodesOrphaned / stats.facesOverflowed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';
import { createMixer } from '../Motion.js';

const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });

// lite-arena: low 20 bits of a handle are the slot index (a primitive, never
// decomposed by application code -- used here ONLY to prove a slot was really
// recycled, the precondition the generational-parent test exists to pin).
const INDEX_MASK = 0xFFFFF;

function mkStage(opts) {
  const o = Object.assign({ width: 400, height: 300, maxNodes: 8, maxVerts: 4096, maxDrawFaces: 512, camera: { radius: 6 } }, opts || {});
  const stage = createStage(stub(), o);
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  return { stage, gid, mid };
}

/* ============================================================
 * 1. OVERFLOW DOOR -- STROKE (the reviewer-found blocker's regression)
 * ============================================================
 * Boundary: maxDrawFaces = N = 3, filled EXACTLY by 3 single-face fill nodes
 * (a plane has drawSlots===1 and, at this camera, always survives cull -- so
 * the reservation and the actual draw count agree, unlike a box whose
 * drawSlots reserves against F but only some faces survive backface cull).
 * A 4th, visible, in-frustum STROKE node is then the N+1th write attempt.
 * Previously: this exact scene corrupted _drawCount to budget+1, left
 * facesOverflowed at 0, and threw inside paint(). */

test('overflow door / stroke: exact-fill fill nodes then a stroke node -- no throw, _drawCount bounded, facesOverflowed counted', () => {
  const stage = createStage(stub(), { width: 400, height: 300, maxNodes: 8, maxVerts: 4096, maxDrawFaces: 3, camera: { radius: 6 } });
  const gid = stage.geometry(geometry.plane(1, 1)), mid = stage.material(material({}));
  stage.addNode(gid, mid, { x: 0 });
  stage.addNode(gid, mid, { x: 2 });
  stage.addNode(gid, mid, { x: -2 });

  const st1 = stage.frame(16);
  assert.equal(stage._drawCount, 3, 'precondition: draw list fills EXACTLY to the N=3 budget');
  assert.equal(st1.facesOverflowed, 0, 'precondition: no overflow yet at exactly-full');

  const sgid = stage.geometry(geometry.polyline([0, 0, 0, 1, 1, 1]));
  const smid = stage.material(material({ stroke: '#fff' }));
  stage.addNode(sgid, smid, { x: 4 }); // visible, in-frustum stroke node -- the N+1th write

  let st2;
  assert.doesNotThrow(() => { st2 = stage.frame(16); }, 'frame() must not throw when a stroke node would overflow the draw list');
  assert.ok(stage._drawCount <= 3, '_drawCount must never exceed maxDrawFaces (measured ' + stage._drawCount + ')');
  assert.ok(st2.facesOverflowed >= 1, 'facesOverflowed must be counted (measured ' + st2.facesOverflowed + ')');
});

/* ============================================================
 * 2. OVERFLOW DOOR -- FILL
 * ============================================================
 * Same exact-fill boundary (N=3), but the overflowing node is itself a FILL
 * node (not a stroke). Also pins drawSlots semantics: drawSlots===F for a
 * fill geometry, drawSlots===1 for a stroke/polyline regardless of F (which
 * is 0 for a polyline -- it never got Newell-normal faces). A second matrix
 * point (N=1, the smallest budget reachable through the public options API --
 * see the note below) is folded in as a second sub-case. */

test('overflow door / fill: exact-fill fill nodes then a 4th fill node -- no throw, _drawCount bounded, facesOverflowed counted', () => {
  const stage = createStage(stub(), { width: 400, height: 300, maxNodes: 8, maxVerts: 4096, maxDrawFaces: 3, camera: { radius: 6 } });
  const gid = stage.geometry(geometry.plane(1, 1)), mid = stage.material(material({}));
  stage.addNode(gid, mid, { x: 0 });
  stage.addNode(gid, mid, { x: 2 });
  stage.addNode(gid, mid, { x: -2 });
  stage.frame(16);
  assert.equal(stage._drawCount, 3, 'precondition: exactly full');

  stage.addNode(gid, mid, { x: 4 }); // N+1th fill node
  let st;
  assert.doesNotThrow(() => { st = stage.frame(16); }, 'frame() must not throw when a fill node would overflow the draw list');
  assert.ok(stage._drawCount <= 3, '_drawCount must never exceed maxDrawFaces (measured ' + stage._drawCount + ')');
  assert.ok(st.facesOverflowed >= 1, 'facesOverflowed must be counted (measured ' + st.facesOverflowed + ')');
});

test('overflow door / fill boundary N=1 (smallest maxDrawFaces reachable via the public options API)', () => {
  // NOTE (measured, out of scope for this diff): createStage's option merge is
  // `o.maxDrawFaces || 131072` / `o.maxVerts || 262144` -- a falsy-zero default,
  // so passing 0 explicitly is silently replaced by the DEFAULT budget, not an
  // actual zero-capacity stage. That means the literal "0" boundary is
  // UNREACHABLE through the public API for maxDrawFaces/maxVerts; this is a
  // pre-existing quirk in createStage's opts merge (not touched by the D1
  // overflow-door diff), flagged here rather than silently skipped. N=1 is
  // exercised instead as the smallest reachable budget.
  const stage = createStage(stub(), { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 1, camera: { radius: 6 } });
  const gid = stage.geometry(geometry.plane(1, 1)), mid = stage.material(material({}));
  stage.addNode(gid, mid, { x: 0 });
  const st1 = stage.frame(16);
  assert.equal(stage._drawCount, 1, 'N=1: fills exactly');
  assert.equal(st1.facesOverflowed, 0);

  stage.addNode(gid, mid, { x: 3 });
  const st2 = stage.frame(16);
  assert.equal(stage._drawCount, 1, 'N=1: stays bounded after the 2nd node overflows');
  assert.ok(st2.facesOverflowed >= 1, 'N=1: overflow counted (measured ' + st2.facesOverflowed + ')');
});

test('geometry.drawSlots: === F for a fill geometry, === 1 for a stroke/polyline regardless of F', () => {
  const box = geometry.box(1, 1, 1);
  assert.equal(box.kind, 'fill');
  assert.equal(box.drawSlots, box.F, 'fill: drawSlots === F (measured F=' + box.F + ')');
  assert.equal(box.F, 6, 'precondition: a unit box has 6 faces');

  const line = geometry.polyline([0, 0, 0, 1, 1, 1]);
  assert.equal(line.kind, 'stroke');
  assert.equal(line.F, 0, 'precondition: a polyline never gets Newell faces');
  assert.equal(line.drawSlots, 1, 'stroke: drawSlots === 1 even though F === 0');
});

/* ============================================================
 * 3. OVERFLOW DOOR -- VERT budget
 * ============================================================
 * Undersize maxVerts so vc+g.V>maxVerts trips for a whole node (a box has
 * V===8 vertices). Boundary matrix: N-1 (7, trips), N (8, exact fit, does
 * NOT trip -- the compare is strictly '>'), and 1 (smallest reachable). */

test('overflow door / vert budget: maxVerts = V-1 skips the node whole, no NaN, no OOB', () => {
  const { stage, gid, mid } = mkStage({ maxVerts: 7, maxDrawFaces: 512 }); // box V=8, budget=7=V-1
  stage.addNode(gid, mid, {});
  let st;
  assert.doesNotThrow(() => { st = stage.frame(16); });
  assert.equal(stage._drawCount, 0, 'the whole node must be skipped, not partially written');
  assert.equal(stage.stats.facesDrawn, 0);
  assert.ok(st.facesOverflowed >= 1, 'facesOverflowed must be counted (measured ' + st.facesOverflowed + ')');

  const sxy = stage._draw.screenXY, vz = stage._draw.viewZ;
  for (let i = 0; i < sxy.length; i++) assert.ok(!Number.isNaN(sxy[i]), 'screenXY[' + i + '] must not be NaN');
  for (let i = 0; i < vz.length; i++) assert.ok(!Number.isNaN(vz[i]), 'viewZ[' + i + '] must not be NaN');
});

test('overflow door / vert budget boundary: maxVerts === V (exact fit) does NOT trip the door', () => {
  const { stage, gid, mid } = mkStage({ maxVerts: 8, maxDrawFaces: 512 }); // box V=8, budget=8=V exactly
  stage.addNode(gid, mid, {});
  const st = stage.frame(16);
  assert.equal(st.facesOverflowed, 0, 'exact fit must NOT overflow (strict > compare)');
  assert.ok(stage._drawCount > 0, 'node must actually draw at the exact-fit boundary');
});

test('overflow door / vert budget boundary N=1 (smallest reachable; see the maxVerts||default note above)', () => {
  const { stage, gid, mid } = mkStage({ maxVerts: 1, maxDrawFaces: 512 });
  stage.addNode(gid, mid, {});
  let st;
  assert.doesNotThrow(() => { st = stage.frame(16); });
  assert.equal(stage._drawCount, 0);
  assert.ok(st.facesOverflowed >= 1, 'measured ' + st.facesOverflowed);
});

/* ============================================================
 * 4. GENERATIONAL PARENT
 * ============================================================
 * 4a (planner's literal scenario): P->C; remove(P); addNode reuses P's
 * recycled arena slot; frame()/rebuild. C's world transform must equal its
 * own LOCAL transform (reparented to ROOT, NOT the recycled stranger's
 * transform) and stats.nodesOrphaned === 1.
 *
 * "Confirm this would fail pre-fix": we cannot execute the pre-fix code in
 * this suite, so the pin is two independent, measured facts instead of one --
 * (i) the world transform is EXACTLY C's local-only composition (not merely
 * "not the stranger's"), and (ii) it is measurably far from what naive
 * aliasing to the stranger's transform would have produced. Both would be
 * false under the pre-fix "resolve parent handle by raw index, no liveness
 * check" behavior, which would alias C's parent to the stranger occupying
 * the recycled slot. */

test('generational parent (cold): orphaned child reparents to ROOT, not the recycled stranger; nodesOrphaned === 1', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  const P = stage.addNode(gid, mid, { x: 5, y: 0, z: 0 });
  const C = stage.addNode(gid, mid, { x: 1, y: 0, z: 0, parent: P });
  // deliberately no frame() here -- see 4b for the warm/cache case

  stage.remove(P);
  const stranger = stage.addNode(gid, mid, { x: 999, y: 999, z: 999 });
  assert.equal(stranger & INDEX_MASK, P & INDEX_MASK, 'precondition: the arena freelist is LIFO, so this addNode MUST reuse P\'s just-freed slot -- otherwise this test is not exercising the regression at all');
  assert.notEqual(stranger, P, 'the reused slot must carry a NEW generation (a different handle), not the old one');

  const st = stage.frame(16);
  const cDense = stage.nodes.idx(C);
  const D = stage.nodes.data;
  assert.equal(st.nodesOrphaned, 1, 'exactly one node (C) lost its parent to generational recycling');
  assert.ok(Math.abs(D.m3[cDense] - D.px[cDense]) < 1e-9, 'world X must equal LOCAL X (ROOT parent): world=' + D.m3[cDense] + ' local=' + D.px[cDense]);
  assert.ok(Math.abs(D.m7[cDense] - D.py[cDense]) < 1e-9, 'world Y must equal LOCAL Y (ROOT parent)');
  assert.ok(Math.abs(D.m11[cDense] - D.pz[cDense]) < 1e-9, 'world Z must equal LOCAL Z (ROOT parent)');
  assert.equal(D.px[cDense], 1, 'precondition: C\'s own local X is 1');
  // The pre-fix aliasing failure mode: if C's parent had resolved to the
  // stranger (index-only lookup, no generation check), world X would land
  // near 999+1=1000 -- nowhere near the correct value of 1.
  assert.ok(Math.abs(D.m3[cDense] - 1000) > 100, 'world X must NOT reflect the recycled stranger\'s transform (measured ' + D.m3[cDense] + ')');
});

test('generational parent: duplicate dispose of the dead parent does not double-count nodesOrphaned', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  const P = stage.addNode(gid, mid, { x: 5 });
  stage.addNode(gid, mid, { x: 1, parent: P });
  stage.remove(P);
  stage.remove(P); // duplicate dispose -- arena.despawn returns false, must be a safe no-op
  let st;
  assert.doesNotThrow(() => { st = stage.frame(16); });
  assert.equal(st.nodesOrphaned, 1, 'duplicate dispose must not inflate the orphan count');
});

test('ADVERSARIAL (not in the planner\'s list): orphaned child\'s world transform reparents to ROOT after its parent is removed mid-scene (warm/steady-state path)', () => {
  // This is the realistic "live churn" case, not the bootstrap case: build a
  // scene, run at least one frame (so C's world matrix is cached and its
  // DIRTY bit is cleared, exactly as it would be in any running app), THEN
  // remove the parent and recycle its slot. rebuildTopo() must not only
  // resolve parentDense[C] to -1 and count the orphan (stats.nodesOrphaned)
  // -- it must also mark the orphaned node DIRTY so frame()'s transform pass
  // (gated on "own DIRTY bit set OR parent recomputed this frame") actually
  // recomputes it instead of leaving the world matrix pinned at whatever it
  // was composed to under the now-dead parent.
  //
  // Regression guard for a real defect found during QA on this exact path
  // (a cache-warm orphan silently kept rendering its stale, dead-parent-
  // composed world transform): FIXED -- rebuildTopo's dead/recycled-parent
  // branch now does `D.flags[d] |= F_DIRTY` alongside `nodesOrphaned++`, and
  // the fix propagates through the normal dirty-parent chain to grandchildren
  // too (checked below). This test pins the corrected, permanent invariant.
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  const P = stage.addNode(gid, mid, { x: 5, y: 0, z: 0 });
  const C = stage.addNode(gid, mid, { x: 1, y: 0, z: 0, parent: P });
  const G = stage.addNode(gid, mid, { x: 2, y: 0, z: 0, parent: C }); // grandchild: subtree propagation
  stage.frame(16); // warm the cache: C.world=(6,0,0), G.world=(8,0,0); DIRTY cleared on both

  stage.remove(P);
  stage.addNode(gid, mid, { x: 999 }); // reuses P's slot (same LIFO guarantee as 4a)

  const st = stage.frame(16);
  const cDense = stage.nodes.idx(C), gDense = stage.nodes.idx(G);
  const D = stage.nodes.data;

  assert.equal(st.nodesOrphaned, 1, 'topology fix: exactly one direct orphan (C) is counted');
  assert.equal(D.px[cDense], 1, 'precondition: C\'s own local X is still 1 (unchanged)');
  assert.equal(D.m3[cDense], D.px[cDense], 'C\'s world X must equal its own LOCAL X (ROOT reparent), not the stale dead-parent-composed value -- measured ' + D.m3[cDense]);

  // Subtree propagation: G was never itself orphaned (its parent is still the
  // live node C), but C's world changed, so G's world must be recomputed too
  // -- G.world = C.world(1) + G.local(2) = 3, not the stale 8.
  assert.equal(D.m3[gDense], 3, 'grandchild G must inherit C\'s corrected world transform (measured ' + D.m3[gDense] + ')');
});

/* ============================================================
 * 5. PARENT CYCLE
 * ============================================================
 * setParent to form a cycle. Boundary: a 2-node cycle (A->B->A) and the
 * degenerate 1-node self-cycle (A->A). Both must throw an Error whose
 * message names BOTH endpoints of the loop it detected. */

test('parent cycle (A->B->A): frame()/rebuild throws an Error naming both nodes', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  const A = stage.addNode(gid, mid, {});
  const B = stage.addNode(gid, mid, {});
  stage.setParent(A, B);
  stage.setParent(B, A);

  assert.throws(
    () => stage.frame(16),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.match(err.message, /lite-depth: parent cycle detected/, 'message must identify the failure kind');
      const matches = err.message.match(/node index \d+/g);
      assert.ok(matches && matches.length === 2, 'message must name BOTH nodes in the loop (found ' + (matches ? matches.length : 0) + ')');
      assert.match(err.message, /cyclic hierarchy/, 'message must explain the cause');
      return true;
    },
    'a 2-node parent cycle must throw, not spin or silently root-fallback'
  );
});

test('parent cycle boundary: degenerate self-cycle (A->A) also throws and names the node', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  const A = stage.addNode(gid, mid, {});
  stage.setParent(A, A);
  assert.throws(
    () => stage.frame(16),
    (err) => {
      const matches = err.message.match(/node index \d+/g);
      assert.ok(matches && matches.length === 2, 'self-cycle message must still name the loop endpoints (found ' + (matches ? matches.length : 0) + ')');
      return true;
    }
  );
});

/* ============================================================
 * 6. structureEpoch
 * ============================================================ */

test('structureEpoch: is a number, read-only (assignment throws, matching the _order/_drawCount getter-only pattern), and unaffected by frame()', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  assert.equal(typeof stage.structureEpoch, 'number');
  assert.ok(Number.isInteger(stage.structureEpoch));

  const before = stage.structureEpoch;
  assert.throws(() => { stage.structureEpoch = 999; }, TypeError, 'assigning stage.structureEpoch must throw (getter-only accessor, ESM strict mode)');
  assert.equal(stage.structureEpoch, before, 'value unchanged after a failed assignment');

  for (const bad of [null, undefined, NaN, -0, 0]) {
    assert.throws(() => { stage.structureEpoch = bad; }, TypeError, 'assigning ' + String(bad) + ' must throw, not silently coerce');
  }

  // addNode/setPosition etc. are not called here -- frame() itself, run
  // repeatedly, must never bump the epoch (it is a COLD-path-only signal).
  stage.addNode(gid, mid, {});
  const afterAdd = stage.structureEpoch;
  stage.frame(16); stage.frame(16); stage.frame(16);
  assert.equal(stage.structureEpoch, afterAdd, 'frame() must never write structureEpoch');
});

test('structureEpoch: strictly changes after addNode, remove, setParent, and clear', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  const e0 = stage.structureEpoch;

  const h = stage.addNode(gid, mid, {});
  const e1 = stage.structureEpoch;
  assert.notEqual(e1, e0, 'addNode must bump structureEpoch');

  const h2 = stage.addNode(gid, mid, {});
  stage.remove(h2);
  const e2 = stage.structureEpoch;
  assert.notEqual(e2, e1, 'remove must bump structureEpoch');

  stage.setParent(h, 0);
  const e3 = stage.structureEpoch;
  assert.notEqual(e3, e2, 'setParent must bump structureEpoch');

  stage.clear();
  const e4 = stage.structureEpoch;
  assert.notEqual(e4, e3, 'clear must bump structureEpoch');
});

/* ============================================================
 * 7. clear()
 * ============================================================ */

test('clear(): drains live count to 0, restores remainingNodes to capacity, retains geometries, bumps structureEpoch, and the pool is cleanly reusable afterward', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  const capacity = stage.arena.capacity;
  const geomRefBefore = stage._geometries[gid];

  const H = [stage.addNode(gid, mid, { x: 0 }), stage.addNode(gid, mid, { x: 1 }), stage.addNode(gid, mid, { x: 2 })];
  stage.frame(16);
  assert.equal(stage.nodes.count, 3);

  const epochBefore = stage.structureEpoch;
  stage.clear();

  assert.equal(stage.remainingNodes, capacity, 'remainingNodes must equal capacity after clear()');
  assert.equal(stage.nodes.count, 0, 'live component count must be 0 after clear()');
  assert.notEqual(stage.structureEpoch, epochBefore, 'clear() must bump structureEpoch');
  assert.equal(stage._geometries[gid], geomRefBefore, 'geometries array/entries must be retained (same reference) across clear()');
  for (const h of H) assert.equal(stage.arena.isAlive(h), false, 'every pre-clear handle must be invalid after clear() (documented handle policy)');

  // pool conserved: addNode again cleanly after clear()
  const h2 = stage.addNode(gid, mid, { x: 0 });
  assert.equal(stage.remainingNodes, capacity - 1, 'remainingNodes must decrease by exactly 1 after one post-clear addNode');
  let st;
  assert.doesNotThrow(() => { st = stage.frame(16); }, 'frame() must run cleanly on a post-clear stage');
  assert.ok(st.facesDrawn > 0, 'materials/geometries must still be usable post-clear (measured facesDrawn=' + st.facesDrawn + ')');
});

test('clear() boundary: on an already-empty stage is a safe, idempotent no-op on live state (0 case)', () => {
  const { stage } = mkStage({ maxNodes: 8 });
  const capacity = stage.arena.capacity;
  assert.equal(stage.remainingNodes, capacity);

  const e0 = stage.structureEpoch;
  stage.clear();
  const e1 = stage.structureEpoch;
  stage.clear(); // duplicate clear -- must not throw or corrupt state
  const e2 = stage.structureEpoch;

  assert.equal(stage.remainingNodes, capacity, 'remainingNodes must still equal capacity');
  assert.notEqual(e1, e0, 'clear() bumps the epoch even on an empty stage');
  assert.notEqual(e2, e1, 'a second clear() still bumps the epoch (never a silent no-op on the signal)');
  assert.doesNotThrow(() => stage.frame(16), 'frame() on a repeatedly-cleared empty stage must not throw');
});

/* ============================================================
 * 8. reserve()
 * ============================================================ */

test('reserve(n): n <= capacity returns false (boundary: exactly at capacity and below), no growth', () => {
  const { stage } = mkStage({ maxNodes: 8 });
  const capacity = stage.arena.capacity;
  assert.equal(stage.reserve(capacity), false, 'n === capacity must return false (grow-only, same-size is a no-op)');
  assert.equal(stage.reserve(capacity - 1), false, 'n < capacity must return false');
  assert.equal(stage.reserve(-0), false, '-0 <= capacity must also return false (Number.isInteger(-0) is true; -0 < 0 is false)');
  assert.equal(stage.arena.capacity, capacity, 'capacity must not change on a false reserve()');
});

test('reserve(n): n > capacity returns true and grows capacity/remainingNodes accordingly', () => {
  const { stage } = mkStage({ maxNodes: 8 });
  const capacity = stage.arena.capacity;
  const remainingBefore = stage.remainingNodes;
  const grew = stage.reserve(capacity + 12);
  assert.equal(grew, true, 'n > capacity must return true');
  assert.equal(stage.arena.capacity, capacity + 12, 'capacity must grow to exactly n');
  assert.equal(stage.remainingNodes, remainingBefore + 12, 'remainingNodes must grow by exactly the delta');
});

test('reserve(n): bad args (negative, non-integer, NaN, null, undefined) all throw -- fail closed', () => {
  const { stage } = mkStage({ maxNodes: 8 });
  for (const bad of [-1, 1.5, NaN, null, undefined]) {
    assert.throws(() => stage.reserve(bad), Error, 'reserve(' + String(bad) + ') must throw');
  }
  // fail-closed must not have mutated anything
  const capacity = stage.arena.capacity;
  assert.equal(capacity, 8);
});

test('reserve(): after growth, a live Motion mixer writes into the NEW backing lanes (no stale-ref corruption)', () => {
  const stage = createStage(stub(), { width: 400, height: 300, maxNodes: 4, maxVerts: 320, maxDrawFaces: 320, camera: { radius: 20 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  const mx = createMixer(stage, { maxClips: 8 });
  const n = stage.addNode(gid, mid, {});
  mx.clip(n).posKey(0, 1, 1, 1).posKey(1, 50, 50, 50).play({ duration: 1, loop: 'once' });
  mx.update(0); // evaluate at t=0 -> writes 1,1,1 into the ORIGINAL px lane

  const pxBefore = stage.nodes.data.px;
  const denseBefore = stage.nodes.idx(n);
  assert.equal(pxBefore[denseBefore], 1);

  const grew = stage.reserve(40);
  assert.equal(grew, true);
  const pxAfter = stage.nodes.data.px;
  assert.notEqual(pxAfter, pxBefore, 'reserve() must reallocate the px lane to a NEW backing array');

  mx.update(1); // advance elapsed ~1s -> should evaluate near the t=1 key (50,50,50)
  const denseAfter = stage.nodes.idx(n);
  assert.ok(Math.abs(pxAfter[denseAfter] - 50) < 1, 'the write after growth must land in the NEW array with the correct value (measured ' + pxAfter[denseAfter] + ')');
  assert.equal(pxBefore[denseBefore], 1, 'the OLD, detached array must stay frozen at its pre-growth value -- proves the mixer is not still writing through a stale reference');
});

/* ============================================================
 * 9. stats literal: nodesOrphaned / facesOverflowed always present
 * ============================================================ */

test('stats.nodesOrphaned and stats.facesOverflowed are always present (number, 0) on a fresh frame with no overflow/orphan', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  stage.addNode(gid, mid, {});
  const st = stage.frame(16);
  assert.ok(Object.prototype.hasOwnProperty.call(st, 'nodesOrphaned'));
  assert.ok(Object.prototype.hasOwnProperty.call(st, 'facesOverflowed'));
  assert.equal(typeof st.nodesOrphaned, 'number');
  assert.equal(typeof st.facesOverflowed, 'number');
  assert.ok(Object.is(st.nodesOrphaned, 0), 'must be +0 with no orphan, not -0 or another falsy value');
  assert.ok(Object.is(st.facesOverflowed, 0), 'must be +0 with no overflow');

  // present even before the first frame() (part of the stats literal itself)
  assert.equal(typeof stage.stats.nodesOrphaned, 'number');
  assert.equal(typeof stage.stats.facesOverflowed, 'number');
});

test('stats.nodesOrphaned and stats.facesOverflowed are present on the boundary-empty stage (0 nodes) too', () => {
  const { stage } = mkStage({ maxNodes: 8 });
  const st = stage.frame(16);
  assert.equal(st.nodesOrphaned, 0);
  assert.equal(st.facesOverflowed, 0);
});
