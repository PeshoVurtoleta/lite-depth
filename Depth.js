/**
 * @zakkster/lite-depth -- Zero-GC Canvas2D software-projected 3D (v1.5.0 "Painter")
 *
 * Zdog's niche — flat-shaded, painter-sorted, stroke-friendly pseudo-3D on a 2D
 * canvas — but arena-backed and allocation-free on the frame loop. Zdog allocates
 * a Vector per point per frame; lite-depth allocates zero bytes per frame.
 *
 * Pipeline per stage.frame(dt):
 *   transform -> project(+cull) -> collect faces -> radix sort -> paint
 *
 * Substrate deps (runtime): @zakkster/lite-arena  (node store, generational handles)
 *                           @zakkster/lite-fastbit32 (flag namespace + masks)
 *                           @zakkster/lite-aabb    (packed node-box lane + scene-bbox merge)
 * Optional peers (cold path only): @zakkster/lite-signal via stage.useSignals().
 *
 * @author Zahary Shinikchiev
 * @license MIT
 */

import { Arena } from '@zakkster/lite-arena';
import { BitMapper } from '@zakkster/lite-fastbit32';
import { aabb2, FORMAT_VERSION } from '@zakkster/lite-aabb';

// Re-export the peer's packed-format contract version so a consumer can compare
// it against its own lite-aabb (the nodeBox lane + scene-bbox merge depend on the
// [minX,minY,maxX,maxY] float32x4 layout being format 1). createStage asserts it.
export { FORMAT_VERSION };

/* ─────────────────────────────── constants ─────────────────────────────── */

export const TAU = Math.PI * 2;
const DEPTH_BITS = 26;               // 26-bit quantized depth key
const DEPTH_MAX = (1 << DEPTH_BITS) - 1;
const LAYER_SHIFT = DEPTH_BITS;      // layer occupies the high 6 bits (0..63)

// Flag namespace via lite-fastbit32 BitMapper (cold). Per-node bits live in a
// Uint32Array lane and are tested inline on the hot path.
export const FLAGS = new BitMapper([
  'VISIBLE', 'PICKABLE', 'DIRTY', 'NON_UNIFORM_SCALE',
  'BILLBOARD', 'CAST_SHADOW', 'DOUBLE_SIDED', 'STROKE',
]);
const F_VISIBLE = 1 << FLAGS.get('VISIBLE');
const F_DIRTY = 1 << FLAGS.get('DIRTY');
const F_DOUBLE = 1 << FLAGS.get('DOUBLE_SIDED');
const F_STROKE = 1 << FLAGS.get('STROKE');
const F_NONUNIF = 1 << FLAGS.get('NON_UNIFORM_SCALE');

/* ───────────────────────── math kernels (out-param) ─────────────────────── */
// No Vec3/Mat4 classes. Everything writes into caller buffers; module-level
// scratch registers below. Matrices are affine 3x4, row-major: [m0..m11].

const _LOC = new Float64Array(12);   // scratch: local matrix
const _CEN = new Float64Array(3);    // scratch: view-space node centre
const _NM = new Float64Array(9);     // scratch: per-node normal matrix (row-major) for the non-uniform shade path

// Compose a local 3x4 from translation/quaternion/scale into out.
function composeTRS(out, tx, ty, tz, qx, qy, qz, qw, sx, sy, sz) {
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  out[0] = (1 - 2 * (yy + zz)) * sx; out[1] = (2 * (xy - wz)) * sy; out[2] = (2 * (xz + wy)) * sz; out[3] = tx;
  out[4] = (2 * (xy + wz)) * sx; out[5] = (1 - 2 * (xx + zz)) * sy; out[6] = (2 * (yz - wx)) * sz; out[7] = ty;
  out[8] = (2 * (xz - wy)) * sx; out[9] = (2 * (yz + wx)) * sy; out[10] = (1 - 2 * (xx + yy)) * sz; out[11] = tz;
}

// out(3x4) = A(3x4) * B(3x4), implicit 4th row [0 0 0 1]. out must not alias A or B.
function mulAffine(out, A, B) {
  const a0 = A[0], a1 = A[1], a2 = A[2], a3 = A[3];
  const a4 = A[4], a5 = A[5], a6 = A[6], a7 = A[7];
  const a8 = A[8], a9 = A[9], a10 = A[10], a11 = A[11];
  out[0] = a0 * B[0] + a1 * B[4] + a2 * B[8];
  out[1] = a0 * B[1] + a1 * B[5] + a2 * B[9];
  out[2] = a0 * B[2] + a1 * B[6] + a2 * B[10];
  out[3] = a0 * B[3] + a1 * B[7] + a2 * B[11] + a3;
  out[4] = a4 * B[0] + a5 * B[4] + a6 * B[8];
  out[5] = a4 * B[1] + a5 * B[5] + a6 * B[9];
  out[6] = a4 * B[2] + a5 * B[6] + a6 * B[10];
  out[7] = a4 * B[3] + a5 * B[7] + a6 * B[11] + a7;
  out[8] = a8 * B[0] + a9 * B[4] + a10 * B[8];
  out[9] = a8 * B[1] + a9 * B[5] + a10 * B[9];
  out[10] = a8 * B[2] + a9 * B[6] + a10 * B[10];
  out[11] = a8 * B[3] + a9 * B[7] + a10 * B[11] + a11;
}

// Rotate a unit vector by a quaternion into out (used for face normals; assumes
// uniform scale so direction is preserved).
function quatRotate(out, qx, qy, qz, qw, vx, vy, vz) {
  // t = 2 * cross(q.xyz, v); out = v + q.w*t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
}

export const mathKernels = { composeTRS, mulAffine, quatRotate };

// Round an f64 screen bound OUTWARD to a conservative f32 for the node-box lane:
// nudge by ~one f32 ULP (2^-23 relative) in `dir` (-1 for a min side, +1 for a
// max side) so the stored f32 box never clips the true f64 box. Used only under
// the opt-in dirtyRect lane (never on the default hot path). Zero allocation.
const F32_ULP = 1.1920929e-7;
function froundOut(x, dir) {
  const f = Math.fround(x);
  return f + dir * ((f < 0 ? -f : f) * F32_ULP + 1e-30);
}

/* ─────────────────────────────── geometry ──────────────────────────────── */
// A geometry is shared and instanced per node. Vertices are Float32 (read-only
// on the hot path; memory density). Faces are convex polygons (quads/n-gons
// first-class). faceNormal is precomputed local-space (Float32).

function buildGeometry(verts, faces, kind) {
  const V = verts.length / 3;
  const F = faces.length;
  const faceVertOffset = new Uint32Array(F + 1);
  let total = 0;
  for (let i = 0; i < F; i++) { faceVertOffset[i] = total; total += faces[i].length; }
  faceVertOffset[F] = total;
  const faceVerts = new Uint32Array(total);
  let c = 0;
  for (let i = 0; i < F; i++) { const f = faces[i]; for (let j = 0; j < f.length; j++) faceVerts[c++] = f[j]; }

  const fverts = new Float32Array(verts);
  const faceNormal = new Float32Array(3 * F);
  // Newell's method per face -> robust normal for convex n-gons.
  for (let i = 0; i < F; i++) {
    const off = faceVertOffset[i], n = faceVertOffset[i + 1] - off;
    let nx = 0, ny = 0, nz = 0;
    for (let j = 0; j < n; j++) {
      const a = faceVerts[off + j] * 3, b = faceVerts[off + ((j + 1) % n)] * 3;
      const ax = fverts[a], ay = fverts[a + 1], az = fverts[a + 2];
      const bx = fverts[b], by = fverts[b + 1], bz = fverts[b + 2];
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
    faceNormal[i * 3] = nx * inv; faceNormal[i * 3 + 1] = ny * inv; faceNormal[i * 3 + 2] = nz * inv;
  }

  // bounding radius (cold) for cheap per-node frustum reject
  let r2 = 0;
  for (let i = 0; i < V; i++) {
    const x = fverts[i * 3], y = fverts[i * 3 + 1], z = fverts[i * 3 + 2];
    const d = x * x + y * y + z * z; if (d > r2) r2 = d;
  }
  const k = kind || 'fill';
  // drawSlots = draw-list entries this geometry emits per visible node. A fill
  // writes one entry per face (F); a stroke has F === 0 but writes exactly ONE
  // whole-polyline entry. The overflow door reserves against this, not F, so a
  // stroke cannot slip a write past a full draw list. Fill: drawSlots === F.
  return { V, F, drawSlots: k === 'stroke' ? 1 : F, verts: fverts, faceVertOffset, faceVerts, faceNormal, radius: Math.sqrt(r2), kind: k };
}

export const geometry = {
  custom: (verts, faces) => buildGeometry(verts, faces, 'fill'),

  box(w = 1, h = 1, d = 1) {
    const x = w / 2, y = h / 2, z = d / 2;
    const v = [-x, -y, z, x, -y, z, x, y, z, -x, y, z, -x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z];
    const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
    return buildGeometry(v, f, 'fill');
  },

  plane(w = 1, d = 1) {
    const x = w / 2, z = d / 2;
    return buildGeometry([-x, 0, z, x, 0, z, x, 0, -z, -x, 0, -z], [[0, 1, 2, 3]], 'fill');
  },

  sphere(radius = 0.5, segU = 12, segV = 8) {
    const v = [], f = [];
    for (let iv = 0; iv <= segV; iv++) {
      const phi = Math.PI * iv / segV, sp = Math.sin(phi), cp = Math.cos(phi);
      for (let iu = 0; iu <= segU; iu++) {
        const th = TAU * iu / segU;
        v.push(radius * sp * Math.cos(th), radius * cp, radius * sp * Math.sin(th));
      }
    }
    const row = segU + 1;
    for (let iv = 0; iv < segV; iv++) for (let iu = 0; iu < segU; iu++) {
      const a = iv * row + iu, b = a + row;
      if (iv === 0) f.push([a, b + 1, b]);
      else if (iv === segV - 1) f.push([a, a + 1, b]);
      else f.push([a, a + 1, b + 1, b]);
    }
    return buildGeometry(v, f, 'fill');
  },

  cylinder(radius = 0.5, height = 1, seg = 16) {
    const v = [], f = [], y = height / 2;
    for (let i = 0; i < seg; i++) {
      const th = TAU * i / seg, cx = radius * Math.cos(th), cz = radius * Math.sin(th);
      v.push(cx, y, cz, cx, -y, cz);
    }
    const top = v.length / 3; v.push(0, y, 0);
    const bot = v.length / 3; v.push(0, -y, 0);
    for (let i = 0; i < seg; i++) {
      const a = i * 2, b = ((i + 1) % seg) * 2;
      f.push([a, b, b + 1, a + 1]);       // side quad
      f.push([top, b, a]);                 // top fan
      f.push([bot, a + 1, b + 1]);         // bottom fan
    }
    return buildGeometry(v, f, 'fill');
  },

  cone(radius = 0.5, height = 1, seg = 16) {
    const v = [], f = [], y = height / 2;
    for (let i = 0; i < seg; i++) { const th = TAU * i / seg; v.push(radius * Math.cos(th), -y, radius * Math.sin(th)); }
    const apex = v.length / 3; v.push(0, y, 0);
    const base = v.length / 3; v.push(0, -y, 0);
    for (let i = 0; i < seg; i++) { const a = i, b = (i + 1) % seg; f.push([apex, a, b]); f.push([base, b, a]); }
    return buildGeometry(v, f, 'fill');
  },

  // Stroked 3D path. Faces list is empty; painted as one polyline at whole-line
  // depth (per-segment depth is a v1.x refinement).
  polyline(points) {
    const g = buildGeometry(points, [], 'stroke');
    return g;
  },
};

/* ─────────────────────────────── material ──────────────────────────────── */
// fillStyle strings allocate when built per frame. Every material pre-bakes a
// K-step hex ramp at creation; per-frame shading is a single LUT index.

function hex2(n) { n = n < 0 ? 0 : n > 255 ? 255 : n | 0; return (n < 16 ? '0' : '') + n.toString(16); }

export function material(opts) {
  const K = opts.steps || 64;
  // The per-frame shade lane (shadeL) is a Uint8Array: the baked LUT index must
  // fit in 0..255, so K is capped at 256 (index range 0..K-1 = 0..255). A longer
  // ramp would silently wrap the index to 0 (the darkest step) on the hot path --
  // fail closed here, at creation, rather than mis-shade every frame.
  if (K > 256) throw new Error('lite-depth: material steps=' + K + ' exceeds the 256-step shade-lane cap (shadeL is Uint8) -- did you mean steps: 256?');
  const r = opts.r ?? 90, g = opts.g ?? 200, b = opts.b ?? 120;
  const ambient = opts.ambient ?? 0.35;
  const lut = new Array(K);
  for (let i = 0; i < K; i++) {
    const t = ambient + (1 - ambient) * (i / (K - 1));
    lut[i] = '#' + hex2(r * t) + hex2(g * t) + hex2(b * t);
  }
  return {
    lut, K,
    stroke: opts.stroke || null,
    lineWidth: opts.lineWidth || 2,
    fill: opts.fill !== false,
  };
}

// Optional lite-hueforge / lite-color-engine ramp bridge (cold path).
export function materialFromRamp(hexRamp, opts) {
  const K = hexRamp.length;
  // Same Uint8 shade-lane cap as material(): a ramp longer than 256 stops cannot
  // be indexed by the shade lane. Fail closed rather than silently truncate.
  if (K > 256) throw new Error('lite-depth: materialFromRamp ramp length ' + K + ' exceeds the 256-step shade-lane cap (shadeL is Uint8) -- trim the ramp to <=256 stops.');
  const m = { lut: hexRamp.slice(), K, stroke: (opts && opts.stroke) || null, lineWidth: (opts && opts.lineWidth) || 2, fill: !(opts && opts.fill === false) };
  return m;
}

/* ─────────────────────────────── camera ────────────────────────────────── */

export function createCamera(opts) {
  const o = opts || {};
  return {
    view: new Float64Array(12),        // world -> view (3x4)
    fov: o.fov ?? 0.9,
    near: o.near ?? 0.1,
    far: o.far ?? 100,
    ortho: !!o.ortho,
    orthoScale: o.orthoScale ?? 4,
    // orbit params (spherical). Interaction lives outside core (see roadmap #3).
    tx: o.targetX ?? 0, ty: o.targetY ?? 0, tz: o.targetZ ?? 0,
    theta: o.theta ?? 0.6, phi: o.phi ?? 1.1, radius: o.radius ?? 6,
  };
}

// Build the world->view affine from orbit params (cold; call on camera move).
export function updateCamera(cam) {
  const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
  const ex = cam.tx + cam.radius * sp * Math.sin(cam.theta);
  const ey = cam.ty + cam.radius * cp;
  const ez = cam.tz + cam.radius * sp * Math.cos(cam.theta);
  // forward = normalize(target - eye) ; but view looks down -z, so z-axis = eye->target reversed
  let zx = ex - cam.tx, zy = ey - cam.ty, zz = ez - cam.tz;       // camera +z points back toward eye
  let inv = 1 / (Math.hypot(zx, zy, zz) || 1); zx *= inv; zy *= inv; zz *= inv;
  // right = normalize(cross(up, z)), up0 = (0,1,0)
  let xx = 1 * zz - 0 * zy, xy = 0 * zx - 0 * zz, xz = 0 * zy - 1 * zx;
  inv = 1 / (Math.hypot(xx, xy, xz) || 1); xx *= inv; xy *= inv; xz *= inv;
  // trueUp = cross(z, x)
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const V = cam.view;
  // view = R^T with translation -R^T*eye. Rows are the camera basis vectors.
  V[0] = xx; V[1] = xy; V[2] = xz; V[3] = -(xx * ex + xy * ey + xz * ez);
  V[4] = yx; V[5] = yy; V[6] = yz; V[7] = -(yx * ex + yy * ey + yz * ez);
  V[8] = zx; V[9] = zy; V[10] = zz; V[11] = -(zx * ex + zy * ey + zz * ez);
}

/* ─────────────────────────────── stage ─────────────────────────────────── */

export function createStage(ctx, opts) {
  // Fail closed if the peer's packed AABB layout ever drifts underneath us: the
  // per-node screen box lane (nodeBox) and the once-per-frame scene-bbox merge
  // both assume the [minX,minY,maxX,maxY] float32x4 format (FORMAT_VERSION 1).
  if (FORMAT_VERSION !== 1) {
    throw new Error('lite-depth: @zakkster/lite-aabb FORMAT_VERSION=' + FORMAT_VERSION +
      ' but lite-depth is built against packed format 1 ([minX,minY,maxX,maxY]). ' +
      'The nodeBox cull + scene-bbox merge assume that layout -- upgrade lite-depth.');
  }
  const o = opts || {};
  let maxNodes = o.maxNodes || 4096;
  const maxVerts = o.maxVerts || 262144;      // total projected verts per frame
  const maxDrawFaces = o.maxDrawFaces || 131072;

  const arena = new Arena(maxNodes);
  // One SoA component holding every per-node lane. Swap-and-pop on despawn
  // keeps these dense arrays contiguous automatically.
  const nodes = arena.registerComponent({
    px: Float64Array, py: Float64Array, pz: Float64Array,
    qx: Float64Array, qy: Float64Array, qz: Float64Array, qw: Float64Array,
    sx: Float64Array, sy: Float64Array, sz: Float64Array,
    m0: Float64Array, m1: Float64Array, m2: Float64Array, m3: Float64Array,
    m4: Float64Array, m5: Float64Array, m6: Float64Array, m7: Float64Array,
    m8: Float64Array, m9: Float64Array, m10: Float64Array, m11: Float64Array,
    parent: Int32Array,       // parent entity handle (0 = root)
    geom: Int32Array,         // geometry id
    mat: Int32Array,          // material id
    flags: Uint32Array,       // lite-fastbit32 layout
    layer: Uint8Array,        // 0..63 painter layer
    bias: Float64Array,       // depth bias (view-space units)
  });

  // cold registries
  const geometries = [];
  const materials = [];

  // frame arena (pre-allocated; Float64 hot output, Float32 aabb)
  const screenXY = new Float64Array(2 * maxVerts);
  const viewZ = new Float64Array(maxVerts);
  let vertBase = new Int32Array(maxNodes);       // per dense-node projected vert base (this frame)
  const drawKey = new Uint32Array(maxDrawFaces);
  const drawNode = new Uint32Array(maxDrawFaces); // dense node index
  const drawFace = new Uint32Array(maxDrawFaces);
  const shadeL = new Uint8Array(maxDrawFaces);    // per-draw-entry baked LUT index (shade computed in collect)

  // radix scratch (LSD, 4x8-bit)
  const orderA = new Uint32Array(maxDrawFaces);
  const orderB = new Uint32Array(maxDrawFaces);
  const hist = new Uint32Array(256);

  // read-only observation handles over the sorted draw list. Backing vars are
  // re-pointed at whichever ping-pong buffer holds the final permutation each
  // frame -- NO per-frame allocation. Exposed via getters (no setter) so nothing
  // can mutate the handle; D3 will re-lane these later.
  let _pubOrder = orderA;
  let _pubDrawCount = 0;

  // Structural-mutation epoch (Uint32, wrapping). Bumped by addNode / remove /
  // setParent / clear -- the single invalidation signal for every dense-index
  // cache in the package (Motion.js) and for any downstream consumer. Cold path
  // only; frame() never writes it.
  let _structureEpoch = 0;

  // topo scratch (O(n) rebuild: memoized depth + counting sort by depth)
  let topo = new Uint32Array(maxNodes);           // dense indices, parent-before-child
  let parentDense = new Int32Array(maxNodes);     // -1 root, else dense idx (valid per frame)
  let recomputed = new Uint8Array(maxNodes);
  let depthArr = new Int32Array(maxNodes);
  let stackArr = new Uint32Array(maxNodes);
  let levelOff = new Uint32Array(maxNodes);
  // Per-node WORLD non-uniform bit, propagated in topo order in the transform
  // pass: 1 iff this node's composed world upper-3x3 is NOT a similarity (own
  // local non-uniform scale OR any non-uniform ancestor). F_NONUNIF is a static
  // LOCAL flag; this lane is the dynamic world property the shade branch gates on.
  let worldNonUnif = new Uint8Array(maxNodes);

  // Per-node screen-space AABB lane + scene-bbox scratch (lite-aabb packed format).
  // nodeBox[4d..4d+3] = dense node d's front-of-near screen box THIS frame (written
  // only under the opt-in dirtyRect lane); _sceneBox is their union, _prevBox the
  // previous frame's union for a redraw delta. Grown in lockstep by reserve().
  let nodeBox = new Float32Array(4 * maxNodes);
  const _sceneBox = aabb2.setEmpty(aabb2.create());
  const _prevBox = aabb2.setEmpty(aabb2.create());
  // Cached viewport cull scalars (was the _viewport box; the per-face intersects is
  // now four inline compares). Viewport is (0,0,width,height) -- the screen space
  // screenXY is computed in. Refreshed at create + resize (cold).
  let _vx0 = 0, _vy0 = 0, _vx1 = 0, _vy1 = 0;

  const stage = {
    ctx, arena, nodes, camera: createCamera(o.camera),
    width: o.width || 800, height: o.height || 600, dpr: o.dpr || 1,
    light: new Float64Array([0.4, 0.8, 0.5]),   // normalized below
    view2d: null,                                // optional external 2D transform (lite-camera)
    // Opt-in dirty-rect lane. OFF by default: when false the frame body writes no
    // nodeBox slot and runs no scene-bbox merge -- zero added hot cost. Set true to
    // maintain sceneBox/prevBox for incremental canvas redraw. The per-node screen
    // AABB *cull* is always on and independent of this flag.
    dirtyRect: false,
    _signals: null,
    stats: { facesDrawn: 0, facesCulled: 0, nodesCulled: 0, drawCalls: 0, tTransform: 0, tProject: 0, tSort: 0, tPaint: 0, facesOverflowed: 0, nodesInvalid: 0, nodesNonUniform: 0, nodesOrphaned: 0, nodesTotal: 0 },
    _topoDirty: true,
    // read-only views of the current draw ordering (observation handles only).
    // Accessors declared in the literal so they are part of the stage's initial
    // hidden class -- defining them later via Object.defineProperty would push the
    // object toward dictionary mode and deopt every stage.* read on the hot path.
    get _order() { return _pubOrder; },
    get _drawCount() { return _pubDrawCount; },
    // read-only structural epoch + remaining capacity. Declared in the literal so
    // they belong to the stage's initial hidden class (same reason as above).
    get structureEpoch() { return _structureEpoch; },
    get remainingNodes() { return arena.remainingCapacity(); },
    // Read-only scene bounding box (union of this frame's drawn node boxes) and
    // the previous frame's, for an opt-in redraw delta. Both are the canonical
    // empty box until dirtyRect is enabled and a frame runs. Getters live in the
    // literal so they belong to the stage's initial hidden class (same reason as
    // the draw-order accessors above).
    get sceneBox() { return _sceneBox; },
    get prevSceneBox() { return _prevBox; },
  };
  stage._draw = { key: drawKey, node: drawNode, face: drawFace, vertBase, viewZ, screenXY };
  stage._geometries = geometries;
  { const l = stage.light, inv = 1 / (Math.hypot(l[0], l[1], l[2]) || 1); l[0] *= inv; l[1] *= inv; l[2] *= inv; }
  _vx0 = 0; _vy0 = 0; _vx1 = stage.width; _vy1 = stage.height;
  updateCamera(stage.camera);

  /* ── cold node API ── */
  stage.geometry = (g) => { geometries.push(g); return geometries.length - 1; };
  stage.material = (m) => { materials.push(m); return materials.length - 1; };

  stage.addNode = (geomId, matId, init) => {
    const h = arena.spawn();
    const d = nodes.add(h);
    const D = nodes.data;
    D.px[d] = 0; D.py[d] = 0; D.pz[d] = 0;
    D.qx[d] = 0; D.qy[d] = 0; D.qz[d] = 0; D.qw[d] = 1;
    D.sx[d] = 1; D.sy[d] = 1; D.sz[d] = 1;
    D.parent[d] = 0; D.geom[d] = geomId; D.mat[d] = matId;
    D.flags[d] = F_VISIBLE | F_DIRTY | (geometries[geomId].kind === 'stroke' ? F_STROKE : 0);
    D.layer[d] = 0; D.bias[d] = 0;
    if (init) {
      if (init.x !== undefined) D.px[d] = init.x;
      if (init.y !== undefined) D.py[d] = init.y;
      if (init.z !== undefined) D.pz[d] = init.z;
      if (init.layer !== undefined) D.layer[d] = init.layer;
      if (init.parent) D.parent[d] = init.parent;
    }
    stage._topoDirty = true;
    _structureEpoch = (_structureEpoch + 1) >>> 0;
    return h;
  };

  stage.setPosition = (h, x, y, z) => { const d = nodes.idx(h), D = nodes.data; D.px[d] = x; D.py[d] = y; D.pz[d] = z; D.flags[d] |= F_DIRTY; };
  stage.setScale = (h, x, y, z) => {
    const d = nodes.idx(h), D = nodes.data; D.sx[d] = x; D.sy[d] = y === undefined ? x : y; D.sz[d] = z === undefined ? x : z;
    D.flags[d] |= F_DIRTY;
    if (x === D.sy[d] && x === D.sz[d]) D.flags[d] &= ~F_NONUNIF; else D.flags[d] |= F_NONUNIF;
  };
  stage.setQuaternion = (h, x, y, z, w) => { const d = nodes.idx(h), D = nodes.data; D.qx[d] = x; D.qy[d] = y; D.qz[d] = z; D.qw[d] = w; D.flags[d] |= F_DIRTY; };
  stage.setEuler = (h, ex, ey, ez) => {
    const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2), cy = Math.cos(ey / 2), sy = Math.sin(ey / 2), cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
    const d = nodes.idx(h), D = nodes.data;
    D.qw[d] = cx * cy * cz + sx * sy * sz; D.qx[d] = sx * cy * cz - cx * sy * sz;
    D.qy[d] = cx * sy * cz + sx * cy * sz; D.qz[d] = cx * cy * sz - sx * sy * cz;
    D.flags[d] |= F_DIRTY;
  };
  stage.setParent = (h, parentHandle) => { const d = nodes.idx(h); nodes.data.parent[d] = parentHandle || 0; nodes.data.flags[d] |= F_DIRTY; stage._topoDirty = true; _structureEpoch = (_structureEpoch + 1) >>> 0; };
  stage.setLayer = (h, layer) => { nodes.data.layer[nodes.idx(h)] = layer & 63; };
  stage.setDepthBias = (h, bias) => { nodes.data.bias[nodes.idx(h)] = bias; };
  stage.setVisible = (h, v) => { const d = nodes.idx(h), D = nodes.data; if (v) D.flags[d] |= F_VISIBLE; else D.flags[d] &= ~F_VISIBLE; };
  stage.remove = (h) => { arena.despawn(h); stage._topoDirty = true; _structureEpoch = (_structureEpoch + 1) >>> 0; };
  stage.resize = (w, hh, dpr) => { stage.width = w; stage.height = hh; stage.dpr = dpr || stage.dpr; _vx0 = 0; _vy0 = 0; _vx1 = w; _vy1 = hh; };

  // Remove every node in one cold O(capacity) pass without reallocating: the
  // arena resets its pool (advancing every generation, so every handle minted
  // before clear() is invalid afterward) and drops the component count to 0.
  // Geometries, materials, camera, frame arenas and capacity are all kept. The
  // epoch bumps so caches (Motion dense index) invalidate. Allocates nothing.
  stage.clear = () => {
    arena.clear();
    stage._topoDirty = true;
    _structureEpoch = (_structureEpoch + 1) >>> 0;
    return stage;
  };

  // Grow ALL maxNodes-sized lanes to hold `n` nodes. Cold, between frames,
  // explicit. Returns false (a defined no-op) when n <= current capacity, true
  // after a successful grow. Fails closed on a bad request: a non-integer or
  // negative n is a caller bug, thrown with a did-you-mean hint rather than
  // silently coerced. The arena grows the per-node SoA; the stage grows the
  // frame/topo scratch lanes sized by maxNodes in lockstep.
  stage.reserve = (n) => {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('lite-depth: stage.reserve(n) needs a non-negative integer node capacity, got ' +
        (typeof n === 'number' ? n : typeof n) + ' -- did you mean reserve(' + (maxNodes * 2) + ')?');
    }
    if (n <= maxNodes) return false;
    // arena.reserve grows the per-node SoA lanes (px..bias) in place; it throws
    // (fail closed) if any component is caller-backed or detached -- do not mask
    // that reason. It returns false only when n <= arena.capacity, which n>maxNodes
    // rules out here since the arena capacity tracks maxNodes.
    arena.reserve(n);
    // Grow every stage-owned maxNodes-sized lane. new-then-copy: the live prefix
    // [0, count) is preserved; the tail is fresh zero. Cold allocation is legal.
    const nv = new Int32Array(n); nv.set(vertBase); vertBase = nv; stage._draw.vertBase = nv;
    const nnb = new Float32Array(4 * n); nnb.set(nodeBox); nodeBox = nnb;  // node-box lane: 4 floats/node
    const nt = new Uint32Array(n); nt.set(topo); topo = nt;
    const npd = new Int32Array(n); npd.set(parentDense); parentDense = npd;
    const nr = new Uint8Array(n); nr.set(recomputed); recomputed = nr;
    const nda = new Int32Array(n); nda.set(depthArr); depthArr = nda;
    const ns = new Uint32Array(n); ns.set(stackArr); stackArr = ns;
    const nlo = new Uint32Array(n); nlo.set(levelOff); levelOff = nlo;
    const nwn = new Uint8Array(n); nwn.set(worldNonUnif); worldNonUnif = nwn;
    maxNodes = n;
    stage._topoDirty = true;
    _structureEpoch = (_structureEpoch + 1) >>> 0;
    return true;
  };

  /* ── cold: lite-signal DI ── */
  stage.useSignals = (api) => { stage._signals = api; return stage; };
  stage.bind = (h, channel, get) => {
    if (!stage._signals) throw new Error('lite-depth: call useSignals({ effect }) before bind()');
    const setter = channel === 'position' ? (v) => stage.setPosition(h, v[0], v[1], v[2])
      : channel === 'scale' ? (v) => stage.setScale(h, v[0], v[1], v[2])
        : channel === 'quaternion' ? (v) => stage.setQuaternion(h, v[0], v[1], v[2], v[3])
          : null;
    if (!setter) throw new Error('lite-depth: unknown bind channel ' + channel);
    stage._signals.effect(() => setter(get()));   // cold effect; writes lanes + marks dirty
  };

  /* ── topo rebuild (cold, on structural change) ── */
  function rebuildTopo() {
    const count = nodes.count, D = nodes.data, parentL = D.parent;
    const st = stage.stats;
    st.nodesOrphaned = 0;
    // resolve parent handles -> dense indices GENERATIONALLY (valid until the next
    // structural change). has() validates liveness AND membership, so a despawned
    // parent whose slot was reissued no longer resolves to the stranger now in that
    // slot: it falls back to ROOT and is counted, fail-closed and visible. The
    // handle layout stays opaque -- no hand decomposition.
    for (let d = 0; d < count; d++) {
      const ph = parentL[d];
      if (ph === 0) { parentDense[d] = -1; }
      else if (nodes.has(ph)) { parentDense[d] = nodes.idx(ph); }
      else {
        // dead/recycled parent -> ROOT. The parentage just changed, so mark the
        // node dirty (same mechanism setParent uses): frame()'s transform pass
        // only recomposes on F_DIRTY or a recomputed parent, so a child already
        // warm-computed under the now-dead parent would otherwise stay pinned to
        // its stale world matrix. Marking it dirty recomposes it as a root this
        // frame; the existing topo-order propagation (recomputed[pd]===1) then
        // re-dirties its subtree. Cold path, no allocation.
        parentDense[d] = -1; st.nodesOrphaned++; D.flags[d] |= F_DIRTY;
      }
    }
    // memoized depth: each node's depth assigned exactly once -> O(n).
    for (let d = 0; d < count; d++) depthArr[d] = -1;
    let maxD = 0;
    for (let d = 0; d < count; d++) {
      if (depthArr[d] >= 0) continue;
      let sp = 0, cur = d, guard = 0;
      while (cur >= 0 && depthArr[cur] < 0) {
        stackArr[sp++] = cur;
        const nx = parentDense[cur];
        // A parent chain longer than `count` cannot be a tree -- it is a cycle.
        // Fail closed: name both nodes in the loop rather than silently treating
        // it as a root and truncating (or spinning forever).
        if (++guard > count) {
          throw new Error('lite-depth: parent cycle detected -- node index ' + cur +
            ' and node index ' + nx + ' form a loop (a->b->...->a). setParent created ' +
            'a cyclic hierarchy; break it before frame().');
        }
        cur = nx;
      }
      let base = cur < 0 ? -1 : depthArr[cur];
      while (sp > 0) { const n = stackArr[--sp]; base += 1; depthArr[n] = base; if (base > maxD) maxD = base; }
    }
    // counting sort by depth -> parents strictly before children.
    for (let i = 0; i <= maxD; i++) levelOff[i] = 0;
    for (let d = 0; d < count; d++) levelOff[depthArr[d]]++;
    let acc = 0; for (let i = 0; i <= maxD; i++) { const c = levelOff[i]; levelOff[i] = acc; acc += c; }
    for (let d = 0; d < count; d++) { const dp = depthArr[d]; topo[levelOff[dp]++] = d; }
    stage._topoDirty = false;
  }

  /* ── hot: frame ── */
  const clock = (typeof performance !== 'undefined' && performance.now) ? performance : Date;
  stage.frame = (dt) => {
    const D = nodes.data, count = nodes.count;
    if (stage._topoDirty) rebuildTopo();
    const st = stage.stats;
    st.facesDrawn = 0; st.facesCulled = 0; st.nodesCulled = 0; st.drawCalls = 0;
    // Observability hooks. Integer stores OUTSIDE both hot loops: nodesTotal is
    // the live node count; facesOverflowed is reset here and fires per NODE in the
    // collect pass (the overflow door); nodesInvalid is reset here and now fires
    // per NODE in the collect fail-closed door (a NaN pose lane -> whole-node
    // reject); nodesNonUniform is reset here and fires per FLAGGED node when the
    // inverse-transpose shade path is taken. nodesOrphaned is owned by rebuildTopo
    // (reset + counted there), so it is NOT touched here -- it must survive frames
    // on which topo was not rebuilt.
    st.facesOverflowed = 0; st.nodesInvalid = 0; st.nodesNonUniform = 0; st.nodesTotal = count;

    // cache lane refs (monomorphic locals)
    const px = D.px, py = D.py, pz = D.pz, qx = D.qx, qy = D.qy, qz = D.qz, qw = D.qw, sx = D.sx, sy = D.sy, sz = D.sz;
    const m0 = D.m0, m1 = D.m1, m2 = D.m2, m3 = D.m3, m4 = D.m4, m5 = D.m5, m6 = D.m6, m7 = D.m7, m8 = D.m8, m9 = D.m9, m10 = D.m10, m11 = D.m11;
    const flags = D.flags, geomL = D.geom, matL = D.mat, layerL = D.layer, biasL = D.bias;

    /* transform: recompute world 3x4 for dirty subtrees (topo order) */
    let t = clock.now();
    for (let i = 0; i < count; i++) {
      const d = topo[i], pd = parentDense[d];
      const dirty = (flags[d] & F_DIRTY) !== 0 || (pd >= 0 && recomputed[pd] === 1);
      if (!dirty) { recomputed[d] = 0; continue; }
      composeTRS(_LOC, px[d], py[d], pz[d], qx[d], qy[d], qz[d], qw[d], sx[d], sy[d], sz[d]);
      if (pd < 0) {
        m0[d] = _LOC[0]; m1[d] = _LOC[1]; m2[d] = _LOC[2]; m3[d] = _LOC[3];
        m4[d] = _LOC[4]; m5[d] = _LOC[5]; m6[d] = _LOC[6]; m7[d] = _LOC[7];
        m8[d] = _LOC[8]; m9[d] = _LOC[9]; m10[d] = _LOC[10]; m11[d] = _LOC[11];
      } else {
        // world = parentWorld * local  (inline mulAffine, reading parent lanes)
        const A0 = m0[pd], A1 = m1[pd], A2 = m2[pd], A3 = m3[pd], A4 = m4[pd], A5 = m5[pd], A6 = m6[pd], A7 = m7[pd], A8 = m8[pd], A9 = m9[pd], A10 = m10[pd], A11 = m11[pd];
        m0[d] = A0 * _LOC[0] + A1 * _LOC[4] + A2 * _LOC[8];
        m1[d] = A0 * _LOC[1] + A1 * _LOC[5] + A2 * _LOC[9];
        m2[d] = A0 * _LOC[2] + A1 * _LOC[6] + A2 * _LOC[10];
        m3[d] = A0 * _LOC[3] + A1 * _LOC[7] + A2 * _LOC[11] + A3;
        m4[d] = A4 * _LOC[0] + A5 * _LOC[4] + A6 * _LOC[8];
        m5[d] = A4 * _LOC[1] + A5 * _LOC[5] + A6 * _LOC[9];
        m6[d] = A4 * _LOC[2] + A5 * _LOC[6] + A6 * _LOC[10];
        m7[d] = A4 * _LOC[3] + A5 * _LOC[7] + A6 * _LOC[11] + A7;
        m8[d] = A8 * _LOC[0] + A9 * _LOC[4] + A10 * _LOC[8];
        m9[d] = A8 * _LOC[1] + A9 * _LOC[5] + A10 * _LOC[9];
        m10[d] = A8 * _LOC[2] + A9 * _LOC[6] + A10 * _LOC[10];
        m11[d] = A8 * _LOC[3] + A9 * _LOC[7] + A10 * _LOC[11] + A11;
      }
      // Propagate the WORLD non-uniform bit in topo order (parent already done):
      // own local F_NONUNIF taints this node, and ANY non-uniform ancestor taints
      // it too (the composed basis is no longer a similarity). Rotation is a
      // similarity, so a rotated-only ancestor does NOT taint. O(1), 0 alloc.
      worldNonUnif[d] = (((flags[d] & F_NONUNIF) !== 0) ? 1 : 0) | (pd >= 0 ? worldNonUnif[pd] : 0);
      flags[d] &= ~F_DIRTY; recomputed[d] = 1;
    }
    st.tTransform = clock.now() - t;

    /* project + collect */
    t = clock.now();
    const cam = stage.camera, V = cam.view;
    const near = cam.near, far = cam.far;
    const halfW = stage.width * 0.5, halfH = stage.height * 0.5;
    const ortho = cam.ortho;   // orthographic projection lives on the camera, not the stage
    const focal = ortho ? 0 : (0.5 * Math.min(stage.width, stage.height)) / Math.tan(cam.fov * 0.5);
    const orthoK = (Math.min(stage.width, stage.height) * 0.5) / cam.orthoScale;
    const zSpan = (far - near) || 1;         // positive span; maps viewZ [-far,-near] -> [0, DEPTH_MAX]
    // directional light, hoisted once above the node loop. Shade is now baked into
    // the shadeL lane in this pass (per node: back-rotate the light through the
    // WORLD upper-3x3; per face: one dot). paint() no longer touches the light.
    const light = stage.light, lgx = light[0], lgy = light[1], lgz = light[2];
    // Cached viewport cull scalars -> frame locals. The per-face viewport test is
    // four inline compares against these (was aabb2.set + aabb2.intersects).
    const vx0 = _vx0, vy0 = _vy0, vx1 = _vx1, vy1 = _vy1;
    // Opt-in dirty-rect lane, hoisted once (a per-node read would cost bytes every
    // node). When on, seed every LIVE node's box empty so any node the loop skips
    // (invisible / invalid / overflowed / node-culled / fail-open) contributes the
    // merge identity to the scene bbox; drawn nodes overwrite their slot below.
    const wantBox = stage.dirtyRect === true;
    if (wantBox) {
      for (let d = 0; d < count; d++) { const j = d << 2; nodeBox[j] = Infinity; nodeBox[j + 1] = Infinity; nodeBox[j + 2] = -Infinity; nodeBox[j + 3] = -Infinity; }
    }
    let vc = 0, dc = 0;

    for (let i = 0; i < count; i++) {
      const d = topo[i];
      if ((flags[d] & F_VISIBLE) === 0) continue;
      const g = geometries[geomL[d]];

      // cheap per-node frustum reject: transform world centre to view space
      const wcx = m3[d], wcy = m7[d], wcz = m11[d];
      const cvz = V[8] * wcx + V[9] * wcy + V[10] * wcz + V[11];
      const rad = g.radius * Math.max(sx[d], sy[d], sz[d]);
      const bias = biasL[d];
      // fail-closed node door (D-06): a NaN/Infinity in any pose lane laundered
      // this far poisons the projection and (via quantize) the sort key. ONE
      // finiteness gate per NODE -- never per face -- rejects the whole node,
      // counts it, and moves on. NaN is a REJECT, not a silent far-plane paint.
      if (!(Number.isFinite(wcx) && Number.isFinite(wcy) && Number.isFinite(wcz) &&
            Number.isFinite(cvz) && Number.isFinite(rad) && Number.isFinite(bias))) {
        st.nodesInvalid++; continue;
      }
      if (cvz - rad > -near || cvz + rad < -far) { st.nodesCulled++; continue; }

      // overflow door (D-07): two integer compares per NODE, hoisted above both
      // inner loops. If this node's verts or faces would run past the frame-arena
      // budgets, skip it whole -- no partial/out-of-range write -- and count it.
      if (vc + g.V > maxVerts || dc + g.drawSlots > maxDrawFaces) { st.facesOverflowed++; continue; }

      vertBase[d] = vc;
      const gv = g.verts, GV = g.V;
      const M0 = m0[d], M1 = m1[d], M2 = m2[d], M3 = m3[d], M4 = m4[d], M5 = m5[d], M6 = m6[d], M7 = m7[d], M8 = m8[d], M9 = m9[d], M10 = m10[d], M11 = m11[d];
      // Node screen-box registers: union over FRONT-OF-NEAR verts only (see below).
      let nbMinX = Infinity, nbMinY = Infinity, nbMaxX = -Infinity, nbMaxY = -Infinity;
      for (let v = 0; v < GV; v++) {
        const lx = gv[v * 3], ly = gv[v * 3 + 1], lz = gv[v * 3 + 2];
        const wx = M0 * lx + M1 * ly + M2 * lz + M3;
        const wy = M4 * lx + M5 * ly + M6 * lz + M7;
        const wz = M8 * lx + M9 * ly + M10 * lz + M11;
        const vx = V[0] * wx + V[1] * wy + V[2] * wz + V[3];
        const vy = V[4] * wx + V[5] * wy + V[6] * wz + V[7];
        const vz = V[8] * wx + V[9] * wy + V[10] * wz + V[11];
        const idx = vc + v;
        viewZ[idx] = vz;
        let sX, sY;
        if (ortho) { sX = halfW + vx * orthoK; sY = halfH - vy * orthoK; }
        else { const inv = focal / (-vz); sX = halfW + vx * inv; sY = halfH - vy * inv; }
        screenXY[idx * 2] = sX; screenXY[idx * 2 + 1] = sY;
        // Accumulate the node's screen box over FRONT-OF-NEAR verts ONLY (z<=-near).
        // A behind-near vert projects to +/-Infinity/garbage; folding it in would
        // poison the box and wrongly drop a visible node -- so it is excluded here
        // and the node-box door below fails OPEN on an empty/non-finite box.
        if (vz <= -near) {
          if (sX < nbMinX) nbMinX = sX; if (sX > nbMaxX) nbMaxX = sX;
          if (sY < nbMinY) nbMinY = sY; if (sY > nbMaxY) nbMaxY = sY;
        }
      }
      vc += GV;

      if ((flags[d] & F_STROKE) !== 0) {
        // Strokes are NOT node-box-culled: a polyline may cross the viewport
        // between two off-screen endpoints, so v1.4.0 stroke behaviour is kept.
        // Still feed the dirty-rect lane when a valid box exists.
        if (wantBox && nbMinX <= nbMaxX && nbMinY <= nbMaxY) {
          const j = d << 2;
          nodeBox[j] = froundOut(nbMinX, -1); nodeBox[j + 1] = froundOut(nbMinY, -1);
          nodeBox[j + 2] = froundOut(nbMaxX, 1); nodeBox[j + 3] = froundOut(nbMaxY, 1);
        }
        // one draw entry for the whole polyline at its centre depth
        drawKey[dc] = packKey(layerL[d], quantize(cvz + bias, near, far, zSpan));
        drawNode[dc] = d; drawFace[dc] = 0xFFFFFFFF; dc++;
        continue;
      }

      // Per-node screen-space AABB cull (fills). Two DELIBERATELY OPPOSITE doors:
      //   node-box empty/non-finite => DRAW (fail OPEN): a wrongly-fired geometry
      //     cull LOSES PICTURE, so an unbuildable box errs toward drawing. The face
      //     loop's own per-face near cull then rejects the behind-near faces, so the
      //     facesCulled tally is byte-identical to v1.4.0 for such a node.
      //   face-bound NaN (in the face loop below) => CULL (fail CLOSED): losing a
      //     degenerate face is safe.
      // A VALID box that misses the viewport culls the whole node: nodesCulled +1
      // and the face loop runs ZERO iterations.
      if (nbMinX <= nbMaxX && nbMinY <= nbMaxY) {           // valid, non-empty, finite
        if (!(nbMinX <= vx1 && nbMaxX >= vx0 && nbMinY <= vy1 && nbMaxY >= vy0)) {
          st.nodesCulled++; continue;                        // nodeBox stays empty (pre-pass)
        }
        if (wantBox) {
          const j = d << 2;
          nodeBox[j] = froundOut(nbMinX, -1); nodeBox[j + 1] = froundOut(nbMinY, -1);
          nodeBox[j + 2] = froundOut(nbMaxX, 1); nodeBox[j + 3] = froundOut(nbMaxY, 1);
        }
      }
      // else: empty/non-finite node box -> FAIL OPEN, fall through and draw.

      // Per-node shade setup (D-03/D-04), hoisted ABOVE the face loop and computed
      // ONCE per node. Shade = clamp(dot(normalize(worldNormal), light), 0, 1),
      // where worldNormal transforms the local face normal by the node's WORLD
      // basis -- the same transform the geometry is drawn from. Two per-node paths,
      // selected by the PROPAGATED world non-uniform bit (own local scale OR any
      // non-uniform ancestor -- an inherited non-uniform basis is not a similarity
      // either), NOT the static local F_NONUNIF:
      //   - Uniform (common, tainted === 0): W = s*R is a similarity, so
      //     |W*n| = s is CONSTANT across faces. Fold it once: back-rotate the light
      //     Lb = (W^T * light) / s, and each face is a single sqrt-free dot
      //     dot(n, Lb) == dot(normalize(W*n), light).
      //   - Non-uniform (tainted !== 0, D-04): |N*n| VARIES per face, so it cannot
      //     be folded out. Build the normal matrix N = cofactor(W)/det (row-major,
      //     the same inverse-transpose gl-matrix's normalFromMat4 builds) ONCE into
      //     _NM here; each face then does N*n, normalize, dot -- the per-face sqrt
      //     is paid only by tainted nodes, never by the uniform majority.
      const matK1 = materials[matL[d]].K - 1;
      const tainted = worldNonUnif[d];   // branch selector: own OR inherited non-uniform
      let Lbx = 0, Lby = 0, Lbz = 0;
      if (tainted !== 0) {
        // Counter tracks own LOCAL non-uniform nodes (the D-04 feature / F_NONUNIF
        // flag), NOT inherited taint: a locally-uniform child under a non-uniform
        // parent is shaded via the inverse-transpose (correct) but is not itself a
        // "non-uniform node". own-flag set implies tainted, so this is a subset.
        if ((flags[d] & F_NONUNIF) !== 0) st.nodesNonUniform++;
        const C00 = M5 * M10 - M6 * M9, C01 = -(M4 * M10 - M6 * M8), C02 = M4 * M9 - M5 * M8;
        const C10 = -(M1 * M10 - M2 * M9), C11 = M0 * M10 - M2 * M8, C12 = -(M0 * M9 - M1 * M8);
        const C20 = M1 * M6 - M2 * M5, C21 = -(M0 * M6 - M2 * M4), C22 = M0 * M5 - M1 * M4;
        const det = M0 * C00 + M1 * C01 + M2 * C02;
        const invDet = det !== 0 ? 1 / det : 0;   // singular upper-3x3 -> zero normal -> ambient floor
        // N = cofactor / det (NOT transposed): N*n gives the world normal direction.
        _NM[0] = C00 * invDet; _NM[1] = C01 * invDet; _NM[2] = C02 * invDet;
        _NM[3] = C10 * invDet; _NM[4] = C11 * invDet; _NM[5] = C12 * invDet;
        _NM[6] = C20 * invDet; _NM[7] = C21 * invDet; _NM[8] = C22 * invDet;
      } else {
        const s2 = M0 * M0 + M4 * M4 + M8 * M8;
        const invS = s2 > 0 ? 1 / Math.sqrt(s2) : 1;
        Lbx = (M0 * lgx + M4 * lgy + M8 * lgz) * invS;
        Lby = (M1 * lgx + M5 * lgy + M9 * lgz) * invS;
        Lbz = (M2 * lgx + M6 * lgy + M10 * lgz) * invS;
      }

      // faces
      const base = vertBase[d], off = g.faceVertOffset, fv = g.faceVerts, F = g.F, fn = g.faceNormal;
      for (let fi = 0; fi < F; fi++) {
        const o0 = off[fi], o1 = off[fi + 1], n = o1 - o0;
        // near cull: any vertex in front of near plane
        let nearBad = false, czSum = 0;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let j = o0; j < o1; j++) {
          const vi = base + fv[j], z = viewZ[vi];
          if (z > -near) { nearBad = true; break; }
          czSum += z;
          const X = screenXY[vi * 2], Y = screenXY[vi * 2 + 1];
          if (X < minx) minx = X; if (X > maxx) maxx = X; if (Y < miny) miny = Y; if (Y > maxy) maxy = Y;
        }
        if (nearBad) { st.facesCulled++; continue; }
        // viewport cull, inline (was aabb2.set + aabb2.intersects). Byte-identical
        // to the intersects predicate against the cached viewport scalars. A NaN
        // face bound makes a compare false => the face is culled = FAIL CLOSED
        // (losing a degenerate face is safe; the inverse of the node-box door).
        if (!(minx <= vx1 && maxx >= vx0 && miny <= vy1 && maxy >= vy0)) { st.facesCulled++; continue; }
        // backface cull via screen winding (signed area), unless double-sided
        const a0 = base + fv[o0], a1 = base + fv[o0 + 1], a2 = base + fv[o0 + 2];
        const ax = screenXY[a0 * 2], ay = screenXY[a0 * 2 + 1];
        const bx = screenXY[a1 * 2], by = screenXY[a1 * 2 + 1];
        const cx2 = screenXY[a2 * 2], cy2 = screenXY[a2 * 2 + 1];
        // screen Y is flipped (y-down), which inverts polygon winding: outward
        // (front) faces read as negative signed area. Keep those; cull the rest.
        const area = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
        if (area >= 0 && (flags[d] & F_DOUBLE) === 0) { st.facesCulled++; continue; }
        const cz = czSum / n + bias;
        drawKey[dc] = packKey(layerL[d], quantize(cz, near, far, zSpan));
        drawNode[dc] = d; drawFace[dc] = fi;
        // bake the shade into the draw lane. Uniform: one sqrt-free dot with the
        // back-rotated light (which already carries the world transform). Tainted:
        // transform the local normal by the per-node normal matrix, normalize, and
        // dot with the light -- the exact normalized inverse-transpose. The branch
        // is per-node-constant (predictable); the sqrt lands only on tainted nodes.
        const nx = fn[fi * 3], ny = fn[fi * 3 + 1], nz = fn[fi * 3 + 2];
        let ndl;
        if (tainted !== 0) {
          const wx = _NM[0] * nx + _NM[1] * ny + _NM[2] * nz;
          const wy = _NM[3] * nx + _NM[4] * ny + _NM[5] * nz;
          const wz = _NM[6] * nx + _NM[7] * ny + _NM[8] * nz;
          const ln2 = wx * wx + wy * wy + wz * wz;
          if (ln2 > 0) { const invL = 1 / Math.sqrt(ln2); ndl = (wx * lgx + wy * lgy + wz * lgz) * invL; }
          else ndl = 0;
        } else {
          ndl = nx * Lbx + ny * Lby + nz * Lbz;
        }
        if (ndl < 0) ndl = 0; else if (ndl > 1) ndl = 1;
        shadeL[dc] = (ndl * matK1) | 0;
        dc++;
      }
    }
    st.tProject = clock.now() - t;

    // Opt-in scene-bbox merge (dirty-rect lane). Snapshot last frame's union into
    // _prevBox for a redraw delta, then fold THIS frame's node boxes into _sceneBox
    // once (count-bounded; skipped/culled slots are the empty merge identity, so a
    // fully-empty frame yields the canonical empty box). Off => zero added cost.
    if (wantBox) { aabb2.copy(_prevBox, _sceneBox); aabb2.mergeAll(_sceneBox, nodeBox, count); }

    /* radix sort permutation of [0,dc) by drawKey (LSD, 4x8-bit) */
    t = clock.now();
    let src = orderA, dst = orderB;
    for (let i = 0; i < dc; i++) src[i] = i;
    for (let shift = 0; shift < 32; shift += 8) {
      hist.fill(0);
      for (let i = 0; i < dc; i++) hist[(drawKey[src[i]] >>> shift) & 0xFF]++;
      let sum = 0; for (let b = 0; b < 256; b++) { const c = hist[b]; hist[b] = sum; sum += c; }
      for (let i = 0; i < dc; i++) { const k = (drawKey[src[i]] >>> shift) & 0xFF; dst[hist[k]++] = src[i]; }
      const tmp = src; src = dst; dst = tmp;
    }
    st.tSort = clock.now() - t;

    /* expose sorted draw list (cheap; used by tests + HUD) -- re-point the
       read-only backing vars, no allocation */
    _pubOrder = src; _pubDrawCount = dc;

    /* paint */
    t = clock.now();
    paint(src, dc);
    st.tPaint = clock.now() - t;
    return stage.stats;
  };

  function packKey(layer, depth) { return (((layer & 63) << LAYER_SHIFT) | (depth & DEPTH_MAX)) >>> 0; }
  function quantize(z, near, far, zSpan) {
    // z is view-space (negative), within [-far, -near]. Map the far plane -> 0
    // (painted first) and the near plane -> DEPTH_MAX (painted last, on top).
    // zSpan = far - near > 0, so t = (z + far) / zSpan rises monotonically as the
    // face approaches the camera.
    const t = (z + far) / zSpan;
    // ORDERED compares only. A NaN t is unordered and fails all three, falling to
    // the final return -- so NaN can NEVER launder into 0 (the far plane, painted
    // first, forever), the D-06 bug. It rejects to DEPTH_MAX (loud, on top) instead.
    // Finite z is byte-identical to v1.3.0: t<=0 -> 0, t>=1 -> DEPTH_MAX, else scaled.
    if (t <= 0) return 0;
    if (t >= 1) return DEPTH_MAX;
    if (t > 0) return (t * DEPTH_MAX) | 0;
    return DEPTH_MAX;
  }

  function paint(order, dc) {
    const c = ctx, D = nodes.data;
    const geomL = D.geom, matL = D.mat;
    const st = stage.stats;
    // reset transform + clear
    if (stage.view2d) { const t2 = stage.view2d; c.setTransform(t2[0], t2[1], t2[2], t2[3], t2[4], t2[5]); }
    else c.setTransform(stage.dpr, 0, 0, stage.dpr, 0, 0);
    c.clearRect(0, 0, stage.width, stage.height);

    // Style-run batching: one beginPath per (fillStyle, fill, stroke) run, flushed
    // when any of those three change. curFill/curStroke are the CURRENT run's
    // material behaviour so the flush honours material.fill (D-05: fill===false
    // emits no fill()) and material.stroke (outline the run in the same batch).
    // For the default fill:true / stroke:null material only the style breaks a run,
    // so the fill path is byte-identical to v1.3.0. Shade is a single shadeL read;
    // the v1.3.0 per-face quatRotate + dot + clamp + float-to-int is GONE.
    let curStyle = null, open = false, curFill = false, curStroke = null, curLineWidth = 0;

    for (let i = 0; i < dc; i++) {
      const e = order[i], d = drawNode[e], fi = drawFace[e];
      const g = geometries[geomL[d]], mat = materials[matL[d]];
      const base = vertBase[d];

      if (fi === 0xFFFFFFFF) {  // stroke polyline
        if (open) { if (curFill) { c.fill(); st.drawCalls++; } if (curStroke) { c.strokeStyle = curStroke; c.lineWidth = curLineWidth; c.stroke(); st.drawCalls++; } open = false; curStyle = null; }
        c.strokeStyle = mat.stroke || mat.lut[mat.K - 1];
        c.lineWidth = mat.lineWidth;
        c.beginPath();
        for (let v = 0; v < g.V; v++) { const X = screenXY[(base + v) * 2], Y = screenXY[(base + v) * 2 + 1]; if (v === 0) c.moveTo(X, Y); else c.lineTo(X, Y); }
        c.stroke(); st.drawCalls++; st.facesDrawn++;
        continue;
      }

      const style = mat.lut[shadeL[e]];      // shade baked in collect; one lane read
      const fillNow = mat.fill, strokeNow = mat.stroke;

      if (style !== curStyle || fillNow !== curFill || strokeNow !== curStroke) {
        if (open) { if (curFill) { c.fill(); st.drawCalls++; } if (curStroke) { c.strokeStyle = curStroke; c.lineWidth = curLineWidth; c.stroke(); st.drawCalls++; } }
        c.fillStyle = style; curStyle = style; curFill = fillNow; curStroke = strokeNow; curLineWidth = mat.lineWidth; c.beginPath(); open = true;
      }
      const off = g.faceVertOffset[fi], o1 = g.faceVertOffset[fi + 1], fv = g.faceVerts;
      for (let j = off; j < o1; j++) {
        const vi = base + fv[j], X = screenXY[vi * 2], Y = screenXY[vi * 2 + 1];
        if (j === off) c.moveTo(X, Y); else c.lineTo(X, Y);
      }
      c.closePath();
      st.facesDrawn++;
    }
    if (open) { if (curFill) { c.fill(); st.drawCalls++; } if (curStroke) { c.strokeStyle = curStroke; c.lineWidth = curLineWidth; c.stroke(); st.drawCalls++; } }
  }

  return stage;
}

export const version = '1.5.0';
