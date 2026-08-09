import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glMatrix, quat } from 'gl-matrix';
import { createStage, geometry, material } from '../Depth.js';
import { createMixer } from '../Motion.js';
glMatrix.setMatrixArrayType(Float64Array);

const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });
const mk = () => { const s = createStage(stub(), { width: 400, height: 300, maxNodes: 8, maxVerts: 512, maxDrawFaces: 512 }); const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({})); return { s, node: s.addNode(g, m, {}) }; };
const fr = (q) => [Math.fround(q[0]), Math.fround(q[1]), Math.fround(q[2]), Math.fround(q[3])];
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

test('slerp matches gl-matrix (bit-exact on Float32-stored inputs)', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  const qa = quat.create(); quat.random(qa); const qb = quat.create(); quat.random(qb);
  mx.clip(node).quatKey(0, qa[0], qa[1], qa[2], qa[3]).quatKey(1, qb[0], qb[1], qb[2], qb[3]).play({ duration: 1 });
  const D = s.nodes.data, d = s.nodes.idx(node); const qaf = fr(qa), qbf = fr(qb);
  let worst = 0;
  for (let k = 0; k <= 20; k++) { const t = k / 20; mx.update(t - mx.time); const ref = quat.create(); quat.slerp(ref, qaf, qbf, t); const dm = Math.hypot(D.qx[d] - ref[0], D.qy[d] - ref[1], D.qz[d] - ref[2], D.qw[d] - ref[3]); const dp = Math.hypot(D.qx[d] + ref[0], D.qy[d] + ref[1], D.qz[d] + ref[2], D.qw[d] + ref[3]); worst = Math.max(worst, Math.min(dm, dp)); }
  assert.ok(worst < 1e-6, 'worst ' + worst.toExponential(2));
});

test('output stays unit-normalized across random pose pairs', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 }); const rng = mulberry32(5);
  const clip = mx.clip(node);
  const qa = quat.create(); quat.random(qa); const qb = quat.create(); quat.random(qb);
  clip.quatKey(0, qa[0], qa[1], qa[2], qa[3]).quatKey(1, qb[0], qb[1], qb[2], qb[3]).play({ duration: 1 });
  const D = s.nodes.data, d = s.nodes.idx(node); let worstDev = 0;
  for (let k = 0; k <= 40; k++) { const t = k / 40; mx.update(t - mx.time); worstDev = Math.max(worstDev, Math.abs(Math.hypot(D.qx[d], D.qy[d], D.qz[d], D.qw[d]) - 1)); }
  assert.ok(worstDev < 1e-5, 'worst |q|-1 ' + worstDev.toExponential(2));
});

test('nlerp fast path (near-parallel quats) stays normalized and monotonic', () => {
  const { s, node } = mk(); const mx = createMixer(s, { maxClips: 4 });
  // two quats 0.5deg apart -> dot > 0.9995, triggers nlerp branch
  const a = [0, 0, 0, 1]; const th = 0.5 * Math.PI / 180; const b = [0, Math.sin(th / 2), 0, Math.cos(th / 2)];
  mx.clip(node).quatKey(0, a[0], a[1], a[2], a[3]).quatKey(1, b[0], b[1], b[2], b[3]).play({ duration: 1 });
  const D = s.nodes.data, d = s.nodes.idx(node); let prev = -1, mono = true;
  for (let k = 0; k <= 10; k++) { const t = k / 10; mx.update(t - mx.time); assert.ok(Math.abs(Math.hypot(D.qx[d], D.qy[d], D.qz[d], D.qw[d]) - 1) < 1e-6); if (D.qy[d] < prev - 1e-9) mono = false; prev = D.qy[d]; }
  assert.ok(mono, 'nlerp interpolation should advance monotonically');
});
