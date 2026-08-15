// QA torture-harness boundary suite for the v1.5.0 "D3" diff: per-node
// screen-space AABB cull + opt-in stage.dirtyRect (sceneBox / prevSceneBox /
// nodeBox packed lane / mergeAll fold). Depth.js is NOT edited by this file --
// every assertion drives the real, public createStage() entry points.
//
// Boundary matrix applied per new entry point: 0, 1, N-1, N, N+1, empty, null,
// undefined, NaN, -0, duplicate dispose, dispose-during-iteration, re-entrant
// write, and one adversarial case the planner did not think of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material, FORMAT_VERSION } from '../Depth.js';
import { aabb2, FORMAT_VERSION as AABB_FORMAT_VERSION } from '@zakkster/lite-aabb';

const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });

function mkStage(opts) {
  const o = Object.assign({ width: 400, height: 300, maxNodes: 8, maxVerts: 4096, maxDrawFaces: 512, camera: { radius: 20, near: 0.5, far: 200 } }, opts || {});
  const stage = createStage(stub(), o);
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  return { stage, gid, mid };
}

/* ============================================================
 * 1. FORMAT_VERSION contract
 * ============================================================
 * Depth.js re-exports the peer's packed-format contract version and asserts
 * it === 1 inside createStage (fail closed if the peer's layout ever drifts).
 * We cannot force lite-aabb's real FORMAT_VERSION to skew without swapping
 * the installed peer package, so this pins the CURRENTLY-TRUE precondition
 * the guard depends on (both sides read the same integer, both are 1, and a
 * normal createStage() does not throw) -- a measured fact, not a simulation.
 */
test('FORMAT_VERSION: Depth.js re-exports the installed lite-aabb FORMAT_VERSION verbatim (=== 1), and createStage does not throw under it', () => {
  assert.equal(typeof FORMAT_VERSION, 'number');
  assert.equal(FORMAT_VERSION, AABB_FORMAT_VERSION, 're-export must be the SAME value the installed peer exports, not a hardcoded literal');
  assert.equal(FORMAT_VERSION, 1, 'lite-depth 1.5.0 is built against packed format 1 -- if this ever fails, the peer drifted and createStage() below would (correctly) throw');
  assert.doesNotThrow(() => mkStage({ maxNodes: 4 }), 'createStage must not throw while FORMAT_VERSION === 1');
});

/* ============================================================
 * 2. dirtyRect: getters exist and are read-only, default OFF (dormant)
 * ============================================================ */

test('sceneBox / prevSceneBox: present before the first frame(), length-4 Float32Array, canonical EMPTY sentinel', () => {
  const { stage } = mkStage({ maxNodes: 4 });
  assert.ok(stage.sceneBox instanceof Float32Array);
  assert.equal(stage.sceneBox.length, 4);
  assert.ok(stage.prevSceneBox instanceof Float32Array);
  assert.equal(stage.prevSceneBox.length, 4);
  assert.ok(aabb2.isEmpty(stage.sceneBox), 'sceneBox must start at the canonical empty box before any frame()');
  assert.ok(aabb2.isEmpty(stage.prevSceneBox), 'prevSceneBox must start at the canonical empty box before any frame()');
});

test('sceneBox / prevSceneBox: read-only getters -- plain assignment throws, value unchanged (matches the _order/_drawCount getter-only pattern)', () => {
  const { stage } = mkStage({ maxNodes: 4 });
  const sbBefore = stage.sceneBox, pbBefore = stage.prevSceneBox;
  for (const bad of [new Float32Array(4), null, undefined, NaN, -0, 0]) {
    assert.throws(() => { stage.sceneBox = bad; }, TypeError, 'assigning sceneBox must throw (' + String(bad) + ')');
    assert.throws(() => { stage.prevSceneBox = bad; }, TypeError, 'assigning prevSceneBox must throw (' + String(bad) + ')');
  }
  assert.equal(stage.sceneBox, sbBefore, 'sceneBox reference unchanged after failed assignments');
  assert.equal(stage.prevSceneBox, pbBefore, 'prevSceneBox reference unchanged after failed assignments');
});

test('dirtyRect default is exactly false (not falsy-other-value), and OFF => sceneBox/prevSceneBox stay the empty sentinel forever, even while a node moves through the viewport across many frames', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 4 });
  assert.equal(stage.dirtyRect, false);
  assert.ok(Object.is(stage.dirtyRect, false), 'must be real `false`, not 0/""/undefined');

  const h = stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  for (let f = 0; f < 20; f++) {
    stage.setPosition(h, Math.sin(f), Math.cos(f), 0);
    stage.frame(16);
  }
  assert.ok(stage.stats.facesDrawn > 0, 'precondition: the stage is actually drawing something while dirtyRect is off');
  assert.ok(aabb2.isEmpty(stage.sceneBox), 'dirtyRect OFF: sceneBox must never leave the empty sentinel (the merge is skipped entirely -- zero added hot cost)');
  assert.ok(aabb2.isEmpty(stage.prevSceneBox), 'dirtyRect OFF: prevSceneBox must never leave the empty sentinel either');
});

/* ============================================================
 * 3. ADVERSARIAL: `stage.dirtyRect === true` is a STRICT check
 * ============================================================
 * The planner did not call this out: frame() gates the merge on
 * `stage.dirtyRect === true` (strict equality), not a truthy check. A naive
 * re-implementation using `if (stage.dirtyRect)` would treat `1`, `"on"`, or
 * `{}` as enabling the lane; the real one must NOT. This is the one
 * adversarial case the planner did not think of.
 */
test('ADVERSARIAL: dirtyRect set to a TRUTHY-but-not-`true` value (1, "true", {}) must stay DORMANT -- strict `=== true` gate, not a truthy check', () => {
  for (const truthyNotTrue of [1, 'true', {}, [], 'false']) {
    const { stage, gid, mid } = mkStage({ maxNodes: 4 });
    stage.dirtyRect = truthyNotTrue;
    const h = stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });
    stage.frame(16);
    assert.ok(stage.stats.facesDrawn > 0, 'precondition: node actually draws');
    assert.ok(aabb2.isEmpty(stage.sceneBox),
      'dirtyRect=' + JSON.stringify(truthyNotTrue) + ' (truthy, not === true) must NOT engage the merge -- measured sceneBox is not empty');
  }
});

/* ============================================================
 * 4. dirtyRect ON: sceneBox is THIS frame's union, prevSceneBox is LAST
 *    frame's, both track a moving node (assertion 5)
 * ============================================================ */

test('dirtyRect ON: sceneBox === this frame union, prevSceneBox === previous frame union, both track a moving node across frames', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 4, camera: { radius: 20, near: 0.5, far: 200 } });
  stage.dirtyRect = true;
  const h = stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });

  stage.frame(16);
  assert.ok(aabb2.isEmpty(stage.prevSceneBox), 'frame 1: prevSceneBox must still be the empty sentinel (no frame ran before it)');
  const box1 = aabb2.clone(stage.sceneBox);
  assert.ok(aabb2.isValid(box1), 'frame 1: sceneBox must be a valid, finite, non-empty box (the node is on-screen)');

  stage.setPosition(h, 6, 0, 0); // move right -- a materially different screen box
  stage.frame(16);
  const box2 = aabb2.clone(stage.sceneBox);
  assert.ok(aabb2.isValid(box2), 'frame 2: sceneBox must be valid');
  assert.deepEqual(Array.from(stage.prevSceneBox), Array.from(box1), "frame 2: prevSceneBox must equal frame 1's sceneBox EXACTLY");
  assert.notDeepEqual(Array.from(box2), Array.from(box1), 'frame 2: sceneBox must have moved (the node moved) -- not a stale copy');

  stage.setPosition(h, -6, 0, 0);
  stage.frame(16);
  const box3 = aabb2.clone(stage.sceneBox);
  assert.deepEqual(Array.from(stage.prevSceneBox), Array.from(box2), "frame 3: prevSceneBox must equal frame 2's sceneBox EXACTLY (one-frame lag, every frame)");
  assert.ok(box3[0] < box2[0], 'frame 3: sceneBox must have tracked the node moving further left (minX decreased)');
});

test('dirtyRect ON then OFF: sceneBox/prevSceneBox FREEZE at their last values (do not silently keep updating, do not reset)', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 4 });
  stage.dirtyRect = true;
  const h = stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  stage.frame(16);
  const frozen = aabb2.clone(stage.sceneBox);
  assert.ok(aabb2.isValid(frozen));

  stage.dirtyRect = false;
  stage.setPosition(h, 6, 0, 0); // would move the box if the lane were still live
  stage.frame(16);
  assert.deepEqual(Array.from(stage.sceneBox), Array.from(frozen), 'sceneBox must FREEZE at the last dirtyRect=true frame, not keep tracking after being disabled');
});

test('dirtyRect RE-ENTRANT toggle: enabling mid-run, the FIRST enabled frame reports prevSceneBox EMPTY (nothing was ever merged while off) and sceneBox valid for that frame', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 4 });
  const h = stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  for (let f = 0; f < 5; f++) { stage.setPosition(h, f, 0, 0); stage.frame(16); } // dormant run
  assert.ok(aabb2.isEmpty(stage.sceneBox));

  stage.dirtyRect = true; // re-entrant flip between frame() calls
  stage.frame(16);
  assert.ok(aabb2.isEmpty(stage.prevSceneBox), 'first enabled frame: prevSceneBox must be empty (nothing merged while dormant)');
  assert.ok(aabb2.isValid(stage.sceneBox), 'first enabled frame: sceneBox must already be valid THIS frame (no one-frame startup gap)');
});

/* ============================================================
 * 5. dirtyRect + node lifecycle: duplicate dispose / dispose-during-iteration
 * ============================================================ */

test('dirtyRect ON: duplicate dispose of the same node handle is a safe no-op; the surviving node still merges correctly', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  stage.dirtyRect = true;
  const a = stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  const b = stage.addNode(gid, mid, { x: 3, y: 0, z: 0 });
  stage.frame(16);
  assert.ok(aabb2.isValid(stage.sceneBox));

  stage.remove(a);
  stage.remove(a); // duplicate dispose
  let st;
  assert.doesNotThrow(() => { st = stage.frame(16); }, 'duplicate dispose must not throw with dirtyRect enabled');
  assert.equal(st.nodesTotal, 1, 'exactly one live node remains');
  assert.ok(aabb2.isValid(stage.sceneBox), 'sceneBox must still be a valid box after the duplicate dispose (from node b alone)');
});

test('dirtyRect ON: dispose-during-iteration -- removing nodes while walking the just-published draw list does not corrupt sceneBox/prevSceneBox on the NEXT frame', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  stage.dirtyRect = true;
  const H = [0, 1, 2, 3, 4].map((i) => stage.addNode(gid, mid, { x: (i - 2) * 2, y: 0, z: 0 }));
  stage.frame(16);
  const dc = stage._drawCount;
  assert.ok(dc > 0);

  let removed = 0;
  assert.doesNotThrow(() => {
    for (let i = 0; i < stage._drawCount; i++) {
      const e = stage._order[i];
      if (removed < 2) { stage.remove(H[removed]); removed++; }
    }
  }, 'iterating the draw list while disposing nodes must not throw');

  const st = stage.frame(16); // commit the removals
  assert.equal(st.nodesTotal, 5 - removed);
  assert.ok(aabb2.isValid(stage.sceneBox) || aabb2.isEmpty(stage.sceneBox), 'sceneBox must be well-formed (valid or empty), never NaN-poisoned, after mid-iteration disposal');
  for (let i = 0; i < 4; i++) assert.ok(Number.isFinite(stage.sceneBox[i]) || stage.sceneBox[i] === Infinity || stage.sceneBox[i] === -Infinity, 'sceneBox[' + i + '] must never be NaN');
});

/* ============================================================
 * 6. RE-ENTRANT WRITE: a user ctx callback that calls stage.frame() again
 *    from inside paint() (the only place D3's surface hands control back to
 *    caller-supplied code). Must not throw, hang, or leave sceneBox NaN-poisoned.
 * ============================================================ */

test('RE-ENTRANT WRITE: a ctx callback that re-enters stage.frame() during paint() does not throw, hang, or corrupt sceneBox into NaN', () => {
  let reentered = false;
  let depth = 0;
  const ctx = {
    setTransform: noop, clearRect: noop, beginPath: noop, moveTo() {
      if (!reentered && depth < 1) {
        reentered = true;
        depth++;
        stage.dirtyRect = true; // re-entrant write to the new opt-in flag itself
        stage.frame(16);        // re-entrant call, guarded to depth 1 (no infinite recursion)
        depth--;
      }
    }, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { },
  };
  var stage = createStage(ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 4096, maxDrawFaces: 512, camera: { radius: 20, near: 0.5, far: 200 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
  stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  stage.dirtyRect = true;

  assert.doesNotThrow(() => stage.frame(16), 're-entrant stage.frame() call from inside a ctx callback must not throw or hang');
  assert.ok(reentered, 'precondition: the re-entrant path was actually exercised');
  for (let i = 0; i < 4; i++) {
    const v = stage.sceneBox[i];
    assert.ok(!Number.isNaN(v), 'sceneBox[' + i + '] must never be NaN after re-entrancy (measured ' + v + ')');
  }
});

/* ============================================================
 * 7. reserve(n): the nodeBox lane grows in LOCKSTEP with maxNodes
 * ============================================================
 * nodeBox is module-private (no public handle) so it cannot be measured
 * directly; instead this proves it INDIRECTLY and behaviorally, the only way
 * observable from the public surface: grow past the original maxNodes, add a
 * node whose dense index lands PAST the old capacity, move it somewhere
 * distinctive, and confirm dirtyRect's sceneBox actually includes it. A
 * lane that did NOT grow in lockstep would silently under-write (a
 * Float32Array OOB write is a silent no-op in JS, never a throw) and the
 * new node's box would be dropped from the merge -- this is exactly the
 * failure mode that would go undetected without this behavioral proof.
 */
test('reserve(n): nodeBox lane keeps up with growth -- a node added PAST the pre-growth capacity still contributes to sceneBox (dirtyRect ON)', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 4, camera: { radius: 40, near: 0.5, far: 200 } });
  stage.dirtyRect = true;
  for (let i = 0; i < 4; i++) stage.addNode(gid, mid, { x: 0, y: 0, z: 0 }); // fill to capacity
  stage.frame(16);
  const before = aabb2.clone(stage.sceneBox);

  const grew = stage.reserve(40); // N+1 and well beyond
  assert.equal(grew, true);

  // x=5 (not x=100): must stay ON-SCREEN at this camera so the node-box CULL
  // door legitimately fires zero, isolating the lane-growth question from the
  // (working-as-intended) node-box cull.
  const far = stage.addNode(gid, mid, { x: 5, y: 0, z: 0 }); // dense index >= old maxNodes=4
  const st = stage.frame(16);
  assert.equal(st.nodesCulled, 0, 'precondition: the post-growth node must be ON-SCREEN (not node-box-culled), or this test does not isolate lane growth');
  const after = stage.sceneBox;
  assert.ok(aabb2.isValid(after), 'sceneBox must stay valid after growth');
  assert.ok(after[2] > before[2] + 10, 'the post-growth node (dense index past the OLD maxNodes) must widen sceneBox -- measured before.maxX=' + before[2] + ' after.maxX=' + after[2] + ' (a lockstep-growth failure would silently drop it, leaving sceneBox unchanged)');
});

/* ============================================================
 * 8. clear()/reserve() conservation under dirtyRect, 4096 cycles
 * ============================================================
 * Assertion 6's second half: repeated clear()+reserve()+addNode()+frame()
 * cycles must conserve the arena pool exactly (nodes.count === 0 after each
 * clear, capacity accounted for) with dirtyRect ON the whole time, so the
 * nodeBox / sceneBox / prevSceneBox lanes are exercised every cycle too.
 */
test('4096 clear/reserve/rebuild cycles with dirtyRect ON: nodes.count===0 after each clear, capacity conservation holds every cycle', () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8 });
  stage.dirtyRect = true;
  const CYCLES = 4096;
  let cap = stage.arena.capacity;

  for (let c = 0; c < CYCLES; c++) {
    const n = 1 + (c % 6); // 1..6 nodes this cycle
    for (let i = 0; i < n; i++) stage.addNode(gid, mid, { x: (i - n / 2), y: 0, z: 0 });
    stage.frame(16);
    if (stage.arena.activeCount + stage.arena.retiredCount + stage.arena.remainingCapacity() !== cap) {
      assert.fail('conservation broken at cycle ' + c);
    }
    stage.clear();
    if (stage.nodes.count !== 0) assert.fail('nodes.count !== 0 immediately after clear() at cycle ' + c);
    if (stage.remainingNodes !== cap) assert.fail('remainingNodes !== capacity after clear() at cycle ' + c);

    if ((c % 500) === 0) { // occasional reserve growth folded into the same cycle loop
      const grew = stage.reserve(cap + 4);
      if (grew) cap += 4;
    }
    stage.frame(16); // frame() on a freshly-cleared (0-node) stage must not throw
    assert.ok(aabb2.isEmpty(stage.sceneBox) || aabb2.isValid(stage.sceneBox), 'sceneBox must stay well-formed on an empty post-clear frame');
  }
  assert.equal(stage.nodes.count, 0, 'final state: 0 live nodes');
  assert.equal(stage.remainingNodes, cap, 'final state: full capacity restored');
});

/* ============================================================
 * 9. mergeAll: hand-rolled f64 fold, count in {0, 1, 2, 1000}
 * ============================================================
 * Direct unit test of the lite-aabb primitive lite-depth's scene-bbox merge
 * is built on, isolated from Depth.js's frame() pipeline entirely.
 */
function handRolledFold(packed, count) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const j = i * 4;
    minX = Math.min(minX, packed[j]); minY = Math.min(minY, packed[j + 1]);
    maxX = Math.max(maxX, packed[j + 2]); maxY = Math.max(maxY, packed[j + 3]);
  }
  return [minX, minY, maxX, maxY];
}

test('mergeAll: matches a hand-rolled f64 fold for count in {0, 1, 2, 1000}; count=0 yields isEmpty', () => {
  const N = 1000;
  const packed = new Float32Array(4 * N);
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    packed[j] = -i - 1; packed[j + 1] = -i * 0.5; packed[j + 2] = i + 1; packed[j + 3] = i * 0.5 + 1;
  }
  for (const count of [0, 1, 2, N]) {
    const out = aabb2.create();
    aabb2.mergeAll(out, packed, count);
    const expected = handRolledFold(packed, count);
    assert.deepEqual(Array.from(out), expected.map(Math.fround), 'mergeAll(count=' + count + ') must match the hand-rolled f64 fold (rounded to f32, the packed storage format)');
    if (count === 0) assert.ok(aabb2.isEmpty(out), 'count=0 must yield the canonical empty sentinel');
  }
});

/* ============================================================
 * 10. mergeAll / sceneBox: a removed node's stale box cannot pollute the
 *     scene bbox (assertion 4, second half)
 * ============================================================ */

test("a removed node's stale box cannot pollute sceneBox: remove a far-out node, step a frame, sceneBox must exclude its old bounds", () => {
  const { stage, gid, mid } = mkStage({ maxNodes: 8, camera: { radius: 40, near: 0.5, far: 200 } });
  stage.dirtyRect = true;
  const near = stage.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  const farOut = stage.addNode(gid, mid, { x: 50, y: 0, z: 0 }); // deliberately way off-screen (node-box culled)
  stage.frame(16);
  const withFar = aabb2.clone(stage.sceneBox);
  assert.ok(aabb2.isValid(withFar));

  // move farOut ONSCREEN once so its box lane actually gets a real (non-empty)
  // write, THEN remove it -- the strongest form of the pollution check (a
  // stale slot with REAL prior content, not merely an always-culled one).
  stage.setPosition(farOut, 8, 0, 0);
  stage.frame(16);
  const withFarOnscreen = aabb2.clone(stage.sceneBox);
  assert.ok(withFarOnscreen[2] > withFar[2], 'precondition: the onscreen far node actually widened sceneBox');

  stage.remove(farOut);
  stage.frame(16);
  const afterRemove = stage.sceneBox;
  assert.ok(afterRemove[2] < withFarOnscreen[2], 'sceneBox must shrink back after the wide node is removed -- measured maxX=' + afterRemove[2] + ' vs pre-removal ' + withFarOnscreen[2]);
  // The surviving node's own screen box never changed (it never moved), so the
  // post-removal scene box must equal EXACTLY the "with far, but far-not-yet-
  // onscreen" box captured earlier -- a pollution bug would instead leave the
  // removed node's old (now-stale) onscreen bounds baked into the union.
  assert.deepEqual(Array.from(afterRemove), Array.from(withFar), 'sceneBox after removing the wide node must equal EXACTLY the near-node-only box (measured ' + Array.from(afterRemove) + ' vs expected ' + Array.from(withFar) + ') -- a pollution bug would leave the removed node\'s old bounds baked in');
});
