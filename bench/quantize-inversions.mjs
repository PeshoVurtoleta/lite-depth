// bench/quantize-inversions.mjs -- run: node bench/quantize-inversions.mjs
//
// D7 residual 1 decision record. Compares the INCUMBENT linear-in-viewZ depth
// curve (Depth.js:1847) against a CANDIDATE perspective 1/z curve for
// same-layer sort fidelity on a near-camera-heavy fixture. This is a bench: it
// allocates freely, never ships, and is outside package.json files[].
//
// Depth key layout mirrors Depth.js: 6 layer bits << 26 | 26-bit depth.

const DEPTH_BITS = 26;
const DEPTH_MAX = (1 << DEPTH_BITS) - 1;
const LAYER_SHIFT = DEPTH_BITS;

function packKey(layer, depth) {
  return (((layer & 63) << LAYER_SHIFT) | (depth & DEPTH_MAX)) >>> 0;
}

// INCUMBENT: linear in view-space z. Byte-mirror of Depth.js:1842-1856,
// including the D-06 ordered-compare NaN guard (NaN -> DEPTH_MAX, never 0).
function quantizeLinear(z, near, far, zSpan) {
  const t = (z + far) / zSpan;
  if (t <= 0) return 0;
  if (t >= 1) return DEPTH_MAX;
  if (t > 0) return (t * DEPTH_MAX) | 0;
  return DEPTH_MAX;
}

// CANDIDATE: perspective-correct 1/z. Same ordered-compare NaN structure so the
// D-06 fail-closed contract and strict monotonicity are preserved for the test.
// z is view-space (negative); |z| = -z rises from near..far.
function quantizePersp(z, near, far, zSpan) {
  const invNear = 1 / near, invFar = 1 / far;
  const t = (1 / (z < 0 ? -z : z) - invFar) / (invNear - invFar);
  if (t <= 0) return 0;
  if (t >= 1) return DEPTH_MAX;
  if (t > 0) return (t * DEPTH_MAX) | 0;
  return DEPTH_MAX;
}

// Deterministic LCG so the fixture is reproducible run to run.
let _seed = 0x9e3779b9 >>> 0;
function rnd() {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
}

const FACES = 4000;      // >= 2000
const LAYERS = 4;        // realistic (max layer ever assigned in fixtures is 3)
const RATIOS = [100, 1000, 10000];
const NEAR = 1;

// Build one fixture per far/near ratio: 70% of centroids have |z| in [near,4near]
// (near-camera-heavy), the remaining 30% spread across [4near, far]. z is the
// negative view-space centroid; bias is a small per-face nudge (as at the real
// call sites, e.g. cvz + bias). All in Float64Array -- exact f64 oracle input.
function buildFixture(near, far) {
  const z = new Float64Array(FACES);
  const bias = new Float64Array(FACES);
  const layer = new Uint8Array(FACES);
  const nearHi = 4 * near;
  for (let i = 0; i < FACES; i++) {
    let mag;
    if (rnd() < 0.70) mag = near + rnd() * (nearHi - near);
    else mag = nearHi + rnd() * (far - nearHi);
    z[i] = -mag;                       // view-space z is negative
    bias[i] = (rnd() - 0.5) * 0.02;    // tiny +/- nudge, like SHADOW_DEPTH_BIAS scale
    layer[i] = i % LAYERS;
  }
  return { z, bias, layer };
}

// Count Kendall discordant pairs (inversions) among SAME-LAYER faces against an
// exact f64 oracle order (ascending centroidViewZ + bias -> ascending depth key,
// matching quantize's near->DEPTH_MAX mapping). A quantized-key TIE on a strict
// oracle pair is NOT counted as an inversion; ties are reported separately.
function measure(fx, near, far, quantize) {
  const zSpan = far - near;
  const { z, bias, layer } = fx;
  const key = new Uint32Array(FACES);
  const oracle = new Float64Array(FACES);
  for (let i = 0; i < FACES; i++) {
    const zc = z[i] + bias[i];
    key[i] = packKey(layer[i], quantize(zc, near, far, zSpan));
    oracle[i] = zc;
  }
  let inversions = 0;
  // faces that collide onto a shared packed key (within a layer, since layer is
  // in the key). Count distinct faces involved in any >1 collision group.
  const seen = new Map();
  const collideKeys = new Set();
  for (let i = 0; i < FACES; i++) {
    const k = key[i];
    if (seen.has(k)) collideKeys.add(k);
    else seen.set(k, i);
  }
  let tieFaces = 0;
  const perKeyCount = new Map();
  for (let i = 0; i < FACES; i++) perKeyCount.set(key[i], (perKeyCount.get(key[i]) || 0) + 1);
  for (const [, c] of perKeyCount) if (c > 1) tieFaces += c;

  for (let a = 0; a < LAYERS; a++) {
    for (let i = 0; i < FACES; i++) {
      if (layer[i] !== a) continue;
      for (let j = i + 1; j < FACES; j++) {
        if (layer[j] !== a) continue;
        const od = oracle[i] - oracle[j];
        if (od === 0) continue;          // oracle tie: no strict order to violate
        const kd = key[i] - key[j];
        if (kd === 0) continue;          // quantized tie: reported as a tie, not an inversion
        if ((od > 0) !== (kd > 0)) inversions++;
      }
    }
  }
  return { inversions, tieFaces };
}

// ns/call for the quantize function itself (hot-path cost, not the harness).
function timeQuantize(quantize, near, far) {
  const zSpan = far - near;
  const N = 4000000;
  // warm
  let acc = 0;
  for (let i = 0; i < 200000; i++) acc += quantize(-(near + (i % 1000) * 0.01), near, far, zSpan);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    acc += quantize(-(near + (i % 100000) * 0.001), near, far, zSpan);
  }
  const t1 = process.hrtime.bigint();
  if (acc === 42) console.log('');   // defeat DCE
  return Number(t1 - t0) / N;
}

console.log('# D7 residual 1 -- quantize inversion table');
console.log('');
console.log('Fixture: ' + FACES + ' faces, ' + LAYERS + ' layers, near=' + NEAR +
  ', 70% of |centroidViewZ| in [near, 4*near]. Inversions = Kendall discordant');
console.log('pairs among SAME-LAYER faces vs exact f64 oracle (centroidViewZ+bias).');
console.log('Ties = faces sharing a packed 26-bit depth key with >=1 other face.');
console.log('');
console.log('| far/near | linear inversions | linear ties | 1/z inversions | 1/z ties | linear ns/call | 1/z ns/call |');
console.log('|---------:|------------------:|------------:|---------------:|---------:|---------------:|------------:|');
for (const ratio of RATIOS) {
  const near = NEAR, far = ratio * NEAR;
  const fx = buildFixture(near, far);
  const lin = measure(fx, near, far, quantizeLinear);
  const per = measure(fx, near, far, quantizePersp);
  const linNs = timeQuantize(quantizeLinear, near, far);
  const perNs = timeQuantize(quantizePersp, near, far);
  console.log('| ' + ratio + ' | ' + lin.inversions + ' | ' + lin.tieFaces + ' | ' +
    per.inversions + ' | ' + per.tieFaces + ' | ' + linNs.toFixed(3) + ' | ' + perNs.toFixed(3) + ' |');
}
console.log('');
console.log('inversions=0 means the curve preserves exact same-layer paint order at ' +
  '26-bit depth; ties are order-lost pairs the tie-break (stable sort / draw index) must carry.');
