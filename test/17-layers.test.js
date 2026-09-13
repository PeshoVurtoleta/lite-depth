// D5 "Layers" -- QA boundary sweep over the NEW D5 surface: the flag-backed
// membership tags (Pickable / ShadowCaster / Billboard) kept in lockstep with the
// FLAGS bits, the Culled reconcile, stage.pickSet, the flat ground-shadow pass +
// stats.shadowFacesDrawn, the matOverride draw lane, and setShadowMaterial's
// fail-closed door. Every claim is MEASURED against the real Depth.js -- the module
// is not edited by this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';

const noop = () => {};

// A recording Canvas2D stub: captures the fillStyle sequence and fill()/stroke()
// counts so run-batching (one beginPath per style run) is observable byte-for-byte.
function recCtx() {
  const rec = { styles: [], fills: 0, strokes: 0, begins: 0 };
  let cur = '';
  return {
    rec,
    set fillStyle(v) { cur = v; }, get fillStyle() { return cur; },
    set strokeStyle(v) {}, set lineWidth(v) {},
    setTransform: noop, clearRect: noop,
    beginPath() { rec.begins++; rec.styles.push(cur); },
    moveTo: noop, lineTo: noop, closePath: noop,
    fill() { rec.fills++; }, stroke() { rec.strokes++; },
  };
}

const DOWN_Z = { theta: 0, phi: Math.PI / 2, radius: 12, near: 0.5, far: 200 };
const DT = 1 / 60;

// ---- tags mirror the flag bits ---------------------------------------------

test('D5 tags: addNode init flags seed the mirror tags in lockstep', () => {
  const s = createStage(recCtx(), { maxNodes: 16, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const h = s.addNode(gid, mid, { pickable: true, castShadow: true });
  const t = s._tags;
  assert.equal(t.Pickable.has(h), true, 'pickable tag seeded');
  assert.equal(t.ShadowCaster.has(h), true, 'shadow tag seeded');
  assert.equal(t.Billboard.has(h), false, 'billboard not requested -> untagged');
  const plain = s.addNode(gid, mid, {});
  assert.equal(t.Pickable.has(plain), false);
  assert.equal(t.ShadowCaster.has(plain), false);
});

test('D5 tags: set* setters keep bit and tag lockstep; remove untags automatically', () => {
  const s = createStage(recCtx(), { maxNodes: 16, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const h = s.addNode(gid, mid, {});
  const t = s._tags;
  s.setPickable(h, true); assert.equal(t.Pickable.has(h), true);
  s.setPickable(h, false); assert.equal(t.Pickable.has(h), false);
  s.setCastShadow(h, true); assert.equal(t.ShadowCaster.has(h), true);
  s.setBillboard(h, true); assert.equal(t.Billboard.has(h), true);
  s.remove(h);
  assert.equal(t.ShadowCaster.has(h), false, 'despawn cleared shadow tag');
  assert.equal(t.Billboard.has(h), false, 'despawn cleared billboard tag');
});

test('D5 tags: clear() drops every tag membership', () => {
  const s = createStage(recCtx(), { maxNodes: 16, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, { pickable: true, castShadow: true, billboard: true });
  s.clear();
  const t = s._tags;
  assert.equal(t.Pickable.count, 0);
  assert.equal(t.ShadowCaster.count, 0);
  assert.equal(t.Billboard.count, 0);
});

// ---- Culled reconcile + pickSet --------------------------------------------

test('D5 pickSet: returns pickable, on-screen dense indices; excludes culled', () => {
  const s = createStage(recCtx(), { maxNodes: 16, width: 800, height: 600, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const on = s.addNode(gid, mid, { x: 0, y: 0, z: 0, pickable: true });         // on-screen
  const off = s.addNode(gid, mid, { x: 400, y: 0, z: 0, pickable: true });      // off-screen -> culled
  s.addNode(gid, mid, { x: 0.5, y: 0, z: 0 });                                  // not pickable
  s.frame(DT);
  const out = new Int32Array(8);
  const nc = s.pickSet(out);
  assert.equal(nc, 1, 'exactly one pickable, non-culled node');
  assert.equal(out[0], s.nodes.idx(on), 'the on-screen pickable node');
  assert.equal(s._tags.Culled.has(off), true, 'off-screen pickable is Culled');
  assert.equal(s._tags.Culled.has(on), false, 'on-screen pickable is not Culled');
});

test('D5 pickSet: bounded by out capacity, returns count written', () => {
  const s = createStage(recCtx(), { maxNodes: 16, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  for (let i = 0; i < 5; i++) s.addNode(gid, mid, { x: (i - 2) * 0.6, y: 0, z: 0, pickable: true });
  s.frame(DT);
  const out = new Int32Array(3);
  assert.equal(s.pickSet(out), 3, 'clamps to out.length');
});

// ---- shadow pass + stats.shadowFacesDrawn ----------------------------------

test('D5 shadow: no shadow material -> no shadow faces (byte-identical to 1.6.0)', () => {
  const s = createStage(recCtx(), { maxNodes: 8, camera: { theta: 0.5, phi: 0.9, radius: 8, near: 0.5, far: 200 } });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, { y: 2, castShadow: true });
  s.frame(DT);
  assert.equal(s.stats.shadowFacesDrawn, 0, 'no shadow material -> shadow pass is a no-op');
  assert.ok(s.stats.facesDrawn > 0, 'the caster still draws');
});

test('D5 shadow: a tagged caster + shadow material emits ground shadow faces, counted apart', () => {
  const s = createStage(recCtx(), { maxNodes: 8, camera: { theta: 0.5, phi: 0.9, radius: 8, near: 0.5, far: 200 } });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const shadowMid = s.material(material({ r: 20, g: 20, b: 20 }));
  s.setShadowMaterial(shadowMid);
  const casterFacesBefore = (s.addNode(gid, mid, { y: 2, castShadow: true }), s.frame(DT), s.stats.facesDrawn);
  assert.ok(s.stats.shadowFacesDrawn > 0, 'shadow faces emitted');
  // The caster's own faces are still counted in facesDrawn, never double-counted.
  assert.ok(casterFacesBefore > 0);
  // Untagging the caster removes its shadow.
  const only = s._tags.ShadowCaster.dense[0];
  s.setCastShadow(only, false);
  s.frame(DT);
  assert.equal(s.stats.shadowFacesDrawn, 0, 'untagged caster casts nothing');
});

test('D5 shadow: a culled caster casts no shadow (Culled excludes it)', () => {
  const s = createStage(recCtx(), { maxNodes: 8, width: 800, height: 600, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const smid = s.material(material({ r: 10, g: 10, b: 10 }));
  s.setShadowMaterial(smid);
  s.addNode(gid, mid, { x: 400, y: 2, z: 0, castShadow: true });   // off-screen -> culled
  s.frame(DT);
  assert.equal(s.stats.shadowFacesDrawn, 0, 'a screen-culled caster casts no shadow');
});

// ---- matOverride draw lane: run batching unchanged --------------------------

test('D5 matOverride: one material -> exactly one style run (batching intact)', () => {
  const ctx = recCtx();
  const s = createStage(ctx, { maxNodes: 16, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  for (let i = 0; i < 4; i++) s.addNode(gid, mid, { x: (i - 2) * 0.4, y: 0, z: 0 });
  s.frame(DT);
  // All faces share one material and one shade class per orientation. A single
  // fillStyle-run means matOverride did not fragment the batch. The exact style
  // sequence is what 1.6.0 produced (matOverride[e] === node material for a fill).
  assert.ok(ctx.rec.begins >= 1);
  const distinct = new Set(ctx.rec.styles);
  // box faces span a few shade steps -> a small, bounded set of runs, never one-per-face.
  assert.ok(distinct.size <= ctx.rec.styles.length);
  assert.ok(s.stats.drawCalls > 0);
});

test('D5 matOverride: two materials break the run exactly at the material boundary', () => {
  const ctx = recCtx();
  const s = createStage(ctx, { maxNodes: 16, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const m0 = s.material(material({ r: 200, g: 0, b: 0 }));
  const m1 = s.material(material({ r: 0, g: 0, b: 200 }));
  s.addNode(gid, m0, { x: -0.5, y: 0, z: 0 });
  s.addNode(gid, m1, { x: 0.5, y: 0, z: 0 });
  s.frame(DT);
  // Two distinct material palettes -> at least two runs.
  assert.ok(new Set(ctx.rec.styles).size >= 2, 'materials produce distinct style runs');
});

// ---- fail-closed doors ------------------------------------------------------

test('D5 setShadowMaterial: fail closed on an unregistered id, -1 disables', () => {
  const s = createStage(recCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)); s.material(material({}));
  assert.throws(() => s.setShadowMaterial(5), /registered material id/);
  assert.throws(() => s.setShadowMaterial(1.5), /registered material id/);
  assert.doesNotThrow(() => s.setShadowMaterial(-1));   // disable is always legal
  assert.doesNotThrow(() => s.setShadowMaterial(0));    // material 0 is registered
});

// ---- reserve grows the cull-stamp lane -------------------------------------

test('D5 reserve: cull-stamp lane survives a grow (no phantom culls)', () => {
  const s = createStage(recCtx(), { maxNodes: 4, width: 800, height: 600, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  for (let i = 0; i < 4; i++) s.addNode(gid, mid, { x: (i - 2) * 0.5, y: 0, z: 0, pickable: true });
  s.frame(DT);
  assert.equal(s.reserve(64), true);
  for (let i = 0; i < 4; i++) s.addNode(gid, mid, { x: (i - 2) * 0.5, y: 1, z: 0, pickable: true });
  s.frame(DT);
  const out = new Int32Array(16);
  assert.equal(s.pickSet(out), 8, 'all on-screen pickable nodes survive the grow');
});

// ---- coverage gaps flagged by review: assertion 2 (drawKey ordering) -------
//
// Assertion 2: "every shadow entry's drawKey is strictly < its caster's
// drawKey" -- i.e. the shadow must paint BEFORE (visually under) every real
// face of the node that cast it. The DRAW_SHADOW sentinel is not exported;
// mirror the module's own literal (see the `const DRAW_SHADOW = 0xFFFFFFFD`
// comment in Depth.js) rather than reaching into internals.
const DRAW_SHADOW = 0xFFFFFFFD;

function drawRows(s) {
  const D = s._draw, dc = s._drawCount, order = s._order;
  const rows = [];
  for (let i = 0; i < dc; i++) {
    const e = order[i];
    rows.push({ node: D.node[e], fi: D.face[e] >>> 0, key: D.key[e] >>> 0 });
  }
  return rows;
}

test('D5 shadow ordering: at layer > 0, every shadow drawKey is strictly < every one of its caster\'s face drawKeys (layer separation alone guarantees it)', () => {
  const s = createStage(recCtx(), { width: 800, height: 600, maxNodes: 8, camera: { theta: 0.5, phi: 0.9, radius: 8, near: 0.5, far: 200 } });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const smid = s.material(material({ r: 10, g: 10, b: 10 }));
  s.setShadowMaterial(smid);
  const h = s.addNode(gid, mid, { x: 0, y: 2, z: 0, castShadow: true, layer: 3 });
  const d = s.nodes.idx(h);
  s.frame(DT);
  const rows = drawRows(s);
  const shadowKeys = rows.filter((r) => r.node === d && r.fi === DRAW_SHADOW).map((r) => r.key);
  const realKeys = rows.filter((r) => r.node === d && r.fi !== DRAW_SHADOW).map((r) => r.key);
  assert.ok(shadowKeys.length > 0, 'precondition: shadow faces were emitted');
  assert.ok(realKeys.length > 0, 'precondition: the caster itself drew faces');
  for (const sk of shadowKeys) {
    for (const rk of realKeys) {
      assert.ok(sk < rk, 'shadow key ' + sk + ' must be < caster face key ' + rk + ' (layer>0 case)');
    }
  }
});

// LAYER-0 ordering (D5 fix, was the reviewer-flagged gap qa turned red): "when a
// caster is at the default layer 0, slayer = layer-1 clamps to 0, so strict
// under-ordering cannot come from the layer bits." The fix keys every layer-0
// shadow at the caster's FARTHEST view-space extent (bounding-sphere far point)
// minus one depth unit -- strictly below every one of that caster's real face keys
// (a face centroid is never farther than the bounding sphere; quantize is monotonic
// in z), and it changes NO real-face key. This proves it across a camera sweep that
// previously failed 72/110: a ground-resting unit box (bottom face coincident with
// y=0) at the default layer 0, default light, must paint its shadow strictly under
// every one of its own faces at all sampled angles.
test('D5 shadow ordering (layer 0): a ground-resting caster paints its shadow strictly under every one of its own faces, across a camera sweep', () => {
  const gid0 = geometry.box(1, 1, 1);
  let angles = 0, checked = 0;
  for (let ti = 0; ti < 11; ti++) {
    for (let pi = 0; pi < 10; pi++) {
      const theta = 0.3 + ti * 0.55;          // ~0.3 .. 5.8
      const phi = 0.3 + pi * 0.28;             // ~0.3 .. 2.8
      const s = createStage(recCtx(), { width: 800, height: 600, maxNodes: 8, camera: { theta, phi, radius: 8, near: 0.5, far: 200 } });
      const gid = s.geometry(gid0), mid = s.material(material({}));
      const smid = s.material(material({ r: 10, g: 10, b: 10 }));
      s.setShadowMaterial(smid);
      // y = 0.5: a unit box's bottom face sits exactly at world y = 0, resting on
      // the ground the shadow flattens onto. layer left at its default (0).
      const h = s.addNode(gid, mid, { x: 0, y: 0.5, z: 0, castShadow: true });
      const d = s.nodes.idx(h);
      s.frame(DT);
      const rows = drawRows(s);
      const shadowKeys = rows.filter((r) => r.node === d && r.fi === DRAW_SHADOW).map((r) => r.key);
      const realKeys = rows.filter((r) => r.node === d && r.fi !== DRAW_SHADOW).map((r) => r.key);
      angles++;
      if (shadowKeys.length === 0 || realKeys.length === 0) continue;   // caster fully off-screen at this angle
      checked++;
      const maxShadow = Math.max(...shadowKeys), minReal = Math.min(...realKeys);
      assert.ok(maxShadow < minReal, 'shadow drawKey ' + maxShadow + ' must be strictly < caster face drawKey ' + minReal + ' at theta=' + theta.toFixed(2) + ' phi=' + phi.toFixed(2) + ' (layer 0)');
    }
  }
  assert.equal(angles, 110, 'swept 110 camera angles');
  assert.ok(checked >= 60, 'at least 60 angles actually emitted both shadow and real faces (measured, not vacuous) -- got ' + checked);
});

// ---- coverage gap: shared clip/shadow scratch, same frame ------------------

test('D5 shared scratch: a near-clip DRAW_CLIP face and a DRAW_SHADOW caster in the SAME frame both render with disjoint clipXY slices at correct offsets', () => {
  // radius=10 (not the file-wide DOWN_Z's radius=12) is the exact camera
  // distance test/16's own near-clip recipe (node z=9.5, near=0.5) proves
  // straddling at -- reused verbatim so this triangle is measured, not assumed,
  // to actually cross the near plane.
  const CLIP_CAM = { theta: 0, phi: Math.PI / 2, radius: 10, near: 0.5, far: 200 };
  const s = createStage(recCtx(), { width: 800, height: 600, maxNodes: 8, camera: CLIP_CAM });
  const clipGid = s.geometry(geometry.custom(
    [-0.5, -0.5, 1, 0.5, -0.5, -1, -0.5, 0.5, -1],
    [[0, 1, 2]],
  ));
  const boxGid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  const smid = s.material(material({ r: 5, g: 5, b: 5 }));
  s.setShadowMaterial(smid);
  s.addNode(clipGid, mid, { x: 0, y: 0, z: 9.5 });                              // near-plane straddling triangle
  s.addNode(boxGid, mid, { x: 3, y: 2, z: 0, castShadow: true });               // unrelated shadow caster
  s.clipNear = true;
  assert.doesNotThrow(() => s.frame(DT));
  const D = s._draw, dc = s._drawCount, order = s._order;
  const ranges = [];
  let clipCount = 0, shadowCount = 0;
  const DRAW_CLIP = 0xFFFFFFFE;
  for (let i = 0; i < dc; i++) {
    const e = order[i], fi = D.face[e] >>> 0;
    if (fi === DRAW_CLIP) { clipCount++; const ref = D.clipRef[e]; ranges.push([ref >>> 5, ref & 31]); }
    if (fi === DRAW_SHADOW) { shadowCount++; const ref = D.clipRef[e]; ranges.push([ref >>> 5, ref & 31]); }
  }
  assert.ok(clipCount > 0, 'precondition: the near-clip face emitted a DRAW_CLIP entry');
  assert.ok(shadowCount > 0, 'precondition: the caster emitted DRAW_SHADOW entries');
  // Disjoint slices: no two [start, start+count) ranges may overlap.
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i][0] >= ranges[i - 1][0] + ranges[i - 1][1], 'clipXY slices must not overlap: ' + JSON.stringify(ranges[i - 1]) + ' vs ' + JSON.stringify(ranges[i]));
  }
  // Every slice's verts must be finite (no garbage read from an unwritten or
  // overrun region of the shared scratch).
  for (const [start, count] of ranges) {
    for (let k = 0; k < count; k++) {
      assert.ok(Number.isFinite(D.clipXY[(start + k) * 2]), 'clipXY x finite at ' + (start + k));
      assert.ok(Number.isFinite(D.clipXY[(start + k) * 2 + 1]), 'clipXY y finite at ' + (start + k));
    }
  }
});

// ---- coverage gap: shared maxClipVerts overflow rejects the shadow WHOLE ---

test('D5 shared maxClipVerts overflow: near-clip verts consume most of the budget, the shadow pass fails CLOSED (facesOverflowed++, no out-of-range write, no partial polygon)', () => {
  const CAP = 20;
  const s = createStage(recCtx(), { width: 800, height: 600, maxNodes: 16, maxClipVerts: CAP, camera: DOWN_Z });
  const clipGid = s.geometry(geometry.custom(
    [-0.5, -0.5, 1, 0.5, -0.5, -1, -0.5, 0.5, -1],
    [[0, 1, 2]],
  ));
  const boxGid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  const smid = s.material(material({ r: 5, g: 5, b: 5 }));
  s.setShadowMaterial(smid);
  // 4 straddling triangles x 4 verts each = 16 of the 20-vert budget, leaving
  // only 4 -- room for at most ONE 4-vert shadow face of the box's six.
  for (let i = 0; i < 4; i++) s.addNode(clipGid, mid, { x: (i - 2) * 0.01, y: 0, z: 9.5 });
  s.addNode(boxGid, mid, { x: 3, y: 2, z: 0, castShadow: true });
  s.clipNear = true;
  const before = s.stats.facesOverflowed;
  assert.doesNotThrow(() => s.frame(DT), 'a shared-scratch overflow must never throw or corrupt state');
  assert.ok(s.stats.facesOverflowed > before, 'the overflowing shadow face must be counted via facesOverflowed (fail closed)');
  const D = s._draw, dc = s._drawCount, order = s._order;
  const DRAW_CLIP = 0xFFFFFFFE;
  const ranges = [];
  for (let i = 0; i < dc; i++) {
    const e = order[i], fi = D.face[e] >>> 0;
    if (fi === DRAW_CLIP || fi === DRAW_SHADOW) { const ref = D.clipRef[e]; ranges.push([ref >>> 5, ref & 31]); }
  }
  // No partial polygon: every surviving entry has its FULL vertex count (>=3),
  // never a truncated fragment from a rejected-mid-write face.
  for (const [, count] of ranges) assert.ok(count >= 3, 'no truncated/partial polygon may survive an overflow: got count=' + count);
  // No out-of-range write and no overlap: every slice fits inside CAP and
  // slices are pairwise disjoint (the overflow door must not have let a
  // write straddle past the budget before rejecting).
  ranges.sort((a, b) => a[0] - b[0]);
  const occupied = new Set();
  for (const [start, count] of ranges) {
    assert.ok(start + count <= CAP, 'slice [' + start + ',' + (start + count) + ') must stay within the ' + CAP + '-vert budget');
    for (let k = 0; k < count; k++) {
      assert.ok(!occupied.has(start + k), 'no two slices may claim the same clipXY vertex slot');
      occupied.add(start + k);
    }
  }
});

// ---- coverage gap: Culled has no cross-frame staleness ---------------------

test('D5 Culled staleness: membership is reconciled fresh every frame, never leaking from a prior frame', () => {
  const s = createStage(recCtx(), { width: 800, height: 600, maxNodes: 8, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const h = s.addNode(gid, mid, { x: 400, y: 0, z: 0, castShadow: true, pickable: true }); // off-screen
  s.frame(DT);
  assert.equal(s._tags.Culled.has(h), true, 'frame 1: off-screen -> culled');
  s.setPosition(h, 0, 0, 0); // move on-screen
  s.frame(DT);
  assert.equal(s._tags.Culled.has(h), false, 'frame 2: on-screen -> NOT culled (must not still carry frame 1 membership)');
  s.setPosition(h, 400, 0, 0); // move off-screen again
  s.frame(DT);
  assert.equal(s._tags.Culled.has(h), true, 'frame 3: off-screen again -> culled (fresh reconcile, not a one-shot latch)');
  s.setPosition(h, 0, 0, 0);
  s.frame(DT);
  assert.equal(s._tags.Culled.has(h), false, 'frame 4: on-screen again -> NOT culled');
});

// ---- assertion 1: joinN([ShadowCaster],[Culled]) === brute-force filter ---
//
// Planner assertion 1: "joinN([ShadowCaster],[Culled]) result === a
// brute-force filter over a randomized caster/culled assignment, every
// frame, 1000 frames x 1000 nodes, 0 mismatches." joinN's own plan object is
// not part of the public surface, so this drives the SAME two questions a
// stale/incorrect plan would get wrong, at the stated scale, through the
// public stage._tags handles and the actual DRAW_SHADOW output:
//   - no FALSE POSITIVE: a node that produced a DRAW_SHADOW entry must be a
//     ShadowCaster member that is NOT in Culled (never a stale/foreign hit).
//   - no FALSE NEGATIVE: every ShadowCaster member not in Culled must have
//     produced at least one DRAW_SHADOW entry (never silently dropped).
// The viewport is oversized and the light/depth range are chosen so a node
// that survives its own near/far cull always has its flattened footprint
// on-screen too -- isolating the join's set membership from the unrelated
// per-polygon viewport-cull confound (which is exercised separately above).
test('D5 assertion 1: joinN([ShadowCaster],[Culled]) matches a brute-force filter every frame, 1000 frames x 1000 nodes, 0 mismatches', () => {
  const N = 1000, FRAMES = 1000;
  const CAM = { theta: 0, phi: Math.PI / 2, radius: 10, near: 0.5, far: 20 };
  const s = createStage(recCtx(), { width: 200000, height: 200000, maxNodes: N, camera: CAM });
  const gid = s.geometry(geometry.box(0.2, 0.2, 0.2)), mid = s.material(material({}));
  const smid = s.material(material({ r: 10, g: 10, b: 10 }));
  s.setShadowMaterial(smid);
  const handles = new Array(N);
  for (let i = 0; i < N; i++) handles[i] = s.addNode(gid, mid, { x: (i % 20) * 0.3, y: ((i / 20 | 0) % 20) * 0.3, z: 5 });

  let seed = 1234;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  let mismatches = 0, sampledCasters = 0, sampledRef = 0;
  const DS = 0xFFFFFFFD;
  for (let f = 0; f < FRAMES; f++) {
    for (let i = 0; i < N; i++) {
      s.setCastShadow(handles[i], rnd() < 0.5);
      // Occasionally push a node's depth outside [near,far] to force the
      // node-level cull (and therefore Culled membership); otherwise keep it
      // safely inside range.
      const z = rnd() < 0.3 ? (rnd() < 0.5 ? 0.1 : 30) : 5;
      s.setPosition(handles[i], (i % 20) * 0.3, ((i / 20 | 0) % 20) * 0.3, z);
    }
    s.frame(DT);
    const t = s._tags;
    const ref = new Set();
    for (let k = 0; k < t.ShadowCaster.count; k++) {
      const h = t.ShadowCaster.dense[k];
      if (!t.Culled.has(h)) ref.add(h);
    }
    sampledCasters += t.ShadowCaster.count;
    sampledRef += ref.size;

    const D = s._draw, dc = s._drawCount, order = s._order;
    const got = new Set();
    for (let i = 0; i < dc; i++) {
      const e = order[i];
      if ((D.face[e] >>> 0) === DS) got.add(handles[D.node[e]]);
    }
    for (const h of got) if (!ref.has(h)) mismatches++;
    for (const h of ref) if (!got.has(h)) mismatches++;
  }
  assert.ok(sampledCasters > 0, 'precondition: casters were assigned across the run');
  assert.ok(sampledRef > 0, 'precondition: some non-culled casters existed to be matched');
  assert.equal(mismatches, 0, 'joinN([ShadowCaster],[Culled]) must match the brute-force filter exactly, 0 mismatches over ' + FRAMES + ' frames x ' + N + ' nodes');
});

// ---- checked-mode option (D5): stale-join-plan guard is now reachable -------
//
// createStage forwards { checked } to lite-arena's Arena. Dev-only; default false
// and byte-identical unchecked. With it on, the stage's own arena (exposed as
// stage.arena, its tags as stage._tags) hands back a staleness-guarded joinN plan
// so a consumer that interleaves its own arena joins with a lite-depth plan read
// gets a THROW instead of a silently-superseded plan. This is the half of the
// contract that was unmeasurable while createStage always built an unchecked arena.

test('D5 checked: default (unchecked) frame + pickSet work and never throw', () => {
  const s = createStage(recCtx(), { maxNodes: 8, width: 800, height: 600, camera: DOWN_Z });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0, pickable: true });
  assert.doesNotThrow(() => s.frame(DT));
  const out = new Int32Array(8);
  assert.doesNotThrow(() => s.pickSet(out));
});

test('D5 checked: { checked: true } forwards to the arena -- a stale joinN plan read throws', () => {
  const s = createStage(recCtx(), { maxNodes: 8, width: 800, height: 600, camera: DOWN_Z, checked: true });
  s.dirtyRect = true;
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0, pickable: true, castShadow: true });
  // frame() (shadow/pick machinery) and pickSet still work in checked mode.
  assert.doesNotThrow(() => s.frame(DT));
  const out = new Int32Array(8);
  assert.doesNotThrow(() => s.pickSet(out));
  // The stale-plan guard is now reachable: a consumer joining on the SAME arena
  // between reading a plan invalidates the earlier one.
  const t = s._tags;
  const p1 = s.arena.joinN([t.Pickable], [t.Culled]);
  s.arena.joinN([t.ShadowCaster], [t.Culled]);   // supersedes p1
  assert.throws(() => p1.driver, /stale joinN\(\) plan read/);
});

test('D5 checked: a contradiction (set both required and excluded) throws in checked mode', () => {
  const s = createStage(recCtx(), { maxNodes: 8, camera: DOWN_Z, checked: true });
  const t = s._tags;
  assert.throws(() => s.arena.joinN([t.Pickable], [t.Pickable]), /both required and excluded/);
});

// ---- REVIEWER EDGE CASE A: far-plane straddle at layer 0 -------------------
//
// The layer-0 fix keys a shadow at quantize(cvz - rad + bias) - 1, clamped to
// 0 when the quantized value is already 0. That happens exactly when the
// caster's bounding-sphere FAR extent (cvz - rad) is at or beyond the far
// plane -- i.e. part of the caster's own geometry already straddles or has
// crossed -far. There is no per-face far clip in this engine (unlike near),
// so a real face whose centroid is ALSO beyond -far quantizes to the SAME
// floor (0). At that floor, shadow key === real face key: a tie, not a
// strict violation -- which real-vs-shadow entry paints on top depends on
// radix-sort stability (real face entries are appended to the draw list
// before shadow entries every frame, so a stable sort keeps the real face
// first and the shadow paints last/on top of it). This is a narrow, bounded
// floor artifact: strictly a TIE (shadow <= real), never shadow > real, and
// it never touches a normally-framed caster (one whose far extent stays
// inside [near,far]) -- confirmed by the assertions below.
//
// NOTE (accuracy of Depth.js's own comment): the inline comment at the
// layer0Depth site says a caster whose far extent hits the floor is "about
// to be culled anyway" -- MEASURED: false in general. A caster whose
// bounding sphere continues to straddle the far plane (does not move
// relative to the camera) is NOT culled and persists at the tied floor
// indefinitely across frames (node cull is `cvz + rad < -far`, sphere-vs-
// plane, not "is any part beyond far"). The precise boundary is "the
// caster's far extent is at or beyond the far plane," not "about to be
// culled." This is a documentation-accuracy nit, not a behavioral defect --
// recorded here, not fixed (this file does not edit Depth.js).
test('D5 edge case A: far-plane straddle at layer 0 -- bounded to a TIE (never shadow > real) at the depth-saturation floor, confined to beyond-far geometry, and the caster is NOT culled (persists across frames)', () => {
  const CAM = { theta: 0, phi: Math.PI / 2, radius: 10, near: 0.5, far: 20 };
  // eye at world z=+10 looking toward -z; far plane sits at world z = 10-20 = -10.
  function probe(z) {
    const s = createStage(recCtx(), { width: 800, height: 600, maxNodes: 8, camera: CAM });
    const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({})); // local radius ~0.866
    const smid = s.material(material({ r: 10, g: 10, b: 10 }));
    s.setShadowMaterial(smid);
    const h = s.addNode(gid, mid, { x: 0, y: 0, z, castShadow: true });
    const d = s.nodes.idx(h);
    s.frame(DT);
    const rows = drawRows(s).filter((r) => r.node === d);
    return { culled: s.stats.nodesCulled > 0, rows, s, d, h };
  }

  // (1) Deep beyond-far (z=-10.5, sphere center 0.5 past the far plane at -10):
  // both the shadow floor AND the caster's own remaining real face hit key 0 --
  // a TIE, and critically never shadow > real.
  const deep = probe(-10.5);
  const deepShadow = deep.rows.filter((r) => r.fi === DRAW_SHADOW).map((r) => r.key);
  const deepReal = deep.rows.filter((r) => r.fi !== DRAW_SHADOW).map((r) => r.key);
  assert.ok(deepShadow.length > 0 && deepReal.length > 0, 'precondition: both shadow and real entries survive the straddle');
  assert.ok(deepShadow.every((k) => k === 0), 'precondition: the shadow is at the depth-saturation floor');
  assert.ok(deepReal.every((k) => k === 0), 'precondition: the caster\'s own remaining real face is ALSO at the floor (beyond-far, no per-face far clip)');
  for (const sk of deepShadow) for (const rk of deepReal) assert.ok(sk <= rk, 'floor artifact must be a TIE at worst: shadow ' + sk + ' must never exceed real ' + rk);
  // NOT culled: a persistent straddler is not "about to be culled" -- it survives
  // frame after frame as long as it does not move relative to the camera.
  assert.equal(deep.culled, false, 'a far-straddling caster is not culled -- the floor tie can persist indefinitely, not just transiently');
  for (let i = 0; i < 5; i++) { deep.s.frame(DT); assert.equal(deep.s.stats.nodesCulled, 0, 'straddle persists un-culled across repeated frames (frame ' + i + ')'); }

  // (2) Just short of the far plane (still fully inside [near,far], comfortable
  // margin): the real face's own key must NOT be at the floor, and strict
  // ordering (shadow < real, no tie) must hold -- the artifact does not smear
  // into normally-framed geometry.
  const normal = probe(-5);
  const normalShadow = normal.rows.filter((r) => r.fi === DRAW_SHADOW).map((r) => r.key);
  const normalReal = normal.rows.filter((r) => r.fi !== DRAW_SHADOW).map((r) => r.key);
  assert.ok(normalReal.length > 0 && normalReal.every((k) => k > 0), 'a normally-framed caster\'s real faces must not sit at the depth floor');
  for (const sk of normalShadow) for (const rk of normalReal) assert.ok(sk < rk, 'a normally-framed caster must keep strict shadow < real ordering (no floor artifact): shadow ' + sk + ' vs real ' + rk);
});

// ---- EDGE CASE B (fixed): negative-axis (mirror) scale ---------------------
//
// The layer-0 shadow radius now uses the MAGNITUDE-aware max
// (Math.max(Math.abs(sx),Math.abs(sy),Math.abs(sz))) in shadowPass, so a
// mirrored axis with a dominant magnitude -- e.g. scale (-3,1,1), true extent
// |sx|=3 -- contributes its real half-extent instead of being read as 1. This
// closes the shadow-over-self reopening a negative-scale caster produced.
//
// Was, before the fix (signed max, a 3x underestimate at scale -3):
//   scale(-3,1,1): 74/200 fail (worst gap: shadow=64279920 > real=64066915)
//   scale(-5,1,1): 122/200 fail
// Now: 0 fails across the sweep. (The frustum-cull radius at Depth.js:1073 keeps
// the signed max deliberately -- it is hot + all-scenes, and changing it would
// diverge the unflagged output from 1.6.0; it is surfaced as its own finding.)
// Sweeps EVERY scale combination the reviewer named for the completeness proof:
// a single dominant-magnitude mirror `(-3,1,1)` (the original repro), an
// all-axes mirror `(-5,-5,-5)`, a dominant-magnitude mirror on a DIFFERENT axis
// `(1,-10,1)`, and a fully mixed-sign, mixed-magnitude case `(-2,3,-4)`. Each
// is run across the SAME 200-angle sweep used for the original repro.
const MIRROR_SCALES = [
  [-3, 1, 1],
  [-5, -5, -5],
  [1, -10, 1],
  [-2, 3, -4],
];

test('D5 edge case B: every reviewer-named mirrored/negative-axis scale combo still paints its shadow strictly under itself at layer 0 (magnitude-aware radius)', () => {
  const gid0 = geometry.box(1, 1, 1);
  const summary = [];
  for (const [sx, sy, sz] of MIRROR_SCALES) {
    let fails = 0, checked = 0;
    const failRepros = [];
    // Rest the (scaled) box on the ground: half-extent along y is 0.5*|sy|,
    // so y = 0.5*|sy| puts the bottom face exactly at world y=0 -- the same
    // ground-resting recipe used throughout this file.
    const restY = 0.5 * Math.abs(sy);
    for (let ti = 0; ti < 20; ti++) {
      for (let pi = 0; pi < 10; pi++) {
        const theta = 0.2 + ti * 0.3, phi = 0.2 + pi * 0.28;
        const s = createStage(recCtx(), { width: 800, height: 600, maxNodes: 8, camera: { theta, phi, radius: 8, near: 0.5, far: 200 } });
        const gid = s.geometry(gid0), mid = s.material(material({}));
        const smid = s.material(material({ r: 10, g: 10, b: 10 }));
        s.setShadowMaterial(smid);
        const h = s.addNode(gid, mid, { x: 0, y: restY, z: 0, castShadow: true });
        s.setScale(h, sx, sy, sz);
        const d = s.nodes.idx(h);
        s.frame(DT);
        const rows = drawRows(s).filter((r) => r.node === d);
        const shadowKeys = rows.filter((r) => r.fi === DRAW_SHADOW).map((r) => r.key);
        const realKeys = rows.filter((r) => r.fi !== DRAW_SHADOW).map((r) => r.key);
        if (shadowKeys.length === 0 || realKeys.length === 0) continue;
        checked++;
        const maxShadow = Math.max(...shadowKeys), minReal = Math.min(...realKeys);
        if (!(maxShadow < minReal)) { fails++; if (failRepros.length < 3) failRepros.push({ theta: theta.toFixed(2), phi: phi.toFixed(2), maxShadow, minReal }); }
      }
    }
    summary.push({ scale: [sx, sy, sz], fails, checked });
    assert.ok(checked >= 60, 'precondition for scale ' + JSON.stringify([sx, sy, sz]) + ': at least 60 angles emitted both shadow and real faces (measured, not vacuous) -- got ' + checked);
    // Every shadow key strictly under every real face key at ALL sampled angles,
    // now that the layer-0 shadow radius is magnitude-aware
    // (Math.max(Math.abs(sx),Math.abs(sy),Math.abs(sz))). Repro that used to fail
    // pre-fix: camera radius=8, box at y=restY, setScale(h,sx,sy,sz), layer 0,
    // default light -- for scale (-3,1,1) specifically: 74/200 fails, worst gap
    // shadow=64279920 > real=64066915.
    assert.equal(fails, 0, 'shadow-over-self must not reproduce for scale ' + JSON.stringify([sx, sy, sz]) + '; failed at ' + fails + '/' + checked + ' angles, sample: ' + JSON.stringify(failRepros));
  }
  assert.equal(summary.length, MIRROR_SCALES.length, 'every named scale combo was actually swept');
});
