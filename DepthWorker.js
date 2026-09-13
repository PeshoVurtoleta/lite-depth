/**
 * @zakkster/lite-depth -- DepthWorker.js : the off-thread transform worker (D6).
 *
 * The RETURN half of stage.useWorker()'s transferable round-trip. Two message kinds:
 *
 *   kind 't' (structural, cold, one-way): { count, topo, parentDense }. The Worker
 *     STORES the topo order + parent-dense map (as copies the main thread sent -- the
 *     main thread keeps its own home for its project pass) and does NOT reply. Sent on
 *     bind and whenever the stage structure epoch changes.
 *
 *   kind 'f' (per frame): { seq, lanes: { px..sz, m0..m11, flags }, wnu }. The Worker
 *     composes the world 3x4 for every node in the stored TOPO ORDER, AND propagates
 *     the WORLD non-uniform bit (worldNonUnif) in that same order -- EXACTLY as the
 *     main-thread transform loop does (own local NON_UNIFORM_SCALE flag OR any
 *     non-uniform ancestor taints the composed basis). It then transfers every 'f'
 *     buffer back (pose + m* + flags + wnu), in one message, one transfer list. This
 *     gives f64-EXACT shade parity across the on-thread and off-thread backends.
 *
 * It REUSES Depth.js's math kernels (composeTRS / mulAffine) and its FLAGS namespace
 * -- it does not reimplement the transform math or hardcode the flag bit. The
 * transfer is the fence: exactly one thread owns a buffer at a time -- no
 * SharedArrayBuffer, no atomics, no locks.
 *
 * Runs in BOTH node:worker_threads (tests, torture) and a browser module Worker
 * (demo): the parentPort import is guarded, and the message wiring picks the shape
 * that exists.
 *
 * @author Zahary Shinikchiev
 * @license MIT
 */

import { mathKernels, FLAGS } from './Depth.js';

const { composeTRS, mulAffine } = mathKernels;
const F_NONUNIF = 1 << FLAGS.get('NON_UNIFORM_SCALE');

// Module-level transform scratch (zero per-frame allocation of temporaries).
const _LOC = new Float64Array(12);   // local 3x4
const _A = new Float64Array(12);     // gathered parent world 3x4
const _OUT = new Float64Array(12);   // composed world 3x4

// The 12 world-matrix lane names in order, so a gather/scatter is a flat loop.
const M = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'];
// The per-frame transferable buffers, in a fixed order: 10 pose + 12 world + flags +
// worldNonUnif = 24. Reused across messages (a fresh transfer list per message would
// allocate in the Worker -- harmless to the main thread, but no reason to churn it).
const LANE_KEYS = [
  'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz',
  'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11',
  'flags',
];
const _xfer = new Array(LANE_KEYS.length + 1);
// Reused world-matrix lane-view holder (repointed per message).
const _m = new Array(12);

// Stored structure (kind 't'): the Worker OWNS these copies until the next 't'.
let _count = 0;
let _topo = null;         // Uint32Array
let _parentDense = null;  // Int32Array

// Compose world matrices + propagate the world non-uniform bit for every node in topo
// order, writing back into the same transferred m0..m11 / worldNonUnif buffers.
function transform(msg) {
  if (_topo === null) return;   // no structure yet (protocol guarantees 't' precedes 'f')
  const count = _count;
  const L = msg.lanes;
  const px = new Float64Array(L.px), py = new Float64Array(L.py), pz = new Float64Array(L.pz);
  const qx = new Float64Array(L.qx), qy = new Float64Array(L.qy), qz = new Float64Array(L.qz), qw = new Float64Array(L.qw);
  const sx = new Float64Array(L.sx), sy = new Float64Array(L.sy), sz = new Float64Array(L.sz);
  const flags = new Uint32Array(L.flags);
  const wnu = new Uint8Array(msg.wnu);
  const m = _m;
  for (let k = 0; k < 12; k++) m[k] = new Float64Array(L[M[k]]);
  const topo = _topo, parentDense = _parentDense;

  for (let i = 0; i < count; i++) {
    const d = topo[i], pd = parentDense[d];
    composeTRS(_LOC, px[d], py[d], pz[d], qx[d], qy[d], qz[d], qw[d], sx[d], sy[d], sz[d]);
    if (pd < 0) {
      for (let k = 0; k < 12; k++) m[k][d] = _LOC[k];
      wnu[d] = (flags[d] & F_NONUNIF) !== 0 ? 1 : 0;
    } else {
      // world = parentWorld * local. Gather the parent's world 3x4 (spread across the
      // 12 lane arrays) into _A, then reuse the package's mulAffine kernel.
      for (let k = 0; k < 12; k++) _A[k] = m[k][pd];
      mulAffine(_OUT, _A, _LOC);
      for (let k = 0; k < 12; k++) m[k][d] = _OUT[k];
      // Same propagation as the main-thread transform loop: own local non-uniform OR
      // any non-uniform ancestor (a rotated-only ancestor is a similarity, no taint).
      wnu[d] = ((flags[d] & F_NONUNIF) !== 0 ? 1 : 0) | wnu[pd];
    }
  }
}

// Build the per-frame return transfer list (the same 24 buffers, unchanged identity)
// into the reused _xfer array. m0..m11 + worldNonUnif now hold the fresh results.
function buildXfer(msg) {
  const L = msg.lanes;
  for (let i = 0; i < LANE_KEYS.length; i++) _xfer[i] = L[LANE_KEYS[i]];
  _xfer[LANE_KEYS.length] = msg.wnu;
  return _xfer;
}

// -- messaging wiring: node:worker_threads OR a browser module Worker --------------

let parentPort = null;
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  ({ parentPort } = await import('node:worker_threads'));
}

function post(msg, xfer) {
  if (parentPort) parentPort.postMessage(msg, xfer);
  else self.postMessage(msg, xfer);
}

function handle(msg) {
  if (msg === null || typeof msg !== 'object') return;
  if (msg.kind === 't') {
    // Structural sync: store the copies the main thread sent. One-way -- no reply.
    _count = msg.count | 0;
    _topo = new Uint32Array(msg.topo);
    _parentDense = new Int32Array(msg.parentDense);
    return;
  }
  transform(msg);
  post(msg, buildXfer(msg));
}

if (parentPort) parentPort.on('message', handle);
else if (typeof self !== 'undefined') self.onmessage = (ev) => handle(ev.data);
