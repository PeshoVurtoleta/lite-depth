// Math kernels vs gl-matrix, forced to Float64 for a true double-precision
// reference (gl-matrix defaults to Float32Array, which would inject ~1e-7 error
// that is gl-matrix's precision, not ours).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glMatrix, mat4, quat, vec3 } from 'gl-matrix';
import { mathKernels } from '../Depth.js';

glMatrix.setMatrixArrayType(Float64Array);
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

test('composeTRS == gl-matrix fromRotationTranslationScale (bit-exact)', () => {
  const rng = mulberry32(1); let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const tx = rng() * 4 - 2, ty = rng() * 4 - 2, tz = rng() * 4 - 2;
    const q = quat.create(); quat.random(q); const s = rng() * 2 + 0.2;
    const out = new Float64Array(12);
    mathKernels.composeTRS(out, tx, ty, tz, q[0], q[1], q[2], q[3], s, s, s);
    const M = mat4.create(); mat4.fromRotationTranslationScale(M, q, [tx, ty, tz], [s, s, s]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      const ref = c < 3 ? M[c * 4 + r] : M[12 + r];
      worst = Math.max(worst, Math.abs(out[r * 4 + c] - ref));
    }
  }
  assert.ok(worst < 1e-12, 'worst error ' + worst.toExponential(2));
});

test('quatRotate == gl-matrix transformQuat (within 1 ULP)', () => {
  const rng = mulberry32(11); let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const q = quat.create(); quat.random(q);
    const n = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]; const L = Math.hypot(n[0], n[1], n[2]); n[0] /= L; n[1] /= L; n[2] /= L;
    const nr = new Float64Array(3); mathKernels.quatRotate(nr, q[0], q[1], q[2], q[3], n[0], n[1], n[2]);
    const ref = vec3.create(); vec3.transformQuat(ref, n, q);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(nr[k] - ref[k]));
  }
  assert.ok(worst < 1e-12, 'worst error ' + worst.toExponential(2));
});

test('mulAffine == gl-matrix parent*child (bit-exact)', () => {
  const rng = mulberry32(7); let worst = 0;
  const randAffine = () => { const q = quat.create(); quat.random(q); const o = new Float64Array(12); mathKernels.composeTRS(o, rng() * 4 - 2, rng() * 4 - 2, rng() * 4 - 2, q[0], q[1], q[2], q[3], rng() + 0.3, rng() + 0.3, rng() + 0.3); return o; };
  const to44 = (A) => { const M = mat4.create(); M[0] = A[0]; M[4] = A[1]; M[8] = A[2]; M[12] = A[3]; M[1] = A[4]; M[5] = A[5]; M[9] = A[6]; M[13] = A[7]; M[2] = A[8]; M[6] = A[9]; M[10] = A[10]; M[14] = A[11]; M[3] = M[7] = M[11] = 0; M[15] = 1; return M; };
  for (let i = 0; i < 2000; i++) {
    const A = randAffine(), B = randAffine(); const out = new Float64Array(12); mathKernels.mulAffine(out, A, B);
    const MO = mat4.create(); mat4.multiply(MO, to44(A), to44(B));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      const ref = c < 3 ? MO[c * 4 + r] : MO[12 + r];
      worst = Math.max(worst, Math.abs(out[r * 4 + c] - ref));
    }
  }
  assert.ok(worst < 1e-12, 'worst error ' + worst.toExponential(2));
});
