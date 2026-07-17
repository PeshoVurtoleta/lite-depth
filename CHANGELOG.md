# Changelog

All notable changes to `@zakkster/lite-depth` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-07-17

First public release. "Painter" — the pure Canvas2D core.

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
