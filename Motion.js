/**
 * @zakkster/lite-depth/motion — v1.1.0 "Motion" animation layer for lite-depth.
 *
 * A thin composer over the stack, not a re-implementation:
 *   - time base   = @zakkster/lite-clock   (deterministic advance(dt), simTime)
 *   - scalar keys = @zakkster/lite-keyframe (KeyframePool: zero-GC, cursor-advanced)
 *   - easing bank = @zakkster/lite-ease     (30 Penner curves as (t)=>t)
 * Motion adds only what the stack lacks: quaternion tracks (slerp with an nlerp
 * fast path — scalar keyframe rows would denormalise and never slerp), a clip
 * table binding channels to lite-depth node lanes, and loop/pingpong wrapping.
 *
 * The update path is allocation-free (measured at the bytes/op noise floor, 0
 * steady GC): channels evaluate straight into the arena's Float64 lane arrays
 * rather than through the stage setters, so no eval result is boxed as it
 * crosses a call boundary. Golden-frame determinism falls out of driving it
 * with fixed advance(dt) — same dt sequence, byte-identical lane state.
 *
 * @author Zahary Shinikchiev
 * @license MIT
 */

import { KeyframePool } from '@zakkster/lite-keyframe';
import * as ease from '@zakkster/lite-ease';
import { FLAGS } from './Depth.js';

const INDEX_MASK = 0xFFFFF;   // lite-arena low 20 bits = slot index

/* clip loop modes */
export const ONCE = 0, LOOP = 1, PINGPONG = 2;

/* clip flag bits */
const PLAYING = 1 << 0, HAS_POS = 1 << 1, HAS_SCALE = 1 << 2, HAS_QUAT = 1 << 3, HAS_BIAS = 1 << 4, DONE = 1 << 5;

/* per-clip scalar row layout in the shared KeyframePool: 3 pos + 3 scale + 1 bias */
const ROWS_PER_CLIP = 7;
const R_POS = 0, R_SCALE = 3, R_BIAS = 6;

/* default easing bank: index 0 is linear, then a useful spread. Names map to
   bank indices for the *Key(..., easeName) calls. */
const DEFAULT_EASINGS = [
  'linear', 'easeInOutQuad', 'easeInOutCubic', 'easeOutCubic', 'easeInCubic',
  'easeOutQuad', 'easeInQuad', 'easeOutBounce', 'easeOutElastic', 'easeInOutSine',
  'easeOutBack', 'easeInOutExpo',
];

const _q = new Float64Array(4);   // slerp scratch (hot path)

function slerpInto(out, ax, ay, az, aw, bx, by, bz, bw, t) {
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (dot > 0.9995) {                       // nlerp fast path (near-parallel)
    let x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, w = aw + (bw - aw) * t;
    const inv = 1 / (Math.hypot(x, y, z, w) || 1);
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv; out[3] = w * inv;
    return;
  }
  const theta = Math.acos(dot), s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s, wb = Math.sin(t * theta) / s;
  out[0] = ax * wa + bx * wb; out[1] = ay * wa + by * wb; out[2] = az * wa + bz * wb; out[3] = aw * wa + bw * wb;
}

export function createMixer(stage, opts) {
  const o = opts || {};
  const maxClips = o.maxClips || 256;
  const maxKeys = o.maxKeys || 8;          // keys per scalar row
  const maxQuatKeys = o.maxQuatKeys || 8;
  const clock = o.clock || null;           // if null, mixer owns its own simTime (standalone dt mode)

  // easing bank (functions) + name->index map
  const names = (o.easings || DEFAULT_EASINGS).slice();
  const bank = names.map((n) => { const f = ease[n] || ease.easings?.[n]; if (typeof f !== 'function') throw new Error('lite-motion: unknown easing "' + n + '"'); return f; });
  const easeIdx = new Map(); names.forEach((n, i) => easeIdx.set(n, i));
  const resolveEase = (e) => e == null ? -1 : (typeof e === 'number' ? e : (easeIdx.has(e) ? easeIdx.get(e) : -1));

  // scalar channels: one shared KeyframePool, ROWS_PER_CLIP rows per clip
  const pool = new KeyframePool(maxClips * ROWS_PER_CLIP, maxKeys);
  pool.setBank(bank);

  // quaternion track arena (one track per clip): times + 4-wide values + easings
  const qTimes = new Float32Array(maxClips * maxQuatKeys);
  const qVals = new Float32Array(maxClips * maxQuatKeys * 4);
  const qEase = new Int8Array(maxClips * maxQuatKeys);
  const qCount = new Int32Array(maxClips);
  const qCursor = new Int32Array(maxClips);

  // clip SoA
  const cNode = new Int32Array(maxClips);
  const cStart = new Float64Array(maxClips);
  const cDur = new Float64Array(maxClips);
  const cScale = new Float64Array(maxClips);     // timescale
  const cLoop = new Uint8Array(maxClips);
  const cFlags = new Uint8Array(maxClips);
  const cMaxKeyT = new Float64Array(maxClips);   // for duration inference
  let clipCount = 0;

  let simTime = 0;                                // standalone time base

  const now = () => clock ? clock.simTime : simTime;

  /* ── cold: build a clip ── */
  function clip(nodeHandle) {
    if (clipCount >= maxClips) throw new Error('lite-motion: clip pool exhausted (' + maxClips + ')');
    const id = clipCount++;
    cNode[id] = nodeHandle; cStart[id] = 0; cDur[id] = 0; cScale[id] = 1; cLoop[id] = ONCE; cFlags[id] = 0; cMaxKeyT[id] = 0;
    qCount[id] = 0; qCursor[id] = 0;
    // reset scalar rows for this clip
    for (let r = 0; r < ROWS_PER_CLIP; r++) pool.clear(id * ROWS_PER_CLIP + r);

    const base = id * ROWS_PER_CLIP;
    const bump = (t) => { if (t > cMaxKeyT[id]) cMaxKeyT[id] = t; };
    const api = {
      id,
      posKey(t, x, y, z, e) { const ei = resolveEase(e); pool.addKey(base + R_POS, t, x, ei); pool.addKey(base + R_POS + 1, t, y, ei); pool.addKey(base + R_POS + 2, t, z, ei); cFlags[id] |= HAS_POS; bump(t); return api; },
      scaleKey(t, x, y, z, e) {
        // overloads: scaleKey(t,s) uniform · scaleKey(t,s,'ease') uniform+ease
        //            scaleKey(t,x,y,z) per-axis · scaleKey(t,x,y,z,'ease') per-axis+ease
        // a string in the y/z slot is the easing, not an axis value.
        if (typeof y === 'string') { e = y; y = undefined; z = undefined; }
        else if (typeof z === 'string') { e = z; z = undefined; }
        if (y === undefined || y === null) { y = x; z = x; }
        else if (z === undefined || z === null) { z = y; }
        const ei = resolveEase(e);
        pool.addKey(base + R_SCALE, t, x, ei); pool.addKey(base + R_SCALE + 1, t, y, ei); pool.addKey(base + R_SCALE + 2, t, z, ei);
        cFlags[id] |= HAS_SCALE; bump(t); return api;
      },
      biasKey(t, v, e) { pool.addKey(base + R_BIAS, t, v, resolveEase(e)); cFlags[id] |= HAS_BIAS; bump(t); return api; },
      quatKey(t, x, y, z, w, e) {
        const n = qCount[id]; if (n >= maxQuatKeys) return api;
        const off = id * maxQuatKeys;
        // insertion sort by time (cold)
        let i = n; while (i > 0 && qTimes[off + i - 1] > t) { qTimes[off + i] = qTimes[off + i - 1]; qEase[off + i] = qEase[off + i - 1]; qVals[(off + i) * 4] = qVals[(off + i - 1) * 4]; qVals[(off + i) * 4 + 1] = qVals[(off + i - 1) * 4 + 1]; qVals[(off + i) * 4 + 2] = qVals[(off + i - 1) * 4 + 2]; qVals[(off + i) * 4 + 3] = qVals[(off + i - 1) * 4 + 3]; i--; }
        qTimes[off + i] = t; qEase[off + i] = resolveEase(e);
        const vi = (off + i) * 4; qVals[vi] = x; qVals[vi + 1] = y; qVals[vi + 2] = z; qVals[vi + 3] = w;
        qCount[id] = n + 1; qCursor[id] = 0; cFlags[id] |= HAS_QUAT; bump(t); return api;
      },
      quatEuler(t, ex, ey, ez, e) {
        const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2), cy = Math.cos(ey / 2), sy = Math.sin(ey / 2), cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
        return api.quatKey(t, sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz, e);
      },
      play(p) {
        p = p || {};
        cDur[id] = p.duration || cMaxKeyT[id] || 1;
        cScale[id] = p.timescale || 1;
        cLoop[id] = p.loop === 'loop' ? LOOP : p.loop === 'pingpong' ? PINGPONG : (typeof p.loop === 'number' ? p.loop : ONCE);
        cStart[id] = p.start !== undefined ? p.start : now();
        cFlags[id] = (cFlags[id] & ~DONE) | PLAYING;
        return api;
      },
      pause() { cFlags[id] &= ~PLAYING; return api; },
      resume() { if ((cFlags[id] & DONE) === 0) cFlags[id] |= PLAYING; return api; },
      stop() { cFlags[id] &= ~PLAYING; return api; },
      seek(local) { cStart[id] = now() - local / (cScale[id] || 1); return api; },
      get done() { return (cFlags[id] & DONE) !== 0; },
      get playing() { return (cFlags[id] & PLAYING) !== 0; },
    };
    return api;
  }

  /* ── hot: evaluate a quaternion track at local time t into _q ── */
  function evalQuat(id, t) {
    const n = qCount[id]; const off = id * maxQuatKeys;
    if (n === 0) { _q[0] = 0; _q[1] = 0; _q[2] = 0; _q[3] = 1; return; }
    if (n === 1 || t <= qTimes[off]) { const vi = off * 4; _q[0] = qVals[vi]; _q[1] = qVals[vi + 1]; _q[2] = qVals[vi + 2]; _q[3] = qVals[vi + 3]; return; }
    if (t >= qTimes[off + n - 1]) { const vi = (off + n - 1) * 4; _q[0] = qVals[vi]; _q[1] = qVals[vi + 1]; _q[2] = qVals[vi + 2]; _q[3] = qVals[vi + 3]; return; }
    let c = qCursor[id]; if (c >= n - 1) c = n - 2; if (c < 0) c = 0;
    // advance/rewind cursor
    while (c < n - 2 && t >= qTimes[off + c + 1]) c++;
    while (c > 0 && t < qTimes[off + c]) c--;
    qCursor[id] = c;
    const t0 = qTimes[off + c], t1 = qTimes[off + c + 1], dt = t1 - t0;
    let lt = dt > 0 ? (t - t0) / dt : 0;
    const ei = qEase[off + c + 1]; if (ei >= 0) lt = bank[ei](lt);
    const a = (off + c) * 4, b = (off + c + 1) * 4;
    slerpInto(_q, qVals[a], qVals[a + 1], qVals[a + 2], qVals[a + 3], qVals[b], qVals[b + 1], qVals[b + 2], qVals[b + 3], lt);
  }

  /* ── hot: advance clips and write node lanes directly (zero alloc) ──
     We write into the arena's lane arrays rather than calling stage setters:
     a double returned from pool.eval() and passed as a *function argument*
     gets boxed as a HeapNumber across the non-inlined call boundary, but the
     same double stored straight into a Float64Array element does not. So we
     cache the lane refs and store in place, then set the dirty bit ourselves. */
  const D = stage.nodes.data, sparse = stage.nodes.sparse;
  const _px = D.px, _py = D.py, _pz = D.pz, _sx = D.sx, _sy = D.sy, _sz = D.sz;
  const _qx = D.qx, _qy = D.qy, _qz = D.qz, _qw = D.qw, _bias = D.bias, _flags = D.flags;
  const F_DIRTY = 1 << FLAGS.get('DIRTY');
  const F_NONUNIF = 1 << FLAGS.get('NON_UNIFORM_SCALE');

  function apply() {
    const T = now();
    for (let id = 0; id < clipCount; id++) {
      const flags = cFlags[id];
      const dur = cDur[id] || 1;
      let elapsed = (T - cStart[id]) * cScale[id];
      if (elapsed < 0) elapsed = 0;
      if ((flags & PLAYING) === 0) {
        // Paused/stopped clips hold their pose. A ONCE clip that auto-completed
        // (DONE, PLAYING cleared) also holds -- until absolute time is scrubbed
        // back into [0,dur), when we re-arm it so bidirectional scrubbing works
        // in every loop mode. A user pause (no DONE bit) is never woken here.
        if ((flags & DONE) === 0 || elapsed >= dur) continue;
        cFlags[id] = (flags & ~DONE) | PLAYING;
      }
      let lt;
      const loop = cLoop[id];
      if (loop === LOOP) { lt = elapsed % dur; }
      else if (loop === PINGPONG) { const p = elapsed % (2 * dur); lt = p < dur ? p : 2 * dur - p; }
      else { if (elapsed >= dur) { lt = dur; cFlags[id] = (cFlags[id] & ~PLAYING) | DONE; } else lt = elapsed; }

      const d = sparse[cNode[id] & INDEX_MASK], base = id * ROWS_PER_CLIP;
      if (flags & HAS_POS) { _px[d] = pool.eval(base + R_POS, lt); _py[d] = pool.eval(base + R_POS + 1, lt); _pz[d] = pool.eval(base + R_POS + 2, lt); }
      if (flags & HAS_SCALE) {
        const vx = pool.eval(base + R_SCALE, lt), vy = pool.eval(base + R_SCALE + 1, lt), vz = pool.eval(base + R_SCALE + 2, lt);
        _sx[d] = vx; _sy[d] = vy; _sz[d] = vz;
        if (vx !== vy || vx !== vz) _flags[d] |= F_NONUNIF; else _flags[d] &= ~F_NONUNIF;
      }
      if (flags & HAS_BIAS) { _bias[d] = pool.eval(base + R_BIAS, lt); }
      if (flags & HAS_QUAT) { evalQuat(id, lt); _qx[d] = _q[0]; _qy[d] = _q[1]; _qz[d] = _q[2]; _qw[d] = _q[3]; }
      _flags[d] |= F_DIRTY;
    }
  }

  /* ── public update ── */
  const mixer = {
    clip,
    /** Standalone mode: advance internal time by dt, then apply. */
    update(dt) { if (!clock && dt) simTime += dt; apply(); return mixer; },
    /** Clock mode: apply at the clock's current simTime (call after clock.advance). */
    sync() { apply(); return mixer; },
    get time() { return now(); },
    get clipCount() { return clipCount; },
    _internal: { pool, qTimes, qVals, qCount, cFlags, cStart, cDur },
  };
  return mixer;
}

export const version = '1.1.0';
