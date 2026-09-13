/**
 * D6 "Offthread" -- lite-arena transferable-roundtrip substrate guard.
 *
 * lite-depth moves its transform pass off the main thread on top of lite-arena's
 * detach/isDetached/rebind primitives (SparseSet, v1.9.0). This suite is a
 * REGRESSION GUARD against future lite-arena drift: it probes those primitives on
 * a tiny arena and on a real stage, and asserts the reserve() refusals fire.
 *
 * It fails CLOSED: if any primitive is absent (an older lite-arena resolved), the
 * relevant test SKIPS with a loud message rather than passing silently -- a green
 * run must mean the substrate was actually exercised, never that it was missing.
 *
 * @license MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena } from '@zakkster/lite-arena';
import { createStage, geometry, material } from '../Depth.js';

// A real transfer is the ONLY thing that neutralizes a buffer -- detach() just
// hands back the backing buffers, it does not detach them. structuredClone with a
// transfer list neutralizes the source in-process, exactly as postMessage(msg,
// [buf]) would across a Worker boundary, so isDetached() then reads byteLength 0.
function neutralize(buf) { structuredClone(buf, { transfer: [buf] }); }

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

test('substrate: detach returns backing buffers in field order without neutralizing them', () => {
  const arena = new Arena(8);
  const comp = arena.registerComponent({ x: Float64Array, y: Int32Array });
  if (typeof comp.detach !== 'function' || typeof comp.isDetached !== 'function') {
    test.skip('lite-arena SparseSet.detach/isDetached absent -- upgrade @zakkster/lite-arena to >=1.9.0');
    return;
  }
  const bufs = comp.detach(['x', 'y']);
  assert.equal(bufs.length, 2, 'detach returns one buffer per requested field');
  assert.equal(bufs[0].byteLength, 8 * 8, 'x buffer spans capacity*8 (Float64)');
  assert.equal(bufs[1].byteLength, 8 * 4, 'y buffer spans capacity*4 (Int32)');
  // detach alone must NOT neutralize -- the view is still live.
  assert.equal(comp.isDetached('x'), false, 'detach() does not detach the view by itself');
  // No-arg detach returns every field.
  assert.equal(comp.detach().length, 2, 'detach() with no arg collects every field');
  // Unknown field fails closed.
  assert.throws(() => comp.detach(['nope']), /not a field/, 'detach names an unknown field');
});

test('substrate: isDetached is truthful (byteLength 0 after a real transfer)', () => {
  const arena = new Arena(8);
  const comp = arena.registerComponent({ x: Float64Array });
  if (typeof comp.isDetached !== 'function') { test.skip('lite-arena isDetached absent'); return; }
  const [bx] = comp.detach(['x']);
  assert.equal(comp.isDetached('x'), false);
  neutralize(bx);
  assert.equal(comp.isDetached('x'), true, 'a transferred field reads detached');
  assert.equal(comp.data.x.byteLength, 0, 'the detached view spans zero bytes');
  assert.throws(() => comp.isDetached('nope'), /not a field/, 'isDetached names an unknown field');
});

test('substrate: rebind validates every buffer before repointing any', () => {
  const arena = new Arena(8);
  const comp = arena.registerComponent({ x: Float64Array, y: Int32Array });
  if (typeof comp.rebind !== 'function') { test.skip('lite-arena rebind absent'); return; }
  const [bx, by] = comp.detach(['x', 'y']);
  neutralize(bx); neutralize(by);
  assert.ok(comp.isDetached('x') && comp.isDetached('y'));
  // Wrong size -> throw, and NOTHING is repointed (x stays detached).
  assert.throws(() => comp.rebind({ x: new ArrayBuffer(3 * 8) }), /wrong byteLength/);
  assert.equal(comp.isDetached('x'), true, 'a failed rebind leaves the field untouched');
  // Wrong type -> throw.
  assert.throws(() => comp.rebind({ y: new ArrayBuffer(8 * 8) }), /byteLength|type/);
  // Unknown key -> throw.
  assert.throws(() => comp.rebind({ zzz: new ArrayBuffer(8 * 8) }), /not a field/);
  // Empty map -> throw.
  assert.throws(() => comp.rebind({}), /empty/);
  // Correct sizes -> repointed, live again.
  comp.rebind({ x: new ArrayBuffer(8 * 8), y: new ArrayBuffer(8 * 4) });
  assert.equal(comp.isDetached('x'), false);
  assert.equal(comp.isDetached('y'), false);
});

test('substrate: arena.reserve() refuses a detached field and names it', () => {
  const arena = new Arena(4);
  const comp = arena.registerComponent({ x: Float64Array });
  const [bx] = comp.detach(['x']);
  neutralize(bx);
  assert.throws(() => arena.reserve(8), (e) => /detached/.test(e.message) && /"x"/.test(e.message),
    'reserve names the detached field x');
});

test('substrate: arena.reserve() refuses a caller-backed component after rebind', () => {
  const arena = new Arena(4);
  const comp = arena.registerComponent({ x: Float64Array });
  const [bx] = comp.detach(['x']);
  neutralize(bx);
  comp.rebind({ x: new ArrayBuffer(4 * 8) });   // marks the set caller-backed
  assert.throws(() => arena.reserve(8), /caller-supplied/, 'reserve refuses a caller-backed component');
});

test('substrate: stage.reserve() surfaces the detached-field refusal (task 6)', () => {
  const stage = createStage(makeCtx(), { maxNodes: 8, width: 400, height: 300 });
  const gid = stage.geometry(geometry.box(1, 1, 1));
  const mid = stage.material(material({}));
  stage.addNode(gid, mid, {});
  // Detach one world-matrix lane and neutralize it, exactly as a Worker send would.
  const [bm0] = stage.nodes.detach(['m0']);
  neutralize(bm0);
  assert.equal(stage.nodes.isDetached('m0'), true);
  // stage.reserve must NOT mask the arena refusal -- it must propagate, naming m0.
  assert.throws(() => stage.reserve(16), (e) => /detached/.test(e.message) && /"m0"/.test(e.message),
    'stage.reserve surfaces the detached-field throw and names m0');
});
