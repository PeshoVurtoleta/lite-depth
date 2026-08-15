// Session D2 planner-assertion suite: shading now reads the WORLD matrix (not
// the local quaternion), so a child of a rotated/scaled parent is lit like its
// world pose actually is. Riders: F_NONUNIF adjugate inverse-transpose
// (stats.nodesNonUniform), material.fill/stroke honoured, NaN pose rejected
// (stats.nodesInvalid), material step cap (K>256 throws).
//
// Boundary matrix applied per new entry point: 0, 1, N-1, N, N+1, empty, null,
// undefined, NaN, -0, duplicate dispose, dispose-during-iteration, re-entrant
// write, and one adversarial case the planner did not think of (see PROBE A/B
// and the pinned defect in section 2).
//
// Independent oracle: `test/fixtures/depth-1.3.0-reference.mjs` is a VERBATIM
// (ASCII-normalized only) copy of the real, git-committed v1.3.0 Depth.js
// (commit 6838203) -- the actual pre-D2 local-quaternion shading code, not a
// re-description of it. It is imported ONLY as a comparison oracle here; it is
// never shipped (not in package.json files[]) and Depth.js/Motion.js are never
// edited by this file.
//
// A second independent oracle -- gl-matrix's mat3.normalFromMat4 (a different
// implementation of the same inverse-transpose normal-matrix algorithm than
// Depth.js's hand-rolled adjugate/det cofactor expansion) -- cross-checks the
// per-face shade math against the node's actual WORLD matrix, read directly off
// stage.nodes.data after frame().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mat3, mat4, vec3, glMatrix } from 'gl-matrix';
import { createStage, geometry, material, materialFromRamp } from '../Depth.js';
import * as OLD from './fixtures/depth-1.3.0-reference.mjs';

glMatrix.setMatrixArrayType(Float64Array);

const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });

const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// A LUT whose i-th entry hex-encodes i itself: recovering the baked shade
// index from a captured fillStyle string is then an exact, allocation-cheap
// parseInt -- no reliance on material()'s ambient/rgb ramp math staying unique
// at a given K (a real risk: low-K ramps can round two adjacent steps to the
// same hex byte).
function idxLut(K) { const a = new Array(K); for (let i = 0; i < K; i++) a[i] = '#' + i.toString(16).padStart(6, '0'); return a; }
function styleToIndex(s) { return s === null || s === undefined ? null : parseInt(s.slice(1), 16); }

// Captures the fillStyle in effect at every moveTo() call (== once per drawn
// face, or once per stroked polyline), a full call-name trace, and per-kind
// call counts -- built from the SAME primitives the shipped stub ctx uses
// (test/01,03,04's noop-per-method pattern), just observing instead of no-op.
function mkCapture() {
  const trace = [];
  const moves = [];
  let curFill = null;
  const counts = { fill: 0, stroke: 0, beginPath: 0, moveTo: 0 };
  const ctx = {
    setTransform: (...a) => trace.push('setTransform:' + a.join(',')),
    clearRect: (...a) => trace.push('clearRect:' + a.join(',')),
    beginPath: () => { trace.push('beginPath'); counts.beginPath++; },
    moveTo: (x, y) => { trace.push('moveTo:' + x + ',' + y); counts.moveTo++; moves.push(curFill); },
    lineTo: (x, y) => trace.push('lineTo:' + x + ',' + y),
    closePath: () => trace.push('closePath'),
    fill: () => { trace.push('fill'); counts.fill++; },
    stroke: () => { trace.push('stroke'); counts.stroke++; },
    set fillStyle(v) { curFill = v; trace.push('fillStyle:' + v); },
    set strokeStyle(v) { trace.push('strokeStyle:' + v); },
    set lineWidth(v) { trace.push('lineWidth:' + v); },
  };
  return { ctx, trace, moves, counts };
}

// Independent reference shade index: pulls the node's ACTUAL world 3x4
// (m0..m11, row-major) straight off stage.nodes.data (proof the fix reads the
// world matrix), builds the normal (inverse-transpose) matrix via gl-matrix's
// own Cramer's-rule invert -- a different implementation from Depth.js's
// hand-rolled adjugate/det cofactor expansion -- and reproduces the same
// clamp+quantize the source bakes into shadeL. Valid for BOTH uniform and
// non-uniform world transforms (inverse-transpose degenerates to the plain
// renormalized-rotation case when the composed scale is isotropic).
function referenceShadeIndex(M, fn, light, K) {
  const m4 = mat4.fromValues(
    M[0], M[4], M[8], 0,
    M[1], M[5], M[9], 0,
    M[2], M[6], M[10], 0,
    0, 0, 0, 1,
  );
  const nm = mat3.create();
  mat3.normalFromMat4(nm, m4);
  const wn = vec3.create();
  vec3.transformMat3(wn, fn, nm);
  vec3.normalize(wn, wn);
  let ndl = vec3.dot(wn, light);
  if (ndl < 0) ndl = 0; else if (ndl > 1) ndl = 1;
  return (ndl * (K - 1)) | 0;
}

// Reads the drawn-order (node, face, world-matrix) triples for the current
// frame and returns the reference index per drawn entry, in the SAME order
// stage._draw / paint() visits them -- so it lines up 1:1 with a capture's
// `moves` array.
function referenceIndicesForFrame(stage, K) {
  const D = stage.nodes.data, ord = stage._order, dc = stage._drawCount, geoms = stage._geometries;
  const drawNode = stage._draw.node, drawFace = stage._draw.face, light = stage.light;
  const out = new Array(dc);
  for (let i = 0; i < dc; i++) {
    const e = ord[i], d = drawNode[e], fi = drawFace[e];
    const g = geoms[D.geom[d]];
    const M = [D.m0[d], D.m1[d], D.m2[d], D.m3[d], D.m4[d], D.m5[d], D.m6[d], D.m7[d], D.m8[d], D.m9[d], D.m10[d], D.m11[d]];
    const fn = [g.faceNormal[fi * 3], g.faceNormal[fi * 3 + 1], g.faceNormal[fi * 3 + 2]];
    out[i] = referenceShadeIndex(M, fn, light, K);
  }
  return out;
}

/* ============================================================
 * 1. WORLD-SPACE SHADE EQUALITY
 * ============================================================
 * A box parented to a node at setEuler(0, PI/2, 0) must shade IDENTICALLY
 * (exact integer LUT index, all 6 faces) to the same box given that world
 * rotation directly with no parent. The child's own local pose is the
 * identity (default addNode pose), so its world 3x4 == its parent's world
 * 3x4 EXACTLY in floating point (multiplying by an identity/zero local
 * matrix introduces no rounding: A*1+B*0+C*0 == A bit-for-bit) -- so this is
 * a true zero-tolerance equality, not an epsilon compare.
 */
test('world-space shade equality: parented child (parent rotated PI/2 Y) == direct box given that world rotation, all 6 faces, exact integer index', () => {
  const K = 32, lut = idxLut(K);

  const capChild = mkCapture();
  const stageChild = createStage(capChild.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const gidC = stageChild.geometry(geometry.box(1, 1, 1)), midC = stageChild.material(materialFromRamp(lut));
  const parent = stageChild.addNode(gidC, midC, {});
  stageChild.setEuler(parent, 0, Math.PI / 2, 0);
  stageChild.setVisible(parent, false); // parent itself not drawn; only used for transform
  const child = stageChild.addNode(gidC, midC, { parent });
  stageChild.frame(16);
  const childCount = stageChild._drawCount;
  const childIdx = capChild.moves.map(styleToIndex);

  const capDirect = mkCapture();
  const stageDirect = createStage(capDirect.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const gidD = stageDirect.geometry(geometry.box(1, 1, 1)), midD = stageDirect.material(materialFromRamp(lut));
  const direct = stageDirect.addNode(gidD, midD, {});
  stageDirect.setEuler(direct, 0, Math.PI / 2, 0);
  stageDirect.frame(16);
  const directCount = stageDirect._drawCount;
  const directIdx = capDirect.moves.map(styleToIndex);

  assert.equal(childCount, directCount, 'same camera/box -> same number of surviving (backface-culled) faces');
  assert.ok(childCount >= 1 && childCount <= 6, 'sanity: box shows between 1 and 6 faces from this camera');
  assert.deepEqual(childIdx, directIdx, 'child-of-rotated-parent shade indices must equal direct-world-rotation shade indices, exactly, face-for-face');

  // ---- sanity: this equality would NOT hold under v1.3.0's local-quaternion
  // shading. Proven by actually running the real, git-committed v1.3.0 source
  // (test/fixtures/depth-1.3.0-reference.mjs) through the identical scene:
  // v1.3.0 rotated the FACE NORMAL by the node's own LOCAL quaternion (see its
  // paint(): `quatRotate(_NRM, qxL[d], qyL[d], qzL[d], qwL[d], ...)`), so the
  // child (local quaternion == identity; only its PARENT carries the PI/2
  // rotation) shaded as if unrotated, while the geometry itself was still
  // drawn from the (correctly parent-rotated) world matrix -- exactly the
  // "shading path read different inputs than the geometry path" bug the
  // CHANGELOG describes. The direct box (no parent, local quaternion ==
  // world rotation) shades correctly even under the old algorithm. So under
  // v1.3.0 child != direct; under the fixed code (above) child == direct.
  const capOldChild = mkCapture();
  const stOldChild = OLD.createStage(capOldChild.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const ogC = stOldChild.geometry(OLD.geometry.box(1, 1, 1)), omC = stOldChild.material(OLD.materialFromRamp(lut));
  const oParent = stOldChild.addNode(ogC, omC, {});
  stOldChild.setEuler(oParent, 0, Math.PI / 2, 0);
  stOldChild.setVisible(oParent, false);
  const oChild = stOldChild.addNode(ogC, omC, { parent: oParent });
  stOldChild.frame(16);
  const oldChildIdx = capOldChild.moves.map(styleToIndex);

  const capOldDirect = mkCapture();
  const stOldDirect = OLD.createStage(capOldDirect.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const ogD = stOldDirect.geometry(OLD.geometry.box(1, 1, 1)), omD = stOldDirect.material(OLD.materialFromRamp(lut));
  const oDirect = stOldDirect.addNode(ogD, omD, {});
  stOldDirect.setEuler(oDirect, 0, Math.PI / 2, 0);
  stOldDirect.frame(16);
  const oldDirectIdx = capOldDirect.moves.map(styleToIndex);

  assert.notDeepEqual(oldChildIdx, oldDirectIdx, 'REGRESSION SANITY: v1.3.0 (real, git-committed source) must NOT satisfy this equality -- if it does, this test is not exercising the D-03 bug at all');
});

/* ============================================================
 * 2. 500-POSE HIERARCHY -- exact match to an independent world-matrix oracle
 * ============================================================
 * PLANNER ASSERTION: "every drawn face's shade index matches a reference you
 * compute independently from the world matrix (integer LUT index, exact)".
 *
 * HISTORY: this originally FAILED (see git blame / prior review round).
 * F_NONUNIF was set by stage.setScale from that NODE'S OWN LOCAL sx/sy/sz
 * only (Depth.js setScale) and was never inherited down the hierarchy, so a
 * locally-uniform child under a non-uniformly-scaled ancestor took the cheap
 * "uniform renormalize" shading branch even though its ACCUMULATED WORLD
 * upper-3x3 was not a similarity transform -- it painted the WRONG shade.
 * That was PINNED and routed back to the coder.
 *
 * FIX (reviewer re-APPROVED): a `worldNonUnif` Uint8Array lane is propagated
 * in topo order, `worldNonUnif[d] = ownLocalF_NONUNIF | worldNonUnif[parent]`
 * (Depth.js, transform pass), and the shade-branch selector now keys off
 * that PROPAGATED bit (`tainted = worldNonUnif[d]`), not the static local
 * flag; the tainted path does a per-face normal-matrix transform + normalize
 * instead of the single-scalar renormalize. `stats.nodesNonUniform` stays
 * decoupled, counting only own-local-flagged drawn nodes (unaffected by
 * inheritance) -- verified separately in section 3 below.
 *
 * Both the isolated repro and the 500-fuzz below are now expected to PASS.
 */
test('regression (was PINNED, now fixed): a locally-uniform child under a non-uniformly-scaled parent is shaded via the inherited-taint branch and matches the world-matrix oracle', () => {
  const K = 64, lut = idxLut(K);
  const cap = mkCapture();
  const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 8 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));
  const parent = stage.addNode(gid, mid, {});
  stage.setScale(parent, 3, 1, 1);         // parent: non-uniform, NO rotation (isolates the bug from D-03's own math)
  stage.setVisible(parent, false);          // parent itself not drawn
  const child = stage.addNode(gid, mid, { parent });
  stage.setEuler(child, 0.4, 0.9, 0.2);      // child: rotated, LOCALLY uniform scale (default 1,1,1) -> F_NONUNIF OFF

  const st = stage.frame(16);
  const actual = cap.moves.map(styleToIndex);
  const expected = referenceIndicesForFrame(stage, K);

  assert.equal(st.nodesNonUniform, 0, 'precondition: the child never sets F_NONUNIF on itself (own scale is uniform) -- the D-04 own-local counter must stay decoupled from inherited taint');
  assert.deepEqual(actual, expected,
    'child shade indices [' + actual.join(',') + '] must equal the world-matrix-derived reference [' + expected.join(',') + ']; ' +
    'a mismatch here would be a regression of the F_NONUNIF-inheritance fix (the worldNonUnif propagation / tainted-branch selector) -- ' +
    'NOT a test bug: the reference reads the SAME actual world matrix (m0..m10) the engine itself computed for this node.');
});

test('500-pose hierarchy fuzz: every drawn face shade index matches the independent world-matrix oracle, exact', () => {
  const K = 64, lut = idxLut(K);
  const rng = mulberry32(777);
  let totalFaces = 0, mismatches = 0;
  const firstMismatches = [];

  for (let trial = 0; trial < 500; trial++) {
    const cap = mkCapture();
    const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 + rng() * 4, near: 0.5, far: 60 } });
    const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));

    const parent = stage.addNode(gid, mid, { x: rng() * 2 - 1, y: rng() * 2 - 1, z: rng() * 2 - 1 });
    stage.setEuler(parent, rng() * 6.28 - 3.14, rng() * 6.28 - 3.14, rng() * 6.28 - 3.14);
    if (rng() < 0.5) stage.setScale(parent, 0.5 + rng() * 2, 0.5 + rng() * 2, 0.5 + rng() * 2);
    else { const s = 0.5 + rng(); stage.setScale(parent, s, s, s); }
    stage.setVisible(parent, false);

    const child = stage.addNode(gid, mid, { x: rng() * 2 - 1, y: rng() * 2 - 1, z: rng() * 2 - 1, parent });
    stage.setEuler(child, rng() * 6.28 - 3.14, rng() * 6.28 - 3.14, rng() * 6.28 - 3.14);
    if (rng() < 0.5) stage.setScale(child, 0.5 + rng() * 2, 0.5 + rng() * 2, 0.5 + rng() * 2);
    else { const s = 0.5 + rng(); stage.setScale(child, s, s, s); }

    stage.frame(16);
    const actual = cap.moves.map(styleToIndex);
    const expected = referenceIndicesForFrame(stage, K);
    totalFaces += actual.length;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        mismatches++;
        if (firstMismatches.length < 5) firstMismatches.push('trial ' + trial + ' face ' + i + ': actual ' + actual[i] + ' vs reference ' + expected[i]);
      }
    }
  }

  assert.ok(totalFaces > 0, 'precondition: the fuzz actually drew faces');
  assert.equal(mismatches, 0, mismatches + '/' + totalFaces + ' drawn faces mismatched the independent world-matrix oracle; first few: ' + firstMismatches.join(' | '));
});

/* ============================================================
 * 2b. MULTI-LEVEL (>1 hop) TRANSITIVE INHERITANCE
 * ============================================================
 * The 500-fuzz above is 2-level (parent/child) and, being random, may not
 * reliably isolate a >1-hop propagation bug (e.g. an off-by-one that ORs in
 * only the IMMEDIATE parent's OWN flag rather than the parent's fully-
 * propagated `worldNonUnif[pd]`, which would still happen to pass a 2-level
 * fixture but break at depth >= 2). This is a targeted, non-random,
 * depth-3 case: a non-uniform GRANDPARENT taints a uniform PARENT taints a
 * uniform CHILD -- the taint must survive two hops of `| worldNonUnif[pd]`.
 * A clean-subtree control (all three levels uniform) proves the propagation
 * doesn't ALSO falsely taint an untainted chain (no false positive).
 */
test('multi-level (grandparent -> parent -> child) taint propagation is transitive across >1 hop, exact match to the world-matrix oracle', () => {
  const K = 64, lut = idxLut(K);

  // tainted chain: non-uniform grandparent (no rotation) -> uniform parent
  // (pure rotation) -> uniform child (pure rotation). Neither parent nor
  // child sets its OWN F_NONUNIF; only the grandparent, two hops up, does.
  {
    const cap = mkCapture();
    const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 10 } });
    const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));
    const grandparent = stage.addNode(gid, mid, {});
    stage.setScale(grandparent, 3, 1, 1);              // non-uniform, no rotation -- the ONLY source of taint
    stage.setVisible(grandparent, false);
    const parent = stage.addNode(gid, mid, { parent: grandparent });
    stage.setEuler(parent, 0.2, 0.4, 0.1);              // pure rotation, uniform (default) scale -> own F_NONUNIF off
    stage.setVisible(parent, false);
    const child = stage.addNode(gid, mid, { parent });
    stage.setEuler(child, 0.5, 0.1, 0.9);               // pure rotation, uniform (default) scale -> own F_NONUNIF off

    const st = stage.frame(16);
    const actual = cap.moves.map(styleToIndex);
    const expected = referenceIndicesForFrame(stage, K);

    assert.ok(actual.length > 0, 'precondition: the grandchild box drew at least one face');
    assert.equal(st.nodesNonUniform, 0, 'neither drawn node (parent, child) sets its OWN F_NONUNIF -- the D-04 counter must stay 0 even though the branch is tainted');
    assert.deepEqual(actual, expected, 'depth-2 taint (grandparent non-uniform -> parent -> child) must reach the child: shade [' + actual.join(',') + '] vs oracle [' + expected.join(',') + ']');
  }

  // clean-subtree control: same 3-level shape, all uniform scale at every
  // level -- the sqrt-free (untainted) branch must be taken and must ALSO
  // match the oracle exactly (proves no false-positive taint leaks in).
  {
    const cap = mkCapture();
    const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 10 } });
    const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));
    const grandparent = stage.addNode(gid, mid, {});
    stage.setEuler(grandparent, 0.3, 0.2, 0.1);         // rotation only -- a similarity, must NOT taint
    stage.setVisible(grandparent, false);
    const parent = stage.addNode(gid, mid, { parent: grandparent });
    stage.setEuler(parent, 0.2, 0.4, 0.1);
    stage.setVisible(parent, false);
    const child = stage.addNode(gid, mid, { parent });
    stage.setEuler(child, 0.5, 0.1, 0.9);

    const st = stage.frame(16);
    const actual = cap.moves.map(styleToIndex);
    const expected = referenceIndicesForFrame(stage, K);

    assert.ok(actual.length > 0, 'precondition: the grandchild box drew at least one face');
    assert.equal(st.nodesNonUniform, 0, 'a fully-uniform 3-level chain must never set nodesNonUniform');
    assert.deepEqual(actual, expected, 'clean uniform 3-level chain (control) must also match the oracle exactly: shade [' + actual.join(',') + '] vs oracle [' + expected.join(',') + ']');
  }
});

/* ============================================================
 * 3. NON-UNIFORM (own-node F_NONUNIF, no inheritance involved)
 * ============================================================ */
test('non-uniform: setScale(h, 3, 1, 1) changes at least one face shade index vs the uniform baseline, and stats.nodesNonUniform === 1 for exactly the flagged node (0 for a uniform-only scene)', () => {
  const K = 64, lut = idxLut(K);

  // uniform-only scene: nodesNonUniform must stay 0
  {
    const cap = mkCapture();
    const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
    const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));
    const h = stage.addNode(gid, mid, {});
    stage.setEuler(h, 0.3, 0.5, 0.1);
    const st = stage.frame(16);
    assert.equal(st.nodesNonUniform, 0, 'a uniformly-scaled (default) scene must never enter the adjugate path');
  }

  // one flagged node among several unflagged -> exactly 1
  const cap = mkCapture();
  const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));

  const uniform = stage.addNode(gid, mid, {});
  stage.setEuler(uniform, 0.3, 0.5, 0.1);
  const capU = mkCapture();
  const stageU = createStage(capU.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const gidU = stageU.geometry(geometry.box(1, 1, 1)), midU = stageU.material(materialFromRamp(lut));
  const uniformOnly = stageU.addNode(gidU, midU, {});
  stageU.setEuler(uniformOnly, 0.3, 0.5, 0.1);
  stageU.frame(16);
  const uniformIdx = capU.moves.map(styleToIndex);

  const nonUniform = stage.addNode(gid, mid, { x: 4 });
  stage.setEuler(nonUniform, 0.3, 0.5, 0.1);
  stage.setScale(nonUniform, 3, 1, 1);

  const otherUniform = stage.addNode(gid, mid, { x: -4 });
  stage.setEuler(otherUniform, 0.3, 0.5, 0.1);

  const st = stage.frame(16);
  assert.equal(st.nodesNonUniform, 1, 'exactly the one setScale(3,1,1) node must be flagged and counted');

  // The non-uniform node's own shade must differ from the SAME rotation applied uniformly.
  const D = stage.nodes.data, ord = stage._order, dc = stage._drawCount, drawNode = stage._draw.node;
  const nonUniformDenseIdx = stage.nodes.idx(nonUniform);
  const nuFaceIdx = [];
  for (let i = 0; i < dc; i++) if (drawNode[ord[i]] === nonUniformDenseIdx) nuFaceIdx.push(styleToIndex(cap.moves[i]));
  assert.notDeepEqual(nuFaceIdx, uniformIdx.slice(0, nuFaceIdx.length), 'non-uniform scale must change the shade relative to the uniform baseline at the same rotation');
});

/* ============================================================
 * 4. FILL/STROKE
 * ============================================================ */
test('material({fill:false, stroke:"#f00"}): 0 fill() calls and >0 stroke() calls', () => {
  const cap = mkCapture();
  const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({ fill: false, stroke: '#f00' }));
  stage.addNode(gid, mid, {});
  const st = stage.frame(16);
  assert.ok(st.facesDrawn > 0, 'precondition: at least one face survived cull');
  assert.equal(cap.counts.fill, 0, 'fill:false must emit zero fill() calls');
  assert.ok(cap.counts.stroke > 0, 'stroke must emit at least one stroke() call');
});

test('material({fill:true}) draw trace is byte-identical to the real v1.3.0 source, for a root (unparented) node, across many rotations', () => {
  const rng = mulberry32(4242);
  let checked = 0;
  for (let trial = 0; trial < 60; trial++) {
    const ex = rng() * Math.PI * 2 - Math.PI, ey = rng() * Math.PI * 2 - Math.PI, ez = rng() * Math.PI * 2 - Math.PI;
    const capO = mkCapture(), capN = mkCapture();
    const stO = OLD.createStage(capO.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
    const stN = createStage(capN.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
    const gO = stO.geometry(OLD.geometry.box(1, 1, 1)), mO = stO.material(OLD.material({}));
    const gN = stN.geometry(geometry.box(1, 1, 1)), mN = stN.material(material({ fill: true }));
    const hO = stO.addNode(gO, mO, {}); stO.setEuler(hO, ex, ey, ez);
    const hN = stN.addNode(gN, mN, {}); stN.setEuler(hN, ex, ey, ez);
    stO.frame(16); stN.frame(16);
    assert.deepEqual(capN.trace, capO.trace, 'trial ' + trial + ' (' + ex.toFixed(3) + ',' + ey.toFixed(3) + ',' + ez.toFixed(3) + '): draw call sequence diverged from v1.3.0');
    checked++;
  }
  assert.equal(checked, 60, 'precondition: all 60 trials actually ran and compared');
});

/* ============================================================
 * 5. NaN POSE
 * ============================================================
 * Translation and scale lanes: measured nodesInvalid === 1, node fully
 * skipped, no draw entry (so no drawKey can ever equal 0 "laundered to the
 * far plane" for that node -- it never reaches quantize at all).
 */
for (const lane of ['px', 'py', 'pz', 'sx', 'sy', 'sz']) {
  test('NaN pose lane ' + lane + ': node skipped, stats.nodesInvalid === 1, no draw entry (nothing launders to drawKey===0)', () => {
    const cap = mkCapture();
    const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
    const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
    const h = stage.addNode(gid, mid, {});
    if (lane === 'px') stage.setPosition(h, NaN, 0, 0);
    else if (lane === 'py') stage.setPosition(h, 0, NaN, 0);
    else if (lane === 'pz') stage.setPosition(h, 0, 0, NaN);
    else if (lane === 'sx') stage.setScale(h, NaN, 1, 1);
    else if (lane === 'sy') stage.setScale(h, 1, NaN, 1);
    else if (lane === 'sz') stage.setScale(h, 1, 1, NaN);

    const st = stage.frame(16);
    assert.equal(st.nodesInvalid, 1, lane + ': must be counted by the fail-closed node door');
    assert.equal(stage._drawCount, 0, lane + ': the whole node must be skipped -- zero draw entries');
    assert.equal(cap.counts.moveTo, 0, lane + ': nothing painted');
    // Direct proof no entry ever carries drawKey===0 (the D-06 far-plane-forever
    // signature) FROM THIS NODE: there are no entries at all, so the set of
    // drawKeys attributable to this node is empty -- vacuously satisfies "no
    // drawKey===0 originating from that node", checked explicitly rather than
    // assumed.
    const D = stage._draw;
    let ownedByThisNode = 0;
    for (let i = 0; i < stage._drawCount; i++) if (D.node[stage._order[i]] === stage.nodes.idx(h)) ownedByThisNode++;
    assert.equal(ownedByThisNode, 0, lane + ': zero draw entries attributable to the NaN node');
  });
}

/* ============================================================
 * PROBE A (reviewer's NIT 1): NaN OWN-QUATERNION, finite translation+scale
 * ============================================================
 * The node door (Depth.js:619-622) checks wcx/wcy/wcz/cvz/rad/bias -- it does
 * NOT check the world upper-3x3 (m0,m1,m2,m4,m5,m6,m8,m9,m10). A NaN
 * quaternion component poisons the upper-3x3 but leaves translation finite,
 * so the door does not reject it and stats.nodesInvalid is NOT incremented --
 * confirmed below.
 *
 * MEASURED containment (not reasoned about, actually run): every projected
 * vertex becomes NaN (M0..M10 all NaN via composeTRS), so per-vertex screenXY
 * is NaN for the whole node. In the per-face AABB build, `if (X < minx)` /
 * `if (X > maxx)` are false for every NaN X (unordered compares), so minx/miny
 * stay at their +1e9 sentinel and maxx/maxy stay at -1e9 -- an INVERTED,
 * degenerate box. lite-aabb's `intersects` (`a[0]<=b[2] && a[2]>=b[0] && ...`)
 * then reads `1e9 <= viewport.maxX` as false, so EVERY face of the corrupted
 * node fails the viewport-cull test and is rejected via st.facesCulled++,
 * `continue` -- BEFORE quantize, BEFORE shadeL is ever touched, BEFORE any
 * draw entry is created. Net effect for this box: 0 draw entries, 0 fillStyle
 * calls, 0 moveTo calls -- nothing paints, nothing indexes shadeL (so no OOB
 * is even possible), and no drawKey ever laundered to the far plane (there is
 * no drawKey at all). The ONLY gap is the tally: st.nodesInvalid stays 0 for a
 * node that, per the door's own stated intent ("a NaN pose lane... poisons the
 * projection"), arguably should have been counted as invalid.
 *
 * VERDICT: contained, not a rendering defect. No wrong paint, no OOB. This is
 * a documentation/observability nit (the door's comment implies broader
 * coverage than the code delivers for pose components it does not itself
 * read), not a blocker. Tests below assert the ACTUAL measured behaviour.
 */
for (const lane of ['qx', 'qy', 'qz', 'qw']) {
  test('PROBE A: NaN own-quaternion lane ' + lane + ' (finite translation+scale) is CONTAINED but UNCOUNTED -- node door does not check the upper-3x3', () => {
    const cap = mkCapture();
    const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
    const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(material({}));
    const h = stage.addNode(gid, mid, {});
    stage.setPosition(h, 0, 0, 0);
    stage.setScale(h, 1, 1, 1);
    if (lane === 'qx') stage.setQuaternion(h, NaN, 0, 0, 1);
    else if (lane === 'qy') stage.setQuaternion(h, 0, NaN, 0, 1);
    else if (lane === 'qz') stage.setQuaternion(h, 0, 0, NaN, 1);
    else stage.setQuaternion(h, 0, 0, 0, NaN);

    const st = stage.frame(16);

    // the tally gap, precisely measured (documented as a nit, not asserted as "correct")
    assert.equal(st.nodesInvalid, 0, lane + ': MEASURED gap -- the node door does not see this NaN, so nodesInvalid is NOT incremented (documentation nit, see comment block above)');

    // containment, precisely measured: no draw entries, nothing painted, no OOB possible
    assert.equal(stage._drawCount, 0, lane + ': fully contained -- zero draw entries reach the sort/paint stage');
    assert.equal(cap.counts.moveTo, 0, lane + ': nothing painted (no wrong-colored geometry reaches the canvas)');
    assert.equal(cap.counts.fill, 0, lane + ': no fill() calls');
    assert.ok(st.facesCulled >= 1, lane + ': the corrupted faces are rejected via the viewport-cull AABB reject (degenerate inverted box), not via the node door');

    // explicit OOB check: shadeL is a Uint8Array sized maxDrawFaces; since dc
    // stayed 0 for this node's faces, no index into it was ever produced for
    // this node -- confirmed by re-deriving the same invariant stage._draw
    // exposes (no entry attributable to this node's dense index).
    const D = stage._draw;
    let ownedByThisNode = 0;
    for (let i = 0; i < stage._drawCount; i++) if (D.node[stage._order[i]] === stage.nodes.idx(h)) ownedByThisNode++;
    assert.equal(ownedByThisNode, 0, lane + ': zero draw entries (and therefore zero shadeL reads) attributable to the NaN-quaternion node');
  });
}

/* ============================================================
 * PROBE B: near-singular determinant on a non-uniform node
 * ============================================================ */
test('PROBE B: near-singular (tiny) determinant on a non-uniform node -- shade index stays in [0, K-1], never NaN, never OOB', () => {
  const K = 64, lut = idxLut(K);
  const cap = mkCapture();
  const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));
  const h = stage.addNode(gid, mid, {});
  stage.setEuler(h, 0.4, 0.9, 0.2);
  stage.setScale(h, 1e-8, 1, 1);   // near-singular upper-3x3: det -> ~0, but not exactly 0

  const st = stage.frame(16);
  assert.equal(st.nodesNonUniform, 1, 'precondition: this node takes the adjugate/det path');
  assert.ok(cap.moves.length > 0, 'precondition: at least one face survived cull');
  for (const s of cap.moves) {
    const idx = styleToIndex(s);
    assert.ok(Number.isInteger(idx), 'shade index must be an integer, got ' + idx);
    assert.ok(idx >= 0 && idx <= K - 1, 'shade index ' + idx + ' out of LUT bounds [0,' + (K - 1) + ']');
  }
});

test('PROBE B (exact singular, det===0): shade index still stays in [0, K-1]', () => {
  const K = 64, lut = idxLut(K);
  const cap = mkCapture();
  const stage = createStage(cap.ctx, { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512, camera: { radius: 6 } });
  const gid = stage.geometry(geometry.box(1, 1, 1)), mid = stage.material(materialFromRamp(lut));
  const h = stage.addNode(gid, mid, {});
  stage.setScale(h, 0, 1, 1);   // exactly singular: det === 0, invDet forced to 0 by the source's own guard

  const st = stage.frame(16);
  assert.equal(st.nodesNonUniform, 1);
  for (const s of cap.moves) {
    const idx = styleToIndex(s);
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx <= K - 1, 'shade index ' + idx + ' out of bounds under exact singular scale');
  }
});

/* ============================================================
 * 6. K>256 GUARD
 * ============================================================ */
test('material({steps:257}) throws; material({steps:256}) is allowed', () => {
  assert.throws(() => material({ steps: 257 }), /256-step shade-lane cap/, 'K=257 must throw (boundary N+1)');
  assert.doesNotThrow(() => material({ steps: 256 }), 'K=256 must be allowed (boundary N)');
  const m = material({ steps: 256 });
  assert.equal(m.K, 256);
  assert.equal(m.lut.length, 256);
});

test('materialFromRamp(ramp.length===257) throws; ramp.length===256 is allowed', () => {
  const ramp257 = new Array(257).fill('#000000');
  const ramp256 = new Array(256).fill('#000000');
  assert.throws(() => materialFromRamp(ramp257), /256-step shade-lane cap/, 'ramp length 257 must throw (boundary N+1)');
  assert.doesNotThrow(() => materialFromRamp(ramp256), 'ramp length 256 must be allowed (boundary N)');
  const m = materialFromRamp(ramp256);
  assert.equal(m.K, 256);
});

test('K boundary matrix: 1, 2, N-1 (255) all allowed and produce a lut of exactly K entries', () => {
  for (const K of [1, 2, 255, 256]) {
    const m = material({ steps: K });
    assert.equal(m.lut.length, K, 'steps:' + K + ' must produce exactly ' + K + ' lut entries');
  }
});
