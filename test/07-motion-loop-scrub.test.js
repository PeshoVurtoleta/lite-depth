// Two behaviors fixed during review, now proven in the real suite:
//
//  1. Motion.js apply() re-arms a completed `once` clip when absolute time is
//     scrubbed backward into [0,dur). Previously a finished `once` clip
//     latched DONE + cleared PLAYING and was skipped forever, freezing the
//     timeline scrubber. Forward-only playback is unchanged. The re-arm only
//     triggers on backward time, and only for the DONE (auto-completed) case
//     -- a user pause() (no DONE bit) must never be woken by scrubbing.
//
//  2. Scalar pos/scale tracks (KeyframePool.eval, via lite-keyframe) are
//     bidirectional: sampling the same local time forward vs backward through
//     the shared cursor yields byte-identical lane values. (Quaternion tracks
//     were already covered in test/06-motion-quaternion.test.js.)
//
// Plus a boundary matrix around the new re-arm branch in apply():
// 0, 1, N-1, N, N+1 relative to the clip duration; an empty (keyless) clip;
// null/undefined play() args; NaN and -0 as driving deltas; duplicate
// (idempotent) backward re-arm; pool exhaustion (N vs N+1 clips); and one
// case the fix's author did not call out -- resume() before any play().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage, geometry, material } from '../Depth.js';
import { createMixer } from '../Motion.js';

const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });
const mk = () => { const s = createStage(stub(), { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512 }); const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({})); return { s, node: s.addNode(g, m, {}) }; };
const EPS = 1e-9;

// ── A: once-clip re-arm on backward scrub ──────────────────────────────────

test('once clip re-arms on backward scrub (bidirectional timeline)', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(4, 5, 0, 0).play({ duration: 4, loop: 'once' });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(2 - mx.time);
  assert.equal(D.px[d], 0, 'forward t=2 -> px==0 (midpoint)');

  mx.update(4 - mx.time);
  assert.equal(D.px[d], 5, 'forward t=4 -> px==5 (final pose)');
  assert.equal(clip.done, true, 'clip.done at completion');
  assert.equal(clip.playing, false, 'clip.playing cleared at completion');

  mx.update(6 - mx.time);
  assert.equal(D.px[d], 5, 'held past completion, t=6 -> px==5');
  assert.equal(clip.done, true, 'still done while held');

  // scrub backward into [0,dur)
  mx.update(2 - mx.time);
  assert.equal(D.px[d], 0, 'backward scrub to t=2 re-animates -> px==0');
  assert.equal(clip.done, false, 'DONE cleared on backward re-arm');
  assert.equal(clip.playing, true, 'PLAYING restored on backward re-arm');

  // drive forward again -> completes again
  mx.update(4 - mx.time);
  assert.equal(D.px[d], 5, 'redriven forward reaches final pose again');
  assert.equal(clip.done, true, 'completes again after re-arm');
  assert.equal(clip.playing, false, 'playing cleared again at re-completion');
});

// ── B: paused clip hold semantics (must NOT be woken by a scrub) ──────────

test('paused clip is never woken by a backward scrub (hold semantics)', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(4, 5, 0, 0).play({ duration: 4, loop: 'once' });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(2 - mx.time);
  assert.equal(D.px[d], 0);
  clip.pause();
  assert.equal(clip.playing, false, 'pause() clears PLAYING');
  assert.equal(clip.done, false, 'pause() before completion sets no DONE bit');
  const held = D.px[d];

  mx.update(1 - mx.time); // backward
  assert.equal(D.px[d], held, 'paused clip holds pose across backward scrub');
  assert.equal(clip.playing, false, 'still paused after backward scrub');
  assert.equal(clip.done, false, 'still not done -- pause is not DONE');

  mx.update(0 - mx.time); // further backward, to exactly t=0
  assert.equal(D.px[d], held, 'paused clip holds pose at t=0 too');

  mx.update(3.9 - mx.time); // forward, still while paused
  assert.equal(D.px[d], held, 'paused clip holds pose on forward scrub too');
  assert.equal(clip.playing, false, 'pause survives any direction of scrub until resume()');
});

// ── C: scalar pos+scale tracks are bidirectional ───────────────────────────

test('scalar pos+scale tracks are bidirectional (forward == backward)', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  mx.clip(node)
    .posKey(0, -3, 1, 2, 'easeInOutCubic').posKey(1, 3, -1, -2)
    .scaleKey(0, 0.5, 'easeOutBounce').scaleKey(1, 2)
    .play({ duration: 1, loop: 'pingpong' });
  const D = s.nodes.data, d = s.nodes.idx(node);

  // Spans 1.5 pingpong cycles (dur=1, period=2) including exact segment/loop
  // boundaries where the KeyframePool cursor is most likely to mis-rewind.
  const raw = [];
  for (let k = 0; k <= 40; k++) raw.push(k * 3 / 40);
  raw.push(0, 1, 2, 3, 0.5, 1.5, 2.5);
  const times = Array.from(new Set(raw)).sort((a, b) => a - b);

  const fwd = [];
  for (const t of times) { mx.update(t - mx.time); fwd.push([D.px[d], D.py[d], D.sx[d]]); }

  const rev = new Array(times.length);
  for (let i = times.length - 1; i >= 0; i--) { const t = times[i]; mx.update(t - mx.time); rev[i] = [D.px[d], D.py[d], D.sx[d]]; }

  let worst = 0;
  for (let i = 0; i < times.length; i++) {
    worst = Math.max(worst, Math.abs(fwd[i][0] - rev[i][0]), Math.abs(fwd[i][1] - rev[i][1]), Math.abs(fwd[i][2] - rev[i][2]));
  }
  assert.ok(worst < EPS, 'max abs mismatch forward vs backward: ' + worst.toExponential(2));
});

// ── D: loop and pingpong wrap correctly ────────────────────────────────────

test('loop clip wraps local time modulo duration', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  mx.clip(node).posKey(0, 0, 0, 0).posKey(2, 10, 0, 0).play({ duration: 2, loop: 'loop' });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(1 - mx.time); assert.equal(D.px[d], 5, 'mid-cycle');
  mx.update(3 - mx.time); assert.equal(D.px[d], 5, 't=3 wraps to same phase as t=1');
  mx.update(4 - mx.time); assert.equal(D.px[d], 0, 't=4 wraps to a fresh cycle start');
});

test('pingpong clip ramps up then down over 2*duration', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  mx.clip(node).posKey(0, 0, 0, 0).posKey(2, 10, 0, 0).play({ duration: 2, loop: 'pingpong' });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(1 - mx.time); assert.equal(D.px[d], 5, 'up-phase midpoint');
  mx.update(2 - mx.time); assert.equal(D.px[d], 10, 'peak at duration');
  mx.update(3 - mx.time); assert.equal(D.px[d], 5, 'down-phase midpoint');
  mx.update(4 - mx.time); assert.equal(D.px[d], 0, 'back to start at 2*duration');
});

// ── Boundary matrix around the re-arm branch ───────────────────────────────

test('re-arm boundary: elapsed exactly == duration stays held, elapsed just under duration re-arms', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(4, 5, 0, 0).play({ duration: 4, loop: 'once', start: 0 });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(4 - mx.time); // N: exactly at duration
  assert.equal(clip.done, true); assert.equal(D.px[d], 5);

  mx.update(6 - mx.time); // N+1-ish: forward past, still held
  mx.update(4 - mx.time); // scrub straight back onto the exact boundary again
  assert.equal(clip.done, true, 'elapsed === dur exactly must NOT re-arm (boundary is exclusive)');
  assert.equal(clip.playing, false);
  assert.equal(D.px[d], 5);

  mx.update((4 - 1e-9) - mx.time); // N-1: one epsilon inside [0,dur)
  assert.equal(clip.done, false, 'elapsed just under dur re-arms');
  assert.equal(clip.playing, true);
  assert.ok(Math.abs(D.px[d] - 5) < 1e-6, 'pose is (correctly) still near the end key');
});

test('re-arm boundary: scrubbing before clip start (negative elapsed) clamps to t=0 and still re-arms', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(4, 5, 0, 0).play({ duration: 4, loop: 'once', start: 0 });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(4 - mx.time);
  assert.equal(clip.done, true);

  mx.update(-10 - mx.time); // well before the clip's start time
  assert.equal(clip.done, false, 'negative elapsed clamps to 0, which is < dur -> re-arms');
  assert.equal(clip.playing, true);
  assert.equal(D.px[d], -5, 'clamped elapsed=0 samples the first key exactly');
});

test('re-arm is idempotent across a duplicate scrub to the same backward time', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(4, 5, 0, 0).play({ duration: 4, loop: 'once', start: 0 });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(4 - mx.time);
  mx.update(1 - mx.time); // re-arm
  const px1 = D.px[d], done1 = clip.done, playing1 = clip.playing;

  mx.update(1 - mx.time); // dt===0: re-applying the same instant must not toggle state again
  assert.equal(D.px[d], px1, 'duplicate re-application at the same time is a no-op on lane value');
  assert.equal(clip.done, done1);
  assert.equal(clip.playing, playing1);
});

test('NaN and -0 drive-deltas are no-ops in standalone time mode (guarded by truthiness, not silently corrupting time)', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(4, 5, 0, 0).play({ duration: 4, loop: 'once' });
  const D = s.nodes.data, d = s.nodes.idx(node);

  mx.update(2 - mx.time);
  const px = D.px[d], t = mx.time;

  mx.update(NaN);
  assert.equal(mx.time, t, 'NaN delta must not corrupt the standalone time base');
  assert.equal(D.px[d], px, 'NaN delta is a no-op on lane state');
  assert.equal(clip.done, false); assert.equal(clip.playing, true);

  mx.update(-0);
  assert.ok(Object.is(mx.time, t), '-0 delta must not move the standalone time base');
  assert.equal(D.px[d], px, '-0 delta is a no-op on lane state');
});

test('empty (keyless) clip is inert: apply() does not touch node lanes or throw', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).play({ duration: 1, loop: 'once' }); // no *Key() calls at all
  const D = s.nodes.data, d = s.nodes.idx(node);
  const before = [D.px[d], D.py[d], D.pz[d], D.sx[d], D.sy[d], D.sz[d]];

  assert.doesNotThrow(() => { mx.update(0.5 - mx.time); });
  assert.deepEqual([D.px[d], D.py[d], D.pz[d], D.sx[d], D.sy[d], D.sz[d]], before, 'keyless clip never writes any lane');
});

test('null/undefined play() options fall back to safe defaults', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(1, 5, 0, 0);
  assert.doesNotThrow(() => clip.play(undefined));
  assert.equal(clip.playing, true);
  assert.doesNotThrow(() => clip.play(null));
  assert.equal(clip.playing, true, 'play(null) still (re)plays with defaults');
  const D = s.nodes.data, d = s.nodes.idx(node);
  mx.update(1 - mx.time); // duration falls back to the inferred max key time (1)
  assert.equal(D.px[d], 5);
});

test('clip pool boundary: exactly maxClips (N) succeeds, the (N+1)th throws', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 2 });
  assert.doesNotThrow(() => mx.clip(node), 'clip 1 of N');
  assert.doesNotThrow(() => mx.clip(node), 'clip 2 of N (last valid slot)');
  assert.throws(() => mx.clip(node), /clip pool exhausted/, 'clip N+1 must throw, not silently corrupt the pool');
  assert.equal(mx.clipCount, 2, 'pool count unchanged after the rejected N+1th clip');
});

test('adversarial: resume() before any play() call still produces defined (not NaN/throwing) behavior', () => {
  // The planner's fix only touches apply()'s hold/re-arm branch; resume() sets
  // PLAYING whenever DONE is clear, even if play() was never called (cDur/cStart
  // still at their clip()-time defaults). Pin the actual measured behavior so a
  // future refactor of play()/resume() can't silently regress it into a throw
  // or an NaN-poisoned lane.
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const clip = mx.clip(node).posKey(0, -5, 0, 0).posKey(4, 5, 0, 0);
  assert.equal(clip.playing, false); assert.equal(clip.done, false);

  clip.resume();
  assert.equal(clip.playing, true, 'resume() sets PLAYING even without a prior play()');
  assert.equal(clip.done, false);

  const D = s.nodes.data, d = s.nodes.idx(node);
  assert.doesNotThrow(() => { mx.update(2 - mx.time); });
  assert.ok(Number.isFinite(D.px[d]), 'lane must stay finite even under this unplanned call order');
});
