# Changelog

All notable changes to `@zakkster/lite-depth` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-07-18

"Motion" — an optional animation layer, shipped as the `@zakkster/lite-depth/motion`
subpath. The core (`Depth.js`) is unchanged and gains no new required dependencies.

### Added

- **`@zakkster/lite-depth/motion` subpath** — `createMixer(stage, opts)` and a
  chainable clip API. A **thin composer over the stack**, not a re-implementation:
  [`lite-clock`](https://www.npmjs.com/package/@zakkster/lite-clock) is the
  deterministic time base, [`lite-keyframe`](https://www.npmjs.com/package/@zakkster/lite-keyframe)'s
  `KeyframePool` evaluates scalar channels, and [`lite-ease`](https://www.npmjs.com/package/@zakkster/lite-ease)
  is the easing bank. These three are **optional peer dependencies** — install
  them only if you import the subpath.
- **Channels:** `posKey`, `scaleKey` (uniform or per-axis), `biasKey` (depth-bias),
  `quatKey` / `quatEuler`. Each key takes an absolute time in seconds and an
  optional easing name.
- **Quaternion slerp tracks** — the one thing the stack lacks. Interpolating a
  rotation as four independent scalar keyframe rows would denormalise and never
  actually slerp, so Motion adds a dedicated quaternion arena with spherical
  interpolation and an **nlerp fast path** at `dot > 0.9995`. Verified bit-exact
  against gl-matrix on Float32-stored inputs; output stays unit-normalised.
- **Loop modes** — once / loop / pingpong, plus `timescale`, `play` / `pause` /
  `resume` / `stop` / `seek`, and `duration` inferred from the last key.
- **Clock time base** — in clock mode the mixer reads `clock.simTime`, so global
  pause / seek / replay and **golden-frame determinism** (identical `advance(dt)`
  → byte-identical lanes) come from the clock. Standalone `update(dt)` mode is
  kept for use without a clock.
- `Motion.d.ts` declarations; five motion test files (`05`–`09`); an
  oscilloscope-themed **timeline scrubber demo** (`demo/motion.html`).

### Fixed (during hardening)

- **`scaleKey(t, uniform, 'ease')` stored NaN.** The uniform-scale-with-easing
  overload collided with the `(t, x, y, z, ease)` signature — the easing string
  landed in the `y` slot and `z` was left undefined, writing NaN into `sy`/`sz`
  and collapsing every transform (total face cull). `scaleKey` now detects a
  string in the axis slots as the easing. Regression tests added.
- **NON_UNIFORM_SCALE flag was set-only.** An animated scale that returned to
  uniform left the flag stuck on; the update path now clears it when
  `sx === sy === sz`. The core `stage.setScale` setter had the same set-only bug
  and now clears the flag on a return to uniform as well.
- **Orthographic projection was unreachable.** `createCamera` stored `ortho`/
  `orthoScale` on the camera, but `stage.frame()` branched on `stage.ortho`
  (never assigned), so `createStage(ctx, { camera: { ortho: true } })` silently
  rendered perspective. `frame()` now reads `camera.ortho`.
- **`Depth.js` version constant** was left at `1.0.0`; synced to `1.1.0` to match
  `package.json`, `Motion.js`, and `llms.txt`.
- Removed an unused `markDirty` helper.
- **Unresolvable dependency range.** `@zakkster/lite-arena` was pinned to `^2.0.0`,
  which does not exist (stable line is 1.9.0), so `npm install` failed with
  ETARGET; corrected to `^1.9.0`. `@zakkster/lite-aabb@^2.0.0` is correct.
- **Motion demo (`demo/motion.html`)** — the frame loop wrote HUD `textContent`
  and ran `toFixed` every frame (allocating strings in a zero-GC demo); telemetry
  is now gated to ~10Hz. `once` mode no longer froze the timeline scrubber: a
  completed `once` clip re-arms when scrubbed back into range, and the loop
  clamps rather than wraps `once` time. Dropped an unused `material` import.

### Notes

- **Zero-GC, measured as bytes/op.** The update path evaluates channels straight
  into the arena's `Float64` lane arrays rather than through the stage setters —
  a double passed as a *function argument* across a non-inlined call boundary can
  be boxed as a `HeapNumber`, but the same double stored directly into a
  `Float64Array` element is not. The zero-GC test gates on **allocated bytes per
  op** (`measureOps`), not a raw scavenge count: a scavenge count is confounded
  by wall-clock time, so it tracks how long a loop runs rather than how much it
  allocates. A 1500-clip scene animating position + quaternion + scale every
  frame holds at **0 GC over 20 000 ops** — the same bar as the render loop.



### Added

- **Zero-GC render pipeline.** `stage.frame(dt)` runs transform → project →
  cull → LSD radix sort → paint entirely over pre-allocated storage. Verified
  0 major / 0 minor GC on a 2000-node, every-node-dirty scene across thousands
  of frames via `@zakkster/lite-gc-profiler`.
- **Arena-backed node store** on `@zakkster/lite-arena`: generational handles,
  SoA sparse-set lanes, swap-and-pop compaction, O(n) topological rebuild
  (memoized depth + counting sort) on structural change.
- **Six primitives + custom meshes:** `box`, `plane`, `sphere`, `cylinder`,
  `cone`, `polyline`, `custom`. Quads and n-gons first-class; Newell-method
  face normals.
- **Packed 32-bit sort key** — `(layer << 26) | quantize26(viewZ + depthBias)`.
  One mechanism serves manual popping bias, forced painter layers, and (future)
  the shadow pass.
- **Flat shading via pre-baked fillStyle LUTs** — no per-frame `rgb(...)` string
  building. `material()` and `materialFromRamp()`.
- **Perspective + orthographic camera** with spherical-orbit math and plain
  setters; optional `view2d` composition hook. Interaction decoupled to a
  companion by design.
- **`lite-fastbit32` flag lane** (VISIBLE / DIRTY / DOUBLE_SIDED / STROKE / …)
  and **`lite-aabb` per-face viewport cull**.
- **Cold-path `lite-signal` DI** via `useSignals()` + `bind()`.
- Full TypeScript declarations (`Depth.d.ts`).
- `node:test` suite (4 files) + vs-Zdog benchmark + three-scene oscilloscope demo.

### Fixed (pre-release, during hardening)

- **Back-face winding cull was inverted.** The screen-space Y-flip inverts
  polygon orientation, so front faces carry negative signed area. The cull kept
  the wrong half (drawing back faces, masked by ambient shading). Corrected to
  keep `area < 0`; a 500-random-pose test now pins drawn faces to the true
  camera-facing set.
- **Depth quantization collapsed to a single key.** `zSpan = near - far` was
  negative, so `t = (z + far) / zSpan` went negative for every in-frustum face
  and clamped to 0 — the radix sort silently degenerated to collection order.
  Corrected to `zSpan = far - near` with far→0, near→DEPTH_MAX. The sort test
  now asserts both key spread and full paint-order depth monotonicity.

### Notes

- Timing numbers in docs are container-measured and **indicative**; the pinned
  performance bars (MacBook Pro / iPhone 11) are measured on reference hardware.
- Near-plane handling in v1.0.0 is a conservative whole-face reject; proper
  Sutherland–Hodgman clipping lands in v1.2.0 ("Touch").
