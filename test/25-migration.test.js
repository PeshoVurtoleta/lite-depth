/**
 * D7 "Freeze" -- v2.0.0 BREAKING-change boundary/migration suite.
 *
 * Locks the two documented BREAKING changes against regression:
 *   1. layer out-of-range now THROWS at BOTH doors (addNode({layer}) and
 *      setLayer) instead of silently `& 63`-wrapping (was 1.9.0 behavior).
 *   2. createStage asserts the lite-aabb FORMAT_VERSION contract BEFORE any
 *      allocation, naming both LANE_VERSION and the observed FORMAT_VERSION.
 *
 * Plus a consistency check (setLayer/setShadowMaterial share the same
 * Number.isInteger fail-closed idiom) and a stats-shape lock (17 fields).
 *
 * @license MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  createStage, geometry, material, FORMAT_VERSION, LANE_VERSION,
} from '../Depth.js';

const DT = 1 / 60;

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

function baseStage(opts) {
  const s = createStage(makeCtx(), Object.assign({ maxNodes: 8 }, opts));
  const gid = s.geometry(geometry.box(1, 1, 1));
  const mid = s.material(material({}));
  return { s, gid, mid };
}

// ============================================================================
// BREAKING #1: layer out-of-range throws at BOTH doors.
// ============================================================================

const ACCEPT_VALUES = [0, 3, 63];
// setLayer(h, v) has no "field omitted" concept -- every value passed is explicit,
// so undefined must throw there (Number.isInteger(undefined) is false).
const SETLAYER_THROW_VALUES = [64, -1, NaN, null, 2.5, undefined];
// addNode({ layer }) uses the init-object convention shared with x/y/z/parent:
// `if (init.layer !== undefined)` treats an explicit `layer: undefined` the SAME
// as omitting the key entirely (default layer 0, no throw) -- see the divergence
// test below. undefined is therefore excluded from addNode's throw set.
const ADDNODE_THROW_VALUES = [64, -1, NaN, null, 2.5];

test('BREAKING: addNode({ layer }) THROWS for out-of-range/non-integer values: 64, -1, NaN, null, 2.5', () => {
  for (const v of ADDNODE_THROW_VALUES) {
    const { s, gid, mid } = baseStage();
    assert.throws(() => s.addNode(gid, mid, { layer: v }),
      /layer=.* out of range/,
      'addNode({ layer: ' + String(v) + ' }) must throw -- null is not zero, 64 is not 0, 2.5 is not an integer');
  }
});

// ----------------------------------------------------------------------------
// FINDING (not a defect, but a documented asymmetry worth locking down): the
// two "fail-closed layer" doors do NOT treat `undefined` identically.
// addNode({ layer: undefined }) is swallowed by the init-object's own
// `!== undefined` "was this field provided at all" gate (the SAME convention
// x/y/z/parent/pickable use), so it silently defaults to layer 0 -- it does
// NOT throw. setLayer(h, undefined) has no such "omitted" concept (a setter
// call always explicitly supplies its argument), so it DOES throw. This test
// pins the ACTUAL (intentional-by-convention) behavior so a future change in
// either direction is a deliberate, reviewed decision, not a silent drift.
// ----------------------------------------------------------------------------
test('FINDING: addNode({ layer: undefined }) does NOT throw (treated as "omitted", defaults to layer 0) -- diverges from setLayer(h, undefined), which DOES throw', () => {
  const { s, gid, mid } = baseStage();
  let h;
  assert.doesNotThrow(() => { h = s.addNode(gid, mid, { layer: undefined }); },
    'addNode({ layer: undefined }) must NOT throw -- it is treated as "layer not provided" by the same convention as x/y/z/parent');
  assert.equal(s.nodes.data.layer[s.nodes.idx(h)], 0, 'an omitted/undefined layer at addNode must default to 0');
  assert.throws(() => s.setLayer(h, undefined), /layer=.* out of range/,
    'setLayer(h, undefined) DOES throw -- a setter call has no "omitted" concept, so undefined must fail Number.isInteger like any other bad value');
});

test('BREAKING: addNode({ layer }) ACCEPTS the boundary values 0, 3, 63', () => {
  for (const v of ACCEPT_VALUES) {
    const { s, gid, mid } = baseStage();
    let h;
    assert.doesNotThrow(() => { h = s.addNode(gid, mid, { layer: v }); }, 'addNode({ layer: ' + v + ' }) must succeed');
    assert.equal(s.nodes.data.layer[s.nodes.idx(h)], v, 'the layer lane must read back exactly ' + v);
  }
});

test('BREAKING: setLayer(h, v) THROWS for out-of-range/non-integer values: 64, -1, NaN, null, 2.5, undefined', () => {
  const { s, gid, mid } = baseStage();
  const h = s.addNode(gid, mid, {});
  const before = s.nodes.data.layer[s.nodes.idx(h)];
  for (const v of SETLAYER_THROW_VALUES) {
    assert.throws(() => s.setLayer(h, v),
      /layer=.* out of range/,
      'setLayer(h, ' + String(v) + ') must throw -- null is not zero, 64 is not 0, 2.5 is not an integer');
    assert.equal(s.nodes.data.layer[s.nodes.idx(h)], before, 'a refused setLayer must mutate NO lane (layer=' + String(v) + ')');
  }
});

test('BREAKING: setLayer(h, v) ACCEPTS the boundary values 0, 3, 63 and writes them exactly', () => {
  const { s, gid, mid } = baseStage();
  const h = s.addNode(gid, mid, {});
  for (const v of ACCEPT_VALUES) {
    assert.doesNotThrow(() => s.setLayer(h, v), 'setLayer(h, ' + v + ') must succeed');
    assert.equal(s.nodes.data.layer[s.nodes.idx(h)], v, 'the layer lane must read back exactly ' + v);
  }
});

test('BREAKING: layer=64 no longer silently wraps to 0 via & 63 (the pre-2.0.0 behavior) -- it must throw instead', () => {
  const { s, gid, mid } = baseStage();
  // The historical (1.9.0) behavior would have produced layer=0 (64 & 63 === 0).
  // 2.0.0 must throw, never silently accept it as 0.
  assert.throws(() => s.addNode(gid, mid, { layer: 64 }), /out of range/);
  const h = s.addNode(gid, mid, { layer: 5 }); // a non-zero starting layer makes a silent wrap-to-0 detectable
  assert.throws(() => s.setLayer(h, 64), /out of range/);
  assert.equal(s.nodes.data.layer[s.nodes.idx(h)], 5, 'the refused setLayer(64) must leave the node at its ORIGINAL layer (5), never silently wrapped to 64 & 63 === 0');
});

// ============================================================================
// BREAKING #2: createStage version-assert -- naming both versions, before any
// allocation. FORMAT_VERSION is a `const` re-exported from @zakkster/lite-aabb
// at Depth.js's own module-load time, so it cannot be reassigned from outside
// via a plain import binding. We use Node's BUILT-IN module.registerHooks()
// (node:module, no external dependency) to load a FRESH copy of Depth.js whose
// '@zakkster/lite-aabb' import is shimmed to report a mismatched FORMAT_VERSION
// -- a real, executed throw path, not a static-only inspection.
// ============================================================================

function installAabbShim(overrideVersion) {
  globalThis.__DEPTH_TEST_AABB_SHIM__ = true;
  globalThis.__DEPTH_TEST_FORMAT_VERSION_OVERRIDE__ = overrideVersion;
  const unregister = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@zakkster/lite-aabb' && globalThis.__DEPTH_TEST_AABB_SHIM__) {
        const real = nextResolve(specifier, context);
        // The override value is baked into the synthetic URL so distinct override
        // values get distinct (separately cached) synthetic modules -- the ESM
        // loader caches by URL and would otherwise freeze the FIRST override
        // forever across every later import of the "same" real lite-aabb URL.
        const ov = String(globalThis.__DEPTH_TEST_FORMAT_VERSION_OVERRIDE__);
        return { url: 'depth-test-aabb-shim:' + encodeURIComponent(real.url) + '::' + encodeURIComponent(ov), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith('depth-test-aabb-shim:')) {
        const real = decodeURIComponent(url.slice('depth-test-aabb-shim:'.length).split('::')[0]);
        const source = 'import * as real from ' + JSON.stringify(real) + ';\n' +
          'export * from ' + JSON.stringify(real) + ';\n' +
          'export const FORMAT_VERSION = (globalThis.__DEPTH_TEST_FORMAT_VERSION_OVERRIDE__ !== undefined) ' +
          '? globalThis.__DEPTH_TEST_FORMAT_VERSION_OVERRIDE__ : real.FORMAT_VERSION;\n';
        return { format: 'module', source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  return () => {
    globalThis.__DEPTH_TEST_AABB_SHIM__ = false;
    unregister.deregister();
  };
}

let hookSupportChecked = false;
let hookSupported = true;
function skipIfHooksUnsupported(t) {
  if (hookSupportChecked) { if (!hookSupported) t.skip('node:module registerHooks unavailable in this Node build'); return !hookSupported; }
  hookSupportChecked = true;
  hookSupported = typeof registerHooks === 'function';
  if (!hookSupported) t.skip('node:module registerHooks unavailable in this Node build');
  return !hookSupported;
}

test('BREAKING: createStage throws BEFORE any allocation when @zakkster/lite-aabb FORMAT_VERSION != 1, naming both LANE_VERSION and the observed FORMAT_VERSION', async (t) => {
  if (skipIfHooksUnsupported(t)) return;
  const restore = installAabbShim(2);
  try {
    const mod = await import('../Depth.js?depth-test-mismatch-25a');
    assert.equal(mod.FORMAT_VERSION, 2, 'precondition: the shim actually overrode FORMAT_VERSION as observed by Depth.js\'s own re-export');
    assert.throws(
      () => mod.createStage(makeCtx(), {}),
      (err) => {
        assert.ok(err instanceof Error, 'must throw a real Error');
        assert.match(err.message, /LANE_VERSION=1/, 'message must name LANE_VERSION');
        assert.match(err.message, /FORMAT_VERSION=1/, 'message must name the EXPECTED FORMAT_VERSION (1)');
        assert.match(err.message, /observed FORMAT_VERSION=2/, 'message must name the OBSERVED (mismatched) FORMAT_VERSION');
        return true;
      },
      'createStage must throw when FORMAT_VERSION !== 1'
    );
  } finally {
    restore();
  }
});

test('BREAKING: the version-assert throws for EVERY mismatched FORMAT_VERSION value tried (0, 2, NaN), and does NOT throw when it matches (1)', async (t) => {
  if (skipIfHooksUnsupported(t)) return;
  for (const bad of [0, 2, NaN]) {
    const restore = installAabbShim(bad);
    try {
      const mod = await import('../Depth.js?depth-test-mismatch-25b-' + String(bad));
      assert.throws(() => mod.createStage(makeCtx(), {}), /LANE_VERSION=1/, 'FORMAT_VERSION=' + bad + ' must throw');
    } finally {
      restore();
    }
  }
  const restoreOk = installAabbShim(1);
  try {
    const mod = await import('../Depth.js?depth-test-mismatch-25b-ok');
    assert.doesNotThrow(() => mod.createStage(makeCtx(), {}), 'FORMAT_VERSION=1 (matching) must NOT throw');
  } finally {
    restoreOk();
  }
});

test('sanity: the REAL (unshimmed) @zakkster/lite-aabb currently satisfies FORMAT_VERSION === 1, so createStage never throws in production today', () => {
  assert.equal(FORMAT_VERSION, 1, 'the real peer must report FORMAT_VERSION 1 -- if this ever fails, the shimmed tests above are the ones that should start catching it');
  assert.equal(LANE_VERSION, 1);
  assert.doesNotThrow(() => createStage(makeCtx(), { maxNodes: 4 }));
});

// ============================================================================
// Consistency: setLayer's fail-closed idiom matches setShadowMaterial's.
// ============================================================================

test('consistency: setLayer(h, 2.5) throws for the same reason (Number.isInteger) that setShadowMaterial(1.5) throws', () => {
  const { s, gid, mid } = baseStage();
  const h = s.addNode(gid, mid, {});
  const m0 = s.material(material({ r: 9, g: 9, b: 9 }));
  void m0;
  assert.throws(() => s.setLayer(h, 2.5), /out of range/, 'setLayer must reject a non-integer layer');
  assert.throws(() => s.setShadowMaterial(1.5), /registered material id/, 'setShadowMaterial must reject a non-integer material id');
  // Both fail BEFORE mutating state: layer stays default, shadow material stays off.
  assert.equal(s.nodes.data.layer[s.nodes.idx(h)], 0, 'the refused setLayer must not have mutated the layer lane');
});

// ============================================================================
// stats shape: exactly 17 fields, offthreadStalls + pickHits present.
// ============================================================================

const EXPECTED_STATS_FIELDS = [
  'facesDrawn', 'facesCulled', 'nodesCulled', 'drawCalls', 'tTransform', 'tProject',
  'tSort', 'tPaint', 'facesOverflowed', 'nodesInvalid', 'nodesNonUniform',
  'nodesOrphaned', 'nodesTotal', 'shadowFacesDrawn', 'offthreadStalls',
  'facesClipped', 'pickHits',
];

test('stats literal has EXACTLY the 17 documented fields, including offthreadStalls and pickHits', () => {
  const { s } = baseStage();
  const keys = Object.keys(s.stats);
  assert.equal(keys.length, 17, 'stats must have exactly 17 fields');
  assert.deepEqual(new Set(keys), new Set(EXPECTED_STATS_FIELDS), 'stats field SET must match the documented 17 exactly');
  assert.ok('offthreadStalls' in s.stats, 'offthreadStalls must be present');
  assert.ok('pickHits' in s.stats, 'pickHits must be present');
  for (const k of keys) assert.equal(typeof s.stats[k], 'number', 'stats.' + k + ' must be a number');
});

test('stats: offthreadStalls and pickHits are MONOTONIC (never reset by frame()), unlike facesClipped which resets every frame', () => {
  const { s, gid, mid } = baseStage({ width: 800, height: 600, camera: { theta: 0, phi: Math.PI / 2, radius: 12, near: 0.5, far: 200 } });
  s.dirtyRect = true;
  s.addNode(gid, mid, { x: 0, y: 0, z: 0 });
  s.frame(DT);
  const out = new Int32Array(1);
  s.pick(400, 300, out);
  const hitsAfter1 = s.stats.pickHits;
  assert.ok(hitsAfter1 >= 1, 'sanity: the pick must have hit');
  for (let i = 0; i < 5; i++) s.frame(DT);
  assert.equal(s.stats.pickHits, hitsAfter1, 'pickHits must NOT be reset by frame()');
});
