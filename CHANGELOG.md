# Changelog

All notable changes to `@zakkster/lite-depth` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-08-15

Shading correctness (roadmap D2). One bug in four costumes: the shading path read
different inputs than the geometry path. All four are fixed together; the per-face
**paint** body ends up strictly SMALLER than 1.3.0 (the whole per-face `quatRotate`
+ dot + clamp + float-to-int is gone), the zero-alloc gate holds at 0 B/op over
20000 frames, and the extra per-node cost lands in collect (once per node), never
per face.

> **VISIBLE RENDERING CHANGE.** Every hierarchical scene re-lights. Before 1.4.0 a
> face was lit by rotating its normal with the node's LOCAL quaternion while the
> face itself was drawn from the WORLD matrix, so any child of a rotated or scaled
> parent was mis-lit (ambient made it read as "flat", not "wrong"). From 1.4.0 the
> normal is transformed by the node's world matrix, so shading matches the drawn
> geometry. Renders will differ from 1.3.0 wherever a lit node has a rotated/scaled
> ancestor or a non-uniform scale, and wherever a `fill: false` material was used
> (it no longer fills). This is a correctness fix, not a regression.

### Fixed

- **Flat shading ignored parent rotation (S1, D-03).** `paint()` rotated the face
  normal by the node's LOCAL quaternion lanes while the geometry was drawn from the
  WORLD matrix, so a child of a rotated parent was lit as if the parent were not
  rotated. Shade is now derived from the world matrix: the directional light is
  back-rotated into each geometry's local frame ONCE per node (uniform case: through
  the world upper-3x3 with a per-node scale renormalize), and each face's shade is a
  single dot with its precomputed local normal, baked into a per-draw `Uint8Array`
  shade lane during collect. `paint()` reads that lane (`material.lut[shade]`).
- **`NON_UNIFORM_SCALE` computed but never consumed (S2, D-04).** `setScale`
  maintained `F_NONUNIF` and nothing read it, so a non-uniformly scaled node was lit
  with a normal that no longer pointed where the surface did. Non-uniform nodes now
  light through the inverse-transpose (the normal matrix = adjugate of the world
  upper-3x3 over its determinant), built once per node in collect; each face then
  transforms its local normal, normalizes, and dots with the light. The uniform
  majority keeps the sqrt-free back-rotated-light fast path. The path is selected by
  a per-node **world** non-uniform bit propagated down the hierarchy in topo order
  (own non-uniform local scale OR any non-uniform ancestor -- rotation is a
  similarity and does not taint), so an inherited non-uniform scale (a
  locally-uniform child under a non-uniformly-scaled parent) is shaded correctly,
  not just an own-node one. `stats.nodesNonUniform` counts drawn nodes with a
  non-uniform LOCAL scale (the flag); inherited-only descendants take the
  inverse-transpose too but are not counted.
- **`material.fill` documented but never read (S2, D-05).** `material({ fill: false })`
  still filled. `paint()` now honours `fill` (`fill: false` emits no `fill()`) and
  `stroke` (the face outline is stroked in the same one-`beginPath`-per-style-run
  batch). `fill: true` / `stroke: null` output is byte-identical to 1.3.0.
- **NaN laundered to the far plane (S1, D-06).** A NaN pose lane produced NaN screen
  coords whose face-centroid `z` reached `quantize`, where `(NaN * DEPTH_MAX) | 0 === 0`
  mapped it to the far plane (painted first, forever) with no counter. Two fixes: a
  fail-closed collect door rejects any node with a non-finite pose lane, world
  centroid, radius or bias -- once per NODE, never per face -- and bumps
  `stats.nodesInvalid`; and `quantize` now uses ordered compares only, so an
  unordered (NaN) result is a REJECT to `DEPTH_MAX`, never the far plane. Finite `z`
  is byte-identical to 1.3.0.

### Added

- **`stats.nodesNonUniform`** -- drawn nodes with a non-uniform local scale this
  frame (the `NON_UNIFORM_SCALE` inverse-transpose feature). Present in the stats
  literal and reset each frame.
- **Material step cap (fail closed).** `material({ steps })` and
  `materialFromRamp(ramp)` throw when the ramp exceeds **256** steps -- the per-frame
  shade lane is a `Uint8Array`, so a longer ramp would wrap its index to step 0.
  Rejected at creation with a did-you-mean hint (`material()` / `materialFromRamp()`
  in `Depth.js`) rather than mis-shading every frame. `stats.nodesInvalid` is no
  longer an always-zero placeholder; it now counts the D-06 rejects.

### Decisions (measured)

- **D2-a -- bake the shade in collect (paint body must shrink).** The per-face PAINT
  body dropped from a full `quatRotate` (~18 mul / 12 add-sub / a call / 3 scratch
  writes) + a 3-mul-2-add dot + a clamp + a `mul,sub,|0` LUT-index build to a single
  `shadeL[e]` typed-array read plus the `lut[...]` lookup (the batch bookkeeping adds
  only two field reads and two scalar compares, off the critical path for default
  materials). Net per-face delta: roughly **-22 multiplies, -14 add/subs, -1 call,
  -3 scratch writes**, +2 reads / +2 compares -- unambiguously net-negative, meeting
  the acceptance bar. The displaced work moved to collect as a per-face 3-mul dot +
  `mul,|0` (far cheaper than a `quatRotate`) plus a per-NODE back-rotation, so the
  expensive transform is amortized across all of a node's faces.
- **D2-b -- inverse-transpose only where the WORLD basis is non-uniform.** The
  adjugate/inverse-transpose branch is gated by a per-node `worldNonUnif` bit
  (own non-uniform local scale OR any non-uniform ancestor), propagated in topo
  order alongside the world matrix in a pre-allocated `Uint8Array(maxNodes)` lane --
  O(1) per node, 0 B/op, no per-face similarity test. Every fully-uniform node takes
  the cheaper sqrt-free back-rotation. `stats.nodesNonUniform` counts the own-flagged
  subset: `setScale(h, 3, 1, 1)` on one node yields `nodesNonUniform === 1`, 0 for a
  uniform-only scene; a locally-uniform child under that parent is shaded through the
  inverse-transpose (matching a gl-matrix `normalFromMat4` world-matrix oracle,
  exact integer LUT index over a 500-pose fuzz) without being counted.

## [1.3.0] - 2026-08-15

Bounded safety and structural correctness (roadmap D1). The hot path gains exactly
two integer compares per NODE (the overflow door); the per-vertex and per-face
loop bodies are otherwise byte-identical to 1.2.0, and the zero-alloc gate holds
at 0 B/op over 20000 frames. Every other change lands on the cold path (structural
mutation / stage setup). Three latent silent-corruption bugs that had shipped
since 1.1.0 are fixed here -- see Fixed.

### Added

- **Lifecycle API** -- `stage.clear()` (remove all nodes in place, keep capacity /
  geometries / materials / frame arenas, allocate nothing; every handle minted
  before it is invalid afterward), `stage.reserve(n)` (grow all node-capacity
  lanes between frames; returns `false` when `n <= capacity`, throws on a
  non-integer / negative `n`), and the `stage.remainingNodes` getter. A scene
  reload no longer requires building a whole new stage.
- **`stage.structureEpoch`** -- a monotonic `Uint32` (wraps) bumped by
  `addNode` / `remove` / `setParent` / `clear`. The single invalidation signal
  for any cached dense index; the `/motion` mixer's node-index cache now rides it.
- **`stats.nodesOrphaned`** -- counts nodes whose parent handle was dead/recycled
  this frame and were reparented to ROOT (see Fixed). Always present in the stats
  literal.
- **`geometry.*.drawSlots`** -- the draw-list entries a geometry emits per visible
  node (`F` for fills, `1` for strokes); the overflow door gates on it so a stroke
  (F=0, one draw entry) cannot slip a write past a full draw list.
- `test/11-bounded-safety.test.js` -- 22 boundary cases covering the overflow
  door (stroke / fill / vert budget), generational orphan reparenting (including
  the warm steady-state path and subtree propagation), parent cycles,
  `structureEpoch`, and `clear` / `reserve`.

### Fixed

- **Hand-decomposed handles, failing open (S1).** `rebuildTopo` resolved a parent
  with `sparse[ph & INDEX_MASK]`, throwing away the generation -- the only thing
  distinguishing a live parent from a despawned one whose slot has been reissued.
  A child then silently inherited a stranger's world matrix. Parent resolution now
  goes through the arena's generational `nodes.has(ph) ? nodes.idx(ph) : -1`; a
  dead parent reparents to ROOT and increments `stats.nodesOrphaned`, and the
  orphaned node is re-dirtied so `frame()` recomposes it at ROOT the same frame
  (not left pinned to the stale transform composed under the dead parent). The
  `INDEX_MASK` decomposition is deleted from both `Depth.js` and `Motion.js`;
  `Motion.js` now resolves each clip's dense index through a `structureEpoch`-keyed
  cache instead of a per-frame hand-decomposed lookup.
- **Silent frame-arena overflow (S1).** `frame()` never checked the vertex or
  draw-face cursor against `maxVerts` / `maxDrawFaces`; typed arrays discard
  out-of-range writes, so an undersized stage dropped geometry with zero signal.
  A two-compare-per-node overflow door now skips an over-budget node and
  increments `stats.facesOverflowed` -- no out-of-range write, no partial face
  referencing an unwritten vertex, and the read-only draw-list handles stay
  consistent.
- **Silent parent cycle (S2).** A parent cycle in `rebuildTopo` was treated as a
  root and rendered with no signal. It now throws an `Error` naming both nodes in
  the cycle -- fail closed on a caller bug rather than silently truncating.

### Changed

- **`Depth.d.ts`** -- declarations added for `clear` / `reserve` / `remainingNodes`
  / `structureEpoch`, the four newer `stats` fields, and `Geometry.drawSlots`.

## [1.2.0] - 2026-08-12

Publish-readiness and observability. No change to the hot path: the per-vertex
and per-face loop bodies in `frame()` are byte-identical to 1.1.0 (verified by
diff and by the new zero-alloc gate); every addition below lands in a cold path.

### Added

- **Torture gate** -- `test/torture.mjs`, run via `npm run torture`
  (`node --expose-gc test/torture.mjs` -> prints `ok`, exit 0), wired into
  `verify` and a new `prepublishOnly`. Three self-controlling phases: retention
  (4096 spawn/despawn cycles, dual witness -- arena pool conservation +
  [`lite-leak`](https://www.npmjs.com/package/@zakkster/lite-leak) tracker), GC
  budget (2000-node all-dirty stage, 20000 hot frames at 0 B/op under
  [`lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler),
  gated `maxMajor:0` / `maxPauseMs:4` / `maxArrayBuffersGrowth:0`), and an
  always-on inverted control that fails closed if the gate ever stops catching a
  real allocation. `DEPTH_TORTURE_LEAK=1` exercises the retention control.
- **Observability stats** -- `stats.nodesTotal` (live node count each frame),
  plus `stats.facesOverflowed` and `stats.nodesInvalid` (reserved always-zero
  hooks). Integer stores in the cold preamble, outside both loops.
- **Read-only draw-list handles** -- `stage._order` / `stage._drawCount` are now
  read-only getters over the internal ping-pong buffers (re-pointed per frame,
  no allocation), replacing the previously writable properties. Frozen as
  observation-only so downstream re-laning cannot silently regress them.
- `test/10-stats-drawlist.test.js` -- boundary coverage for the stats fields and
  the read-only draw-list contract.

### Changed

- **devDependencies** -- `lite-gc-profiler` floor raised to `^1.11.0`;
  `lite-leak ^1.8.0` added for the torture gate. The optional `lite-signal`
  peer range widened to `^1.2.0 || >=1.5.0-alpha` (cold-path DI only; depth
  never imports signal), with a dev-scoped `overrides` pinning `lite-clock`'s
  signal subtree so the two dev tools coexist. No effect on consumers.
- **Demo importmap** (`demo/motion.html`) -- pinned to the shipped major/minor
  lines: `lite-aabb@2` (was `@1`), `lite-arena@1.9`, `lite-fastbit32@1.2`.
- **Demo composition** (`demo/motion.html`) -- the prop ring is now count-aware:
  radius grows and peak scale shrinks with prop count, and convergence widened
  0.60r -> 0.72r, so the max-count (64) scene stays spatially separated instead
  of collapsing into the painter's overlap worst case. Demo-only, cold build
  path; the frame loop is unchanged.

### Fixed

- **Packaging** -- `files[]` referenced `LICENSE.txt` but the file on disk is
  `LICENSE`, so the license was silently absent from the tarball; corrected the
  manifest entry. Added the required maintainer email to the `LICENSE`
  copyright line.
- **Docs** -- reconciled the test-count drift in `llms.txt` (claimed 9, tree has
  6) and `ROADMAP.md`.

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
