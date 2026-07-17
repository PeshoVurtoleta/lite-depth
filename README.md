# @zakkster/lite-depth

> **[DEPTH // SCOPE](demo/demo.html)** — the three-scene oscilloscope demo.
> Primitive gallery, a zero-GC stress field with live telemetry, and the
> Z-bias / layer escape-hatch playground. Run it with `npx serve .` and open
> `demo/demo.html`.

> Zero-GC Canvas2D software-projected 3D. Zdog's niche — flat-shaded,
> painter-sorted, pseudo-3D on a 2D canvas — but arena-backed and allocation-free
> per frame.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-depth.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-depth)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Frame%20loop-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-depth?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-depth)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-depth?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-depth)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-debth?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-debth)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.txt)

**Zdog allocates; lite-depth doesn't.** Same flat-shaded pseudo-3D on a 2D
canvas — projection, painter's-algorithm depth sort, primitives, hierarchy,
strokes — but every per-frame array is pre-allocated once and mutated in place.
The render loop (transform → project → cull → radix sort → paint) produces
**zero garbage collections**, verified frame-by-frame with
[`@zakkster/lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler).

## Highlights

- **Zero-GC frame loop.** Structure-of-arrays node store, a global pre-allocated frame arena, and an LSD radix sort keep the hot path allocation-free. Under `--expose-gc`, a 2000-node scene with every node re-oriented every frame runs **0 major / 0 minor GC** across thousands of frames — cleaner than an empty control loop.
- **Pure Canvas2D painter engine.** No WebGL, no depth buffer, no renderer abstraction. Faces are depth-sorted by centroid and painted back-to-front, batched into style-runs so identical consecutive fills collapse to one `fill()`.
- **Arena-backed nodes.** Built on [`@zakkster/lite-arena`](https://www.npmjs.com/package/@zakkster/lite-arena): generational handles (a stale handle after `remove` invalidates instead of aliasing a recycled slot), SoA sparse-set storage, swap-and-pop compaction that keeps the transform pass dense and cache-warm.
- **One packed sort key, three jobs.** `key = (layer << 26) | quantize26(viewZ + depthBias)`. A per-node `depthBias` is the manual escape hatch for popping on interpenetrating meshes; a `layer` lane forces ordering outright (HUD props always over scenery). Same radix passes, zero extra cost.
- **Six primitives + custom meshes.** Box, plane, sphere, cylinder, cone, polyline, and `custom(verts, faces)` — quads and n-gons are first-class (a box is 6 quad faces, not 12 tris). Face normals precomputed with Newell's method.
- **Flat shading without string churn.** Each material pre-bakes a K-step hex ramp at creation; per-frame shading is a single LUT index (`material.lut[(ndl * (K-1)) | 0]`) — no `rgb(...)` built in the paint loop.
- **Hybrid precision.** `Float32Array` for static geometry stores (read-only at project time, memory-dense); `Float64Array` for frame arenas and math registers, so screen coordinates never silently up-cast before `moveTo`/`lineTo`.
- **Real runtime dependencies.** [`lite-arena`](https://www.npmjs.com/package/@zakkster/lite-arena) · [`lite-fastbit32`](https://www.npmjs.com/package/@zakkster/lite-fastbit32) (flag namespace) · [`lite-aabb`](https://www.npmjs.com/package/@zakkster/lite-aabb) (per-face viewport cull). Optional cold-path peers: `lite-signal` (DI bindings), `lite-raf`, `lite-clock`, `lite-sprite-cache`.

## Install

```bash
npm install @zakkster/lite-depth
```

Runtime dependencies install automatically. Optional peers (only if you use the
cold-path features that need them):

```bash
npm install @zakkster/lite-signal @zakkster/lite-raf @zakkster/lite-clock
```

## Quick start

```js
import { createStage, geometry, material, updateCamera } from '@zakkster/lite-depth';

const canvas = document.querySelector('#scene');
const stage = createStage(canvas.getContext('2d'), {
  width: 800, height: 600, dpr: devicePixelRatio,
  maxNodes: 256, maxVerts: 8192, maxDrawFaces: 8192,
  camera: { radius: 7, theta: 0.6, phi: 1.05, near: 0.1, far: 60 },
});

// Register shared geometry + material, then instance nodes.
const box = stage.geometry(geometry.box(1.4, 1.4, 1.4));
const mat = stage.material(material({ r: 95, g: 227, b: 161, ambient: 0.32 }));
const cube = stage.addNode(box, mat, { x: 0, y: 0, z: 0 });

// Drive it. stage.frame(dt) is standalone — pair with rAF, lite-raf, or a game loop.
let f = 0;
requestAnimationFrame(function loop(now) {
  stage.setEuler(cube, f * 0.01, f * 0.013, 0);
  stage.camera.theta += 0.004; updateCamera(stage.camera);
  const stats = stage.frame(16);      // { facesDrawn, facesCulled, tSort, ... }
  f++;
  requestAnimationFrame(loop);
});
```

Camera interaction (drag-orbit, pinch-dolly, inertia) is **deliberately not in
core** — it lives in a companion. The core ships spherical→Cartesian orbit math
and plain setters; wire pointer events to `camera.theta/phi/radius` +
`updateCamera(camera)` yourself, or hand it to a driver package.

## The pipeline

Every `stage.frame(dt)` runs five phases over pre-allocated storage:

1. **transform** — topological walk; recompute the world 3×4 affine for dirty subtrees only (a `lite-fastbit32` flag lane drives the dirty query).
2. **project** — world → view → perspective divide into the Float64 frame arena. A cheap per-node bounding-sphere frustum reject skips fully off-screen instances.
3. **collect + cull** — per face: near-plane reject, [`lite-aabb`](https://www.npmjs.com/package/@zakkster/lite-aabb) viewport cull, and screen-winding back-face cull (the Y-flip inverts polygon orientation, so front faces are the negative-area ones).
4. **sort** — pack each surviving face into a `Uint32` key and LSD radix sort (4 × 8-bit passes, pre-allocated histograms + ping-pong index buffers). O(n), stable, comparator-free — `Array.sort` with a comparator is disqualified because it allocates and boxes.
5. **paint** — walk sorted order back-to-front; one `beginPath`/`fill` per style-run, `fillStyle` from the material's pre-baked LUT, no `save`/`restore`.

## API

### `createStage(ctx, options)`

Returns a `Stage`. Caps (`maxNodes`, `maxVerts`, `maxDrawFaces`) size the arena
and frame buffers up front — pick them for your worst-case scene. `maxVerts` is
the **total projected-vertex budget across all visible instances per frame**
(a 77-vertex sphere costs 77, not 1); undersizing silently drops geometry.

### Geometry

`geometry.box(w?, h?, d?)`, `.plane(w?, d?)`, `.sphere(radius?, segU?, segV?)`,
`.cylinder(radius?, height?, seg?)`, `.cone(radius?, height?, seg?)`,
`.polyline(points)`, `.custom(verts, faces)`. Each returns a shared `Geometry`;
register once with `stage.geometry(g)` and instance it across many nodes.
`custom` takes flat `verts` (xyz interleaved) and a `faces` array of
convex index loops (quads and n-gons welcome).

### Materials

`material({ r, g, b, ambient, steps, stroke, lineWidth, fill })` bakes a K-step
hex ramp at creation. `materialFromRamp(hexRamp, opts)` takes a ready-made ramp —
e.g. an OKLCH scale from [`@zakkster/lite-hueforge`](https://www.npmjs.com/package/@zakkster/lite-hueforge).

### Nodes

`addNode(geomId, matId, init)` → a generational `NodeHandle`. Setters:
`setPosition`, `setScale` (uniform or per-axis), `setQuaternion`, `setEuler`,
`setParent`, `setLayer` (0–63), `setDepthBias`, `setVisible`, `remove`.
All setters mark the node dirty; structural changes (add / remove / reparent)
flag a cold topological rebuild before the next frame.

### Camera

`createCamera(opts)` / `stage.camera` carry `{ theta, phi, radius, tx/ty/tz,
fov, near, far, ortho, orthoScale }`. Mutate them, then call
`updateCamera(camera)` (cold) to rebuild the world→view affine. An optional
`stage.view2d` (a `Float64Array[6]`) applies one `setTransform` per frame —
the composition hook for a 2D screen-space camera (shake, framing) over the 3D scene.

### `stage.frame(dt) → stats`

Runs the pipeline and returns `{ facesDrawn, facesCulled, nodesCulled,
drawCalls, tTransform, tProject, tSort, tPaint }`.

### lite-signal DI (cold path)

```js
import { effect } from '@zakkster/lite-signal';
stage.useSignals({ effect });
stage.bind(handle, 'position', () => positionSignal());   // cold effect writes lanes + marks dirty
```

The effect runs on the cold path; the frame loop only ever reads lanes.

## Zero-GC frame loop

The headline claim, and it's falsifiable. Measured with
[`@zakkster/lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)
(`perf_hooks` precise GC events) — with `settle()`, because the observer delivers
entries **asynchronously** and a naive synchronous read reports a false `0`.

```
// node --expose-gc, container sandbox, 2000 nodes, every node dirty every frame:
//
//   window              major   minor   verdict
//   control (empty)       0       1      — (V8 self-noise)
//   steady-state render   0       0      PASS  {maxMajor:0, maxMinor:0}
//
// The render loop produced fewer collections than doing nothing.
```

Structural mutation (spawn / despawn / reparent) is **cold by contract** and may
allocate a small, bounded amount — it triggers zero major GCs and never runs away.

**Against Zdog** (matched rotating box fields, identical no-op ctx — both hit the
same Canvas2D backend, so this isolates the JS pipeline; container-indicative):

| N boxes | lite-depth | Zdog | Zdog GC (major/minor) | speedup |
|--------:|-----------:|-----:|:---------------------:|--------:|
| 500  | 0.4 ms, **0/0 GC** | 11 ms  | 0 / 345  | ~30× |
| 1000 | 0.8 ms, **0/0 GC** | 22 ms  | 1 / 691  | ~29× |
| 2000 | 1.5 ms, **0/0 GC** | 48 ms  | 2 / 1384 | ~31× |

Zdog's minor-GC count scales with the scene because it allocates `Vector` objects
per shape per frame — structural to its design, not a tuning artifact.

> **Timings are indicative, not the pinned bars.** They were taken in a Linux
> container on unknown silicon. Allocation (0 bytes/frame) is machine-independent
> and final; millisecond figures are for *ratios and scaling shape*. The official
> performance bars are pinned on a 10-year-old MacBook Pro (primary) and
> iPhone 11 / mid Android (secondary).

## TypeScript

Full declarations ship as `Depth.d.ts` — `Stage`, `Geometry`, `Material`,
`Camera`, `StageStats`, `NodeHandle`, `FlagName`, and the `geometry` / `material`
/ `mathKernels` namespaces are all typed.

## Testing

`node:test` (no test-runner dependency), four files:

```bash
npm test            # correctness; the zero-GC test skips without --expose-gc
npm run test:gc     # adds --expose-gc; the zero-GC contract engages
npm run bench       # vs-Zdog head-to-head + throughput sweep
```

| File | Covers |
|---|---|
| `test/01-math.test.js`      | composeTRS / quatRotate / mulAffine vs gl-matrix (forced Float64) — bit-exact |
| `test/02-geometry.test.js`  | primitive vertex/face counts, unit face normals, CSR offset validity |
| `test/03-pipeline.test.js`  | back-face cull == true facing (500 poses), radix sort (spread + full-order depth monotonicity), near/frustum cull, generational-handle safety, hierarchy world transform |
| `test/04-zero-gc.test.js`   | steady-state render loop 0 major / 0 minor GC via lite-gc-profiler (skips without `--expose-gc`) |

The `04-zero-gc` test skips without `--expose-gc` so `npm test` runs cleanly;
`npm run test:gc` engages it.

## License

MIT — © Zahary Shinikchiev.

Built on the [`@zakkster/lite-*`](https://www.npmjs.com/~zakkster)
zero-runtime-dependency ecosystem.
