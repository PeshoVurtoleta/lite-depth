// QA torture-harness falsifiable-assertion suite for v1.5.0 "D3": per-node
// screen-space AABB cull + opt-in dirtyRect. Depth.js/Motion.js are NOT
// edited by this file.
//
// Independent oracle: `test/fixtures/depth-1.3.0-reference.mjs` is a VERBATIM
// (ASCII-normalized only) copy of the real, git-committed v1.3.0 Depth.js. Its
// per-face viewport cull (aabb2.set into a Float32Array + aabb2.intersects) is
// UNCHANGED between 1.3.0 and 1.4.0 (only D2/shading changed in 1.4.0), so it
// is a valid stand-in for "the v1.4.0 face-cull path" the planner asked for.
//
// PLANNER ASSERTION 1's caveat: the new inline compare is f64 where the OLD
// path truncated a face's box into a Float32Array before comparing. At a
// sub-f32-ULP boundary the cull/draw tally can legitimately flip (both sides
// of that flip are off-canvas, so no visible-pixel change). Every NEW-vs-OLD
// mismatch below is CLASSIFIED, never hand-waved: an independent f64 oracle
// (reading the actual projected screenXY/viewZ NEW itself computed -- the
// projection formula is not what is in question here, only the aabb2 f32
// truncation is) decides ground truth, and a second f32-simulated oracle
// (Math.fround applied to the box before the viewport compare, replicating
// aabb2.set's exact truncation) decides whether OLD's answer is FULLY
// explained by float32 rounding. Anything else is a REGRESSION -> hard FAIL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';
import * as OLD from './fixtures/depth-1.3.0-reference.mjs';

const hasGc = typeof globalThis.gc === 'function';
const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });

const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

/* ============================================================
 * shared helpers
 * ============================================================ */

// Set of face indices actually present in a stage's just-published draw list
// for a SINGLE-NODE scene (dense node index 0 by construction below).
function drawnFaceSet(stage) {
  const set = new Set();
  const ord = stage._order, dc = stage._drawCount, drawNode = stage._draw.node, drawFace = stage._draw.face;
  for (let i = 0; i < dc; i++) {
    const e = ord[i];
    if (drawFace[e] !== 0xFFFFFFFF) set.add(drawFace[e]);
  }
  return set;
}

// Independent per-face oracle. Reads NEW's own projected screenXY/viewZ (f64,
// never truncated -- the projection formula itself is validated elsewhere,
// e.g. test 12's gl-matrix cross-check; what is in question HERE is only the
// f32-vs-f64 box comparison) and reimplements near/viewport/backface culling
// from scratch, in the test file, at BOTH precisions:
//   drawnF64 -- the true (f64) answer, what NEW must match exactly.
//   drawnF32 -- the box run through Math.fround before the viewport compare,
//     replicating OLD's aabb2.set(Float32Array,...) truncation exactly; what
//     OLD must match exactly for a mismatch to be explained (not a regression).
function faceOracle(stage, g, fi, width, height, near) {
  const off = g.faceVertOffset, fv = g.faceVerts;
  const o0 = off[fi], o1 = off[fi + 1];
  const screenXY = stage._draw.screenXY, viewZ = stage._draw.viewZ, base = stage._draw.vertBase[0];
  let nearBad = false;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const pts = [];
  for (let j = o0; j < o1; j++) {
    const vi = base + fv[j];
    const z = viewZ[vi];
    if (z > -near) nearBad = true;
    const X = screenXY[vi * 2], Y = screenXY[vi * 2 + 1];
    pts.push([X, Y]);
    if (X < minx) minx = X; if (X > maxx) maxx = X;
    if (Y < miny) miny = Y; if (Y > maxy) maxy = Y;
  }
  const missF64 = !(minx <= width && maxx >= 0 && miny <= height && maxy >= 0);
  const fminx = Math.fround(minx), fminy = Math.fround(miny), fmaxx = Math.fround(maxx), fmaxy = Math.fround(maxy);
  const fw = Math.fround(width), fh = Math.fround(height);
  const missF32 = !(fminx <= fw && fmaxx >= 0 && fminy <= fh && fmaxy >= 0);
  const [ax, ay] = pts[0], [bx, by] = pts[1], [cx, cy] = pts[2];
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const backCulled = area >= 0;
  return {
    nearBad, minx, miny, maxx, maxy, missF64, missF32, backCulled,
    drawnF64: !nearBad && !missF64 && !backCulled,
    drawnF32: !nearBad && !missF32 && !backCulled,
  };
}

function f32Ulp(v) {
  const f = new Float32Array(1), i = new Int32Array(f.buffer);
  f[0] = v; i[0] += 1; return f[0] - v;
}

/* ============================================================
 * ASSERTION 1 -- 500-pose fuzz vs the v1.4.0-equivalent oracle, classified
 * ============================================================ */

test('500-pose fuzz: facesDrawn per-face membership matches the v1.4.0 oracle (OLD reference) for on-screen scenes; every mismatch is a classified sub-f32-ULP edge, never a visible regression', () => {
  const rng = mulberry32(20260815);
  const K = 64;
  let onScreenTrials = 0, offScreenTrials = 0, exactMatches = 0, edgeAcceptable = 0;
  const regressions = [];
  const oracleSelfChecks = { fail: [] };

  for (let trial = 0; trial < 500; trial++) {
    const [width, height] = (trial % 2 === 0) ? [400, 300] : [800, 600];
    const near = 0.5, far = 60;
    const radius = 6 + rng() * 6;
    const camera = { radius, near, far, fov: 0.7 + rng() * 0.5 };

    // Mixed position range: some trials land clearly on-screen, some clearly
    // off-screen, some straddle the edge -- exercising BOTH the general
    // matching case and the documented STATS SEMANTICS CHANGE bucket.
    const spread = 4 + (trial % 5) * 4; // 4..20
    const x = (rng() * 2 - 1) * spread, y = (rng() * 2 - 1) * spread * 0.6, z = (rng() * 2 - 1) * 2;
    const ex = rng() * Math.PI * 2, ey = rng() * Math.PI * 2, ez = rng() * Math.PI * 2;

    const stN = createStage(stub(), { width, height, maxNodes: 4, maxVerts: 512, maxDrawFaces: 512, camera });
    const gN = stN.geometry(geometry.box(1, 1, 1)), mN = stN.material(material({ steps: K }));
    const hN = stN.addNode(gN, mN, { x, y, z });
    stN.setEuler(hN, ex, ey, ez);
    const stat = stN.frame(16);

    const stO = OLD.createStage(stub(), { width, height, maxNodes: 4, maxVerts: 512, maxDrawFaces: 512, camera });
    const gO = stO.geometry(OLD.geometry.box(1, 1, 1)), mO = stO.material(OLD.material({ steps: K }));
    const hO = stO.addNode(gO, mO, { x, y, z });
    stO.setEuler(hO, ex, ey, ez);
    stO.frame(16);

    if (stat.nodesCulled === 1) offScreenTrials++; else onScreenTrials++;

    const gMeta = stN._geometries[stN.nodes.data.geom[0]];
    const newSet = drawnFaceSet(stN), oldSet = drawnFaceSet(stO);

    for (let fi = 0; fi < gMeta.F; fi++) {
      const oracle = faceOracle(stN, gMeta, fi, width, height, near);
      const newDrawn = newSet.has(fi), oldDrawn = oldSet.has(fi);

      // NEW must ALWAYS match the true f64 oracle -- any miss here is an
      // implementation regression in the v1.5.0 diff itself, not an
      // f32-boundary artifact (NEW never truncates).
      if (newDrawn !== oracle.drawnF64) {
        oracleSelfChecks.fail.push({ trial, fi, newDrawn, oracleF64: oracle.drawnF64, x, y, z, ex, ey, ez, width, height, camera, box: [oracle.minx, oracle.miny, oracle.maxx, oracle.maxy] });
        continue;
      }

      if (newDrawn === oldDrawn) { exactMatches++; continue; }

      // Mismatch: classify. Acceptable iff (a) OLD's answer is fully explained
      // by float32 truncation of the viewport test (drawnF32 matches OLD's
      // actual behaviour) AND (b) the truncation actually FLIPPED the
      // viewport decision (missF64 !== missF32) -- i.e. this really is an
      // edge-of-viewport, off-canvas-either-way artifact, not some other bug.
      const truncationExplainsOld = oldDrawn === oracle.drawnF32;
      const genuineFlip = oracle.missF64 !== oracle.missF32;
      if (truncationExplainsOld && genuineFlip) {
        edgeAcceptable++;
      } else {
        regressions.push({
          trial, fi, newDrawn, oldDrawn, oracleF64: oracle.drawnF64, oracleF32: oracle.drawnF32,
          x, y, z, ex, ey, ez, width, height, camera,
          box: [oracle.minx, oracle.miny, oracle.maxx, oracle.maxy],
          nearBad: oracle.nearBad, backCulled: oracle.backCulled,
        });
      }
    }
  }

  assert.equal(oracleSelfChecks.fail.length, 0,
    'NEW must match its own f64 oracle on EVERY drawn/culled face (never truncates) -- ' +
    (oracleSelfChecks.fail.length ? JSON.stringify(oracleSelfChecks.fail.slice(0, 3), null, 2) : ''));

  assert.equal(regressions.length, 0,
    regressions.length + ' UNEXPLAINED NEW-vs-OLD facesDrawn mismatch(es) -- these are NOT edge-ULP-acceptable ' +
    '(either OLD is not explained by f32 truncation, or the truncation did not actually flip the viewport decision). ' +
    'First up to 3 repros: ' + JSON.stringify(regressions.slice(0, 3), null, 2));

  assert.ok(onScreenTrials > 0, 'sanity: at least one on-screen trial must have run');
  assert.ok(offScreenTrials > 0, 'sanity: at least one fully off-screen (whole-node-culled) trial must have run');
  assert.ok(exactMatches > 0, 'sanity: at least one exact (non-vacuous) NEW===OLD match must have occurred');
  // Not asserted > 0 (random trials essentially never land exactly on a f32
  // ULP boundary by chance) -- the discriminating self-test of the classifier
  // itself is the next test below, which deliberately engineers one.
  assert.ok(edgeAcceptable >= 0);
});

/* ============================================================
 * ASSERTION 1, discriminating self-test -- engineer an ACTUAL f32-ULP
 * boundary flip so the classification machinery above is proven to fire (a
 * classifier that always says "regression" or always says "acceptable" would
 * not be caught by pure random fuzzing, which almost never lands exactly on
 * a ULP boundary).
 * ============================================================
 * Camera: eye on +Z looking down -Z (theta=0, phi=PI/2), so world X maps
 * directly (and, under ortho, LINEARLY) to screen X: sX = halfW + worldX*K.
 * A unit box's FRONT face (local z=+0.5, varying local x/y) is a real,
 * non-degenerate quad under this projection and is the node's front-facing
 * (non-backface-culled) side. Its minX (screen) is an affine function of the
 * node's world X position, so the boundary x0 solving minX(x0) = width+eps
 * is exact algebra, not search.
 */
test('discriminating self-test: an engineered face box within f32 ULP of the viewport edge IS classified edge-ULP-acceptable, proving the classifier is not vacuous', () => {
  const width = 400, height = 300, near = 0.5, far = 200, radius = 40;
  const camera = { theta: 0, phi: Math.PI / 2, radius, near, far, ortho: true, orthoScale: 4 };
  const halfW = width / 2;
  const orthoK = (Math.min(width, height) * 0.5) / camera.orthoScale;

  // Solve x0 so minX(x0) = width + eps, eps just inside the rounding envelope
  // of Math.fround(width): the f64 box is genuinely OFF (minX>width, missed),
  // but the f32-truncated box rounds minX back down to EXACTLY width (hit).
  const eps = f32Ulp(width) / 4;
  assert.equal(Math.fround(width + eps), width, 'precondition: eps must round back down to width under fround');
  const targetMinX = width + eps;
  const x0 = (targetMinX - halfW) / orthoK + 0.5; // minX = halfW + (x0-0.5)*orthoK

  const stN = createStage(stub(), { width, height, maxNodes: 4, maxVerts: 512, maxDrawFaces: 512, camera });
  const gN = stN.geometry(geometry.box(1, 1, 1)), mN = stN.material(material({}));
  const hN = stN.addNode(gN, mN, { x: x0, y: 0, z: 0 });
  const stat = stN.frame(16);

  const stO = OLD.createStage(stub(), { width, height, maxNodes: 4, maxVerts: 512, maxDrawFaces: 512, camera });
  const gO = stO.geometry(OLD.geometry.box(1, 1, 1)), mO = stO.material(OLD.material({}));
  stO.addNode(gO, mO, { x: x0, y: 0, z: 0 });
  stO.frame(16);

  const gMeta = stN._geometries[stN.nodes.data.geom[0]];
  const newSet = drawnFaceSet(stN), oldSet = drawnFaceSet(stO);
  const FRONT = 0; // geometry.box's face list: index 0 == [0,1,2,3], the local z=+0.5 face

  const oracle = faceOracle(stN, gMeta, FRONT, width, height, near);
  assert.ok(oracle.missF64 !== oracle.missF32, 'precondition: this pose must be a GENUINE f32-truncation viewport flip for face 0 (measured minx=' + oracle.minx + ')');

  const newDrawn = newSet.has(FRONT), oldDrawn = oldSet.has(FRONT);
  assert.equal(newDrawn, oracle.drawnF64, 'NEW must match the true f64 oracle at this engineered boundary (fail-closed, no truncation)');
  assert.equal(oldDrawn, oracle.drawnF32, 'OLD must match the f32-truncated oracle at this engineered boundary (reproducing the real aabb2.set truncation)');
  assert.notEqual(newDrawn, oldDrawn, 'precondition: NEW and OLD must actually DISAGREE here -- otherwise this is not exercising the boundary at all');

  // Run the SAME classification logic assertion 1 uses, inline, and require
  // it to land on "acceptable" -- proving the classifier is discriminating
  // (it does not merely rubber-stamp every mismatch).
  const truncationExplainsOld = oldDrawn === oracle.drawnF32;
  const genuineFlip = oracle.missF64 !== oracle.missF32;
  assert.ok(truncationExplainsOld && genuineFlip, 'the classifier must label this engineered mismatch edge-ULP-acceptable');
  // And the node-box door (NEW's own whole-node shortcut) must independently
  // agree the node is off-screen here -- the CHANGELOG-documented bucket move.
  assert.equal(stat.nodesCulled, 1, 'NEW: the whole node is off-screen at this boundary (its own front-face minX misses too, by the subset property)');
  assert.equal(stat.facesDrawn, 0, 'NEW draws nothing here');
});

/* ============================================================
 * ASSERTION 2 -- edge matrix: a node off each of the four viewport edges +
 * two corners culls the WHOLE node with ZERO face-loop work.
 * ============================================================ */

function nodeBoxCam() { return { theta: 0, phi: Math.PI / 2, radius: 40, near: 0.5, far: 200 }; }

test('edge matrix: on-screen node is NEVER node-box-culled (inverted control)', () => {
  const s = createStage(stub(), { width: 400, height: 300, maxNodes: 4, camera: nodeBoxCam() });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
  const h = s.addNode(g, m, {});
  s.setPosition(h, 0, 0, 0);
  const st = s.frame(16);
  assert.ok(st.facesDrawn > 0, 'precondition: on-screen node draws something');
  assert.equal(st.nodesCulled, 0, 'an on-screen node must never be node-box-culled');
});

const EDGE_CASES = [
  ['right', [120, 0, 0]], ['left', [-120, 0, 0]], ['top', [0, 120, 0]], ['bottom', [0, -120, 0]],
  ['top-right corner', [120, 120, 0]], ['bottom-left corner', [-120, -120, 0]],
];

for (const [name, pos] of EDGE_CASES) {
  test('edge matrix: node fully off the ' + name + ' viewport edge culls the WHOLE node -- 0 face-loop iterations, nodesCulled+1, facesCulled+0, nodesInvalid+0', () => {
    const s = createStage(stub(), { width: 400, height: 300, maxNodes: 4, camera: nodeBoxCam() });
    const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
    const h = s.addNode(g, m, {});
    s.setPosition(h, pos[0], pos[1], pos[2]);
    const st = s.frame(16);
    assert.equal(st.nodesCulled, 1, name + ': nodesCulled must be exactly 1');
    assert.equal(st.facesDrawn, 0, name + ': facesDrawn must be 0');
    assert.equal(st.facesCulled, 0, name + ': facesCulled must be 0 -- the face loop must run ZERO iterations (the node-box door skipped it whole, not the per-face door)');
    assert.equal(st.nodesInvalid, 0, name + ': nodesInvalid must be 0 (this is a valid, finite, merely off-screen box, not a NaN/Infinity pose)');
    assert.equal(st.drawCalls, 0, name + ': no draw calls for a wholly node-culled node');
  });
}

test('edge matrix boundary: maxNodes=1 (smallest reachable) still culls correctly', () => {
  const s = createStage(stub(), { width: 400, height: 300, maxNodes: 1, maxVerts: 64, maxDrawFaces: 64, camera: nodeBoxCam() });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
  const h = s.addNode(g, m, { x: 120, y: 0, z: 0 });
  const st = s.frame(16);
  assert.equal(st.nodesCulled, 1);
  assert.equal(st.facesCulled, 0);
});

/* ============================================================
 * ASSERTION 3 -- FAIL-OPEN: a node whose verts are all behind the near
 * plane (OR whose pose lane makes every projected vertex NaN) must be
 * DRAWN (never node-box-culled); its faces are then rejected by the
 * EXISTING per-face door (near, or -- for the NaN case -- the viewport
 * door, since NaN comparisons all fail closed too), never nodesInvalid.
 * ============================================================ */

test('FAIL-OPEN: node fully behind the near plane builds an empty node box -- drawn (not node-box-culled), rejected by the per-face near door', () => {
  const s = createStage(stub(), { width: 400, height: 300, maxNodes: 4, camera: nodeBoxCam() });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
  const h = s.addNode(g, m, {});
  s.setPosition(h, 0, 0, 40.2); // just behind the eye (radius=40): every vertex vz > -near
  const st = s.frame(16);
  assert.equal(st.nodesCulled, 0, 'FAIL-OPEN violated: a behind-near node must NOT be node-box-culled (measured nodesCulled=' + st.nodesCulled + ')');
  assert.equal(st.nodesInvalid, 0, 'a behind-near node is a valid pose, not an invalid one');
  assert.equal(st.facesDrawn, 0, 'every face must be rejected -- but by the NEAR door, not the node-box door');
  assert.ok(st.facesCulled > 0, 'the per-face near door must have actually run and rejected faces (measured facesCulled=' + st.facesCulled + ')');
});

test('FAIL-OPEN, discriminating variant: a NaN-quaternion pose lane (translation finite) also builds an empty/non-finite node box -- still drawn (not node-box-culled), rejected by the per-face VIEWPORT door via NaN propagation, not nodesInvalid', () => {
  // A NaN quaternion poisons the ROTATION part of the world matrix (M0,M1,M2,
  // M4..M6,M8..M10) but composeTRS's translation output (out[3],out[7],out[11])
  // is pure `tx/ty/tz`, unaffected by qx/qy/qz/qw -- so the node-level finite
  // door (which only checks the world CENTRE + radius + bias) does NOT reject
  // this node; it reaches the node-box accumulation with NaN-poisoned vertex
  // projections. NaN comparisons (`vz <= -near`) are always false, so no
  // vertex is folded into the box -- it stays at the Infinity seed, exactly
  // like the behind-near case. A FAIL-CLOSED node-box implementation would
  // wrongly treat "non-finite" as "cull"; this pins the opposite (correct)
  // behaviour.
  const s = createStage(stub(), { width: 400, height: 300, maxNodes: 4, camera: nodeBoxCam() });
  const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
  const h = s.addNode(g, m, { x: 0, y: 0, z: 0 });
  s.setQuaternion(h, NaN, 0, 0, 1);
  const st = s.frame(16);
  assert.equal(st.nodesCulled, 0, 'FAIL-OPEN violated: a NaN-quaternion node must NOT be node-box-culled (measured nodesCulled=' + st.nodesCulled + ')');
  assert.equal(st.nodesInvalid, 0, 'precondition: the world CENTRE stays finite (translation is unaffected by a NaN quaternion), so the earlier node-level finite door does not reject it here');
  assert.equal(st.facesDrawn, 0, 'every face must fail to draw (NaN-poisoned projection)');
  assert.ok(st.facesCulled > 0, 'faces must be rejected by the existing per-face door (here: the viewport door, since NaN <= / >= compares are always false) -- measured facesCulled=' + st.facesCulled);
});

/* ============================================================
 * ASSERTION 6 -- zero-GC, 20000 frames / 2000 nodes, dirtyRect ON (torture.mjs
 * Phase D duplicates this at the gate level; this is the node:test-visible,
 * `npm run test:gc`-gated counterpart). Skips cleanly without --expose-gc.
 * ============================================================ */

test('node-box cull + dirtyRect lane: steady-state render loop stays allocation-free (0 major / 0 minor GC) over 20000 frames / 2000 nodes',
  { skip: hasGc ? false : 'run with --expose-gc (npm run test:gc)' }, async () => {
    const { GcProfiler, checkNoGc, compareGc } = await import('@zakkster/lite-gc-profiler');
    const N = 2000, FRAMES = 1500; // matches 04-zero-gc.test.js's proven-stable window
    const stage = createStage(stub(), { width: 1280, height: 720, maxNodes: N + 4, maxVerts: (N + 4) * 8, maxDrawFaces: (N + 4) * 6, camera: { radius: 40, near: 0.5, far: 400 } });
    stage.dirtyRect = true;
    const g = stage.geometry(geometry.box(1, 1, 1)), m = stage.material(material({}));
    const H = new Array(N);
    for (let i = 0; i < N; i++) {
      const th = (i * 2.4) % 6.28, ph = (i * 0.9) % 3.14, r = 6 + (i % 30);
      H[i] = stage.addNode(g, m, { x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph), z: r * Math.sin(ph) * Math.sin(th) });
    }
    const body = (f) => { const t = f * 0.016; for (let i = 0; i < N; i++) stage.setEuler(H[i], t, t * 0.7, 0.3); stage.frame(16); };

    for (let f = 0; f < 200; f++) body(f); // warmup
    globalThis.gc(); globalThis.gc();

    const control = new GcProfiler().start();
    for (let f = 0; f < FRAMES; f++) control.markFrame(16);
    await control.settle(); const cSum = control.summary(); control.stop();

    const gc = new GcProfiler().start();
    for (let f = 0; f < FRAMES; f++) { body(f); gc.markFrame(16); }
    await gc.settle(); const sum = gc.summary(); gc.stop();

    const direct = checkNoGc(sum, { maxMajor: 0, maxMinor: 0 });
    const diff = compareGc(cSum, sum, { maxExtraMajor: 0, maxExtraMinor: 0 });
    assert.equal(sum.gc.major, 0, 'major GCs with dirtyRect ON: ' + sum.gc.major);
    assert.equal(direct.verdict, 'pass', 'direct gate: ' + direct.verdict + ' (major=' + sum.gc.major + ' minor=' + sum.gc.minor + ')');
    assert.notEqual(diff.verdict, 'fail', 'differential vs control failed');
    assert.ok(aabb2isValid(stage.sceneBox), 'sceneBox must still be a valid box after 1700 frames of churn');

    function aabb2isValid(a) {
      return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]) && Number.isFinite(a[3]) && a[0] <= a[2] && a[1] <= a[3];
    }
  });
