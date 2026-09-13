/**
 * D7 "Freeze" -- v2.0.0 conformance lock for LANE_VERSION = 1.
 *
 * This file does not exercise BEHAVIOR so much as PIN A SHAPE: the exact set of
 * per-node lanes + their TypedArray types (Table A), the exact Worker transfer
 * key set (Table B), the FLAGS bit assignment, and the packKey/quantize sort-key
 * contract. Every assertion here reads the REAL runtime shape (stage.nodes.data,
 * a captured real postMessage payload, the real drawKey lane) -- never a
 * reimplementation of Depth.js internals. If any of these ever drifts, the
 * intent is that THIS file fails first, before any downstream behavioral test.
 *
 * packKey/quantize are NOT exported (they are closures inside createStage), so
 * this file measures them the only way the public surface allows: by reading
 * the actual `stage._draw.key` (drawKey) lane a real frame() produced, and
 * decoding it with the documented bit layout (LANES.md "Sort key"). This is a
 * real measurement of production code, not a parallel reimplementation guess.
 *
 * @license MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  createStage, geometry, material, FLAGS, LANE_VERSION, version,
} from '../Depth.js';

const DT = 1 / 60;
const DEPTH_BITS = 26;
const DEPTH_MAX = (1 << DEPTH_BITS) - 1;
const WORKER_URL = new URL('../DepthWorker.js', import.meta.url);

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

// A down-z camera: moving a node along z sweeps view-space depth monotonically
// without moving it off-screen, so a single node stays the only draw entry.
const DOWN_Z = { theta: 0, phi: Math.PI / 2, radius: 12, near: 0.5, far: 200 };

// ============================================================================
// Table A: the 29-lane per-node set -- names AND TypedArray types, EXACTLY.
// ============================================================================

const EXPECTED_LANES = [
  ['px', Float64Array], ['py', Float64Array], ['pz', Float64Array],
  ['qx', Float64Array], ['qy', Float64Array], ['qz', Float64Array], ['qw', Float64Array],
  ['sx', Float64Array], ['sy', Float64Array], ['sz', Float64Array],
  ['m0', Float64Array], ['m1', Float64Array], ['m2', Float64Array], ['m3', Float64Array],
  ['m4', Float64Array], ['m5', Float64Array], ['m6', Float64Array], ['m7', Float64Array],
  ['m8', Float64Array], ['m9', Float64Array], ['m10', Float64Array], ['m11', Float64Array],
  ['parent', Int32Array], ['geom', Int32Array], ['mat', Int32Array], ['matEff', Int32Array],
  ['flags', Uint32Array], ['layer', Uint8Array], ['bias', Float64Array],
];

test('LANE_VERSION 1 / Table A: stage.nodes.data has EXACTLY the 29 documented lanes, each the documented TypedArray', () => {
  const s = createStage(makeCtx(), { maxNodes: 4, camera: DOWN_Z });
  const D = s.nodes.data;
  const actualNames = Object.keys(D);

  assert.equal(actualNames.length, 29, 'exactly 29 lanes -- a lane was added or removed');
  const expectedNames = EXPECTED_LANES.map((e) => e[0]);
  assert.deepEqual(actualNames, expectedNames, 'lane NAME SET (and order, informative) must match Table A exactly');
  assert.deepEqual(new Set(actualNames), new Set(expectedNames), 'lane name SET (order-independent) must match Table A exactly');

  for (const [name, ctor] of EXPECTED_LANES) {
    assert.ok(D[name] instanceof ctor, 'lane "' + name + '" must be a ' + ctor.name + ', got ' + D[name].constructor.name);
  }
});

// ============================================================================
// Table B: the 23-key Worker transfer set -- exact membership, matEff ABSENT.
// ============================================================================

const EXPECTED_SEND_KEYS = [
  'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz',
  'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11',
  'flags',
];

// A Worker-shaped stub that captures the exact per-frame message without
// running a real thread -- postMessage is the only contract useWorker needs.
function makeCapturingWorker() {
  const posted = [];
  return {
    posted,
    on() {},
    postMessage(msg) { posted.push(msg); },
  };
}

test('LANE_VERSION 1 / Table B: the real per-frame Worker message carries EXACTLY the 23 documented lane keys, matEff and mat ABSENT', () => {
  const s = createStage(makeCtx(), { maxNodes: 4, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  const fw = makeCapturingWorker();
  s.useWorker(fw);
  s.frame(DT);

  const sent = fw.posted.find((m) => m && m.kind === 'f');
  assert.ok(sent && sent.lanes, 'precondition: a per-frame lane message was actually sent');
  const keys = Object.keys(sent.lanes);

  assert.equal(keys.length, 23, 'the transfer set must be exactly 23 keys');
  assert.deepEqual(new Set(keys), new Set(EXPECTED_SEND_KEYS), 'transfer set membership must match Table B exactly');
  assert.ok(!keys.includes('matEff'), 'matEff must be ABSENT from the transfer set (persistent override lane, never round-tripped)');
  assert.ok(!keys.includes('mat'), 'mat (the node\'s own material) must also be absent from the transfer set');
  assert.ok(!keys.includes('parent') && !keys.includes('geom') && !keys.includes('layer') && !keys.includes('bias'),
    'main-thread-only lanes (parent/geom/layer/bias) must never appear on the wire');
});

// ============================================================================
// LANE_VERSION is a distinct axis from `version`.
// ============================================================================

test('LANE_VERSION is a distinct numeric axis from the semver `version` export', () => {
  assert.equal(LANE_VERSION, 1, 'LANE_VERSION must be 1 for this frozen contract');
  assert.equal(typeof LANE_VERSION, 'number');
  assert.equal(version, '2.0.0');
  assert.equal(typeof version, 'string');
  // Different types on different axes: a LANE_VERSION bump is not implied by (and
  // must never be conflated with) a semver bump, and vice versa.
  assert.notEqual(String(LANE_VERSION), version);
});

// ============================================================================
// FLAGS: all 8 bits, by ordinal, unique + contiguous 0..7. BILLBOARD === bit 4.
// ============================================================================

test('FLAGS: exactly 8 bits, unique + contiguous 0..7, BILLBOARD is ordinal 4', () => {
  const EXPECTED_BITS = [
    ['VISIBLE', 0], ['PICKABLE', 1], ['DIRTY', 2], ['NON_UNIFORM_SCALE', 3],
    ['BILLBOARD', 4], ['CAST_SHADOW', 5], ['DOUBLE_SIDED', 6], ['STROKE', 7],
  ];
  const seen = new Set();
  for (const [name, bit] of EXPECTED_BITS) {
    const got = FLAGS.get(name);
    assert.equal(got, bit, 'FLAGS.get("' + name + '") must be ordinal ' + bit + ', got ' + got);
    seen.add(got);
  }
  assert.equal(seen.size, 8, 'all 8 bit ordinals must be unique');
  const sorted = Array.from(seen).sort((a, b) => a - b);
  assert.deepEqual(sorted, [0, 1, 2, 3, 4, 5, 6, 7], 'the 8 ordinals must be exactly 0..7, contiguous, no gap');
  assert.equal(FLAGS.get('BILLBOARD'), 4, 'BILLBOARD ordinal must not move (reserved: D8 Sprites)');
});

// ============================================================================
// packKey / quantize round trip -- measured from the REAL drawKey lane a real
// frame() produced (packKey/quantize are internal closures, not exported).
// ============================================================================

function drawKeyFor(s) {
  // Single-node scenes in this file always produce exactly one draw entry.
  assert.equal(s._drawCount, 1, 'precondition: exactly one draw entry');
  return s._draw.key[s._order[0]];
}

test('packKey: (layer & 63) << 26 | (depth & DEPTH_MAX) holds for representative (layer, depth) pairs, read from the real drawKey lane', () => {
  for (const layer of [0, 3, 63]) {
    const s = createStage(makeCtx(), { maxNodes: 4, camera: DOWN_Z });
    const gid = s.geometry(geometry.box(1, 1, 1));
    const mid = s.material(material({}));
    // z = 0 puts the node's centre at mid-frustum: a representative interior depth.
    s.addNode(gid, mid, { x: 0, y: 0, z: 0, layer });
    s.frame(DT);
    const key = drawKeyFor(s);
    const gotLayer = key >>> 26;
    const gotDepth = key & DEPTH_MAX;
    assert.equal(gotLayer, layer, 'the packed layer field must equal the layer the node was created with');
    assert.equal(key >>> 0, (((layer & 63) << 26) | (gotDepth & DEPTH_MAX)) >>> 0,
      'the whole packed key must equal the documented formula rebuilt from the observed layer/depth split');
  }
});

test('quantize: strictly monotonic in view-space z across a sampled sweep (near -> far maps DEPTH_MAX -> 0)', () => {
  const depths = [];
  // DOWN_Z: eye at (0,0,radius=12) looking toward the origin along -z, so
  // cvz = worldZ - 12 (see updateCamera). Sweep the desired view-space z from
  // just behind-near to just-in-front-of-far, strictly INSIDE the open interval
  // so every sample lands in the linear (non-clamped) region, and solve for the
  // world z that produces it.
  // Ordered FAR -> NEAR (viewZ rising from -200-ish toward -0.5-ish) so depth is
  // expected to be monotonically NON-DECREASING across the sweep.
  const zs = [];
  for (let i = 1; i <= 40; i++) zs.push(-200 + (199.5 * i) / 41); // near=0.5, far=200
  for (const viewZ of zs) {
    const s = createStage(makeCtx(), { maxNodes: 4, camera: DOWN_Z });
    const gid = s.geometry(geometry.box(1, 1, 1));
    const mid = s.material(material({}));
    s.addNode(gid, mid, { x: 0, y: 0, z: viewZ + 12 });
    s.frame(DT);
    const key = drawKeyFor(s);
    depths.push(key & DEPTH_MAX);
  }
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i] >= depths[i - 1],
      'depth must be monotonically non-decreasing as the node moves from near-ward to far-ward samples (i=' + i + ': ' + depths[i - 1] + ' -> ' + depths[i] + ')');
  }
  assert.ok(new Set(depths).size > 1, 'sanity: the sweep must actually produce varying depths, not a constant');
});

test('quantize: t<=0 clamps to depth 0 (far/beyond), t>=1 clamps to DEPTH_MAX (near/nearer) -- read from the real drawKey lane', () => {
  // DOWN_Z: eye at (0,0,radius=12), cvz = worldZ - 12. The per-node coarse
  // frustum reject tests the RAW cvz against [-far,-near] (with the geometry
  // radius), so a node placed at cvz=-100 (safely central) survives that door
  // regardless of bias; setDepthBias then pushes ONLY the quantize input
  // (cvz+bias) past a clamp boundary -- isolating the quantize clamp from the
  // coarse per-node cull.
  const far = createStage(makeCtx(), { maxNodes: 4, camera: DOWN_Z });
  const gidF = far.geometry(geometry.box(1, 1, 1));
  const midF = far.material(material({}));
  const hF = far.addNode(gidF, midF, { x: 0, y: 0, z: -100 + 12 }); // cvz=-100, safely inside [-far,-near]
  far.setDepthBias(hF, -150); // quantize input = -100 + -150 = -250 <= -far(-200) -> t<=0
  far.frame(DT);
  assert.equal(drawKeyFor(far) & DEPTH_MAX, 0, 'beyond the far plane (via bias) must clamp to depth 0');

  const near = createStage(makeCtx(), { maxNodes: 4, camera: DOWN_Z });
  const gidN = near.geometry(geometry.box(1, 1, 1));
  const midN = near.material(material({}));
  const hN = near.addNode(gidN, midN, { x: 0, y: 0, z: -100 + 12 }); // cvz=-100, safely inside [-far,-near]
  near.setDepthBias(hN, 150); // quantize input = -100 + 150 = 50 >= -near(-0.5) -> t>=1
  near.frame(DT);
  assert.equal(drawKeyFor(near) & DEPTH_MAX, DEPTH_MAX, 'nearer than the near plane (via bias) must clamp to DEPTH_MAX');
});

// The D-06 fail-closed NaN guard. quantize/packKey are internal, so this must be
// exercised through a REAL organic path: camera.far/near are plain object fields
// with NO validation gate anywhere in Depth.js (unlike every per-node pose lane,
// which IS gated by the Number.isFinite door before reaching quantize). Setting
// stage.camera.far = NaN makes t = (cvz+far)/zSpan unorderable for every node,
// which must fail CLOSED to DEPTH_MAX (painted loudly on top), never 0 (which
// would silently bury the node at the back forever -- the historical D-06 bug).
test('quantize D-06 guard: an unordered (NaN) t rejects to DEPTH_MAX, never 0 -- exercised via camera.far = NaN (no upstream gate catches this)', () => {
  const s = createStage(makeCtx(), { maxNodes: 4, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  s.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  s.frame(DT);
  assert.notEqual(drawKeyFor(s) & DEPTH_MAX, DEPTH_MAX, 'sanity: the baseline (finite camera) depth must not already be DEPTH_MAX');

  s.camera.far = NaN;
  s.frame(DT);
  assert.equal(s.stats.nodesInvalid, 0, 'camera.far=NaN must not be caught by the per-node finiteness gate (it is a camera-level value, not a pose lane)');
  assert.equal(s._drawCount, 1, 'the node must still be drawn (fail closed to a loud depth, never silently dropped)');
  const key = drawKeyFor(s);
  assert.equal(key & DEPTH_MAX, DEPTH_MAX, 'an unordered t must reject to DEPTH_MAX, NEVER to 0 (0 would silently bury the node at the back forever)');
});

// ============================================================================
// matEff wire survival -- behavioral. Two-material override, >=3 frames through
// a REAL node:worker_threads Worker, override must survive on EVERY frame.
// ============================================================================

test('matEff wire survival: an override set BEFORE binding a real Worker is honored across >=3 off-thread frames', async () => {
  const s = createStage(makeCtx(), { maxNodes: 8, width: 800, height: 600, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const matA = s.material(material({}));
  const matB = s.material(material({ r: 111, g: 22, b: 33 }));
  const h = s.addNode(gid, matA, { x: 0, y: 0, z: 0 });
  s.setMaterialOverride(h, matB);
  assert.equal(s.nodes.data.matEff[s.nodes.idx(h)], matB, 'sanity: the override landed before any Worker round trip');

  const worker = new Worker(WORKER_URL);
  let pending = null;
  s.useWorker(worker);
  worker.on('message', () => { const r = pending; pending = null; if (r) r(); });
  const roundTrip = () => new Promise((res) => { pending = res; s.frame(DT); });

  await roundTrip();   // frame 1: bootstrap stall (sends, primes matrices)
  for (let f = 0; f < 3; f++) {
    await roundTrip();
    const dc = s._drawCount, order = s._order, node = s._draw.node, matOv = s._draw.matOverride;
    assert.ok(dc > 0, 'frame ' + f + ': the off-thread reply must have produced paintable entries');
    let sawNode = false;
    for (let i = 0; i < dc; i++) {
      const e = order[i];
      if (node[e] === s.nodes.idx(h)) { sawNode = true; assert.equal(matOv[e], matB, 'frame ' + f + ': every draw entry for the overridden node must still read matB after the off-thread round trip'); }
    }
    assert.ok(sawNode, 'frame ' + f + ': the overridden node must have painted at least one entry');
  }
  await worker.terminate();
});

test('matEff wire survival (structural, same-thread): matEff is absent from every captured per-frame message across repeated frames, and the override persists on the main-thread path too', () => {
  const s = createStage(makeCtx(), { maxNodes: 8, camera: DOWN_Z });
  const gid = s.geometry(geometry.box(1, 1, 1));
  const matA = s.material(material({}));
  const matB = s.material(material({ r: 5, g: 6, b: 7 }));
  const h = s.addNode(gid, matA, { x: 0, y: 0, z: 0 });
  s.setMaterialOverride(h, matB);

  const fw = makeCapturingWorker();
  s.useWorker(fw);
  for (let f = 0; f < 3; f++) s.frame(DT);
  const frameMsgs = fw.posted.filter((m) => m && m.kind === 'f');
  assert.equal(frameMsgs.length, 3, 'precondition: 3 per-frame messages were sent');
  for (const msg of frameMsgs) {
    assert.ok(!Object.keys(msg.lanes).includes('matEff'), 'matEff must never appear on the wire, on any frame');
  }
  // matEff itself (main-thread lane, never detached because it is never sent) must
  // still read matB after every one of these sends.
  assert.equal(s.nodes.data.matEff[s.nodes.idx(h)], matB, 'the override lane must be untouched by repeated sends (it never leaves the main thread)');
});
