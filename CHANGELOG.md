# Changelog

All notable changes to `@zakkster/lite-depth` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.7.0] - 2026-09-13

Roadmap D5 "Layers": flag-backed membership tags, a flat ground-shadow pass, and a
pickable-set query, all built on `@zakkster/lite-arena` 1.9.0 tags + `joinN`.

### Added

- **Membership tags.** Three `arena.registerTag()` sets -- `Pickable`, `ShadowCaster`,
  `Billboard` -- each mirroring a `FLAGS` bit and kept in lockstep on `addNode`, the
  new `set*` setters, `remove` (auto: `despawn` clears every component), and `clear`
  (auto: `arena.clear` drops every component count to 0). The bit stays the hot
  per-node masked compare in `collect`; the tag turns an O(nodes) secondary scan into
  an O(members) walk for the cold passes. A fourth per-frame derived tag, `Culled`, is
  reconciled by `syncCulled` from the frame's screen/depth rejection (a new `cullStamp`
  Uint32 node lane, stored at the two existing node-cull continue sites).
- **Flag setters + `addNode` init.** `stage.setPickable(h, on)`, `setCastShadow(h, on)`,
  `setBillboard(h, on)`, and `addNode(..., { pickable, castShadow, billboard })` set
  the bit and the mirror tag together.
- **Flat ground-shadow pass.** With a shadow material set (`stage.setShadowMaterial(matId)`,
  `-1` disables), every non-culled `ShadowCaster` face is flatten-projected onto the
  world plane `y=0` along `stage.light` and appended to the SAME draw list as a
  `DRAW_SHADOW` polygon, ordered strictly under the caster: a layer-L (L>=1) caster's
  shadow goes to layer L-1 (layer bits dominate); a layer-0 caster's shadow is keyed
  at the caster's farthest view-space extent (bounding-sphere far point) minus one
  depth unit -- strictly below every one of that caster's real face keys, with NO
  real-face key changed. The pass is cold, walks only the
  caster tag members via `arena.joinN([ShadowCaster],[Culled])` (consumed immediately),
  and reuses the near-clip vertex scratch. Flatten-matrix onto ONE plane -- no shadow
  maps, no soft shadows. A light parallel to the ground, or a culled/invisible caster,
  casts nothing (fail closed).
- **`stage.pickSet(out) -> count`.** Pickable, non-culled dense node indices into a
  caller-owned array, via `arena.joinN([Pickable],[Culled])`. Bounds a pick broadphase
  to the pickable set. Zero allocation (hoisted join inputs, reused arena plan).
- **`stats.shadowFacesDrawn`.** Shadow faces are counted apart from `facesDrawn`, so a
  caster is never double-counted (its own faces stay in `facesDrawn`).
- **`createStage(ctx, { checked })`** (dev only, default false) forwards to lite-arena's
  checked `Arena`: `idx()` validates liveness/membership and `join`/`joinN` return a
  staleness-guarded plan that throws on a stale read or a required+excluded set. The
  unchecked default path is byte-identical, so production `frame()` cost is unchanged.
  This makes the stale-join-plan guard reachable from lite-depth's public API
  (`stage.arena` + `stage._tags`).
- **`test/17-layers.test.js`** (23 tests) covering tag/flag lockstep, `Culled`
  reconcile, `pickSet`, the shadow pass + `shadowFacesDrawn`, `matOverride` run
  batching, `setShadowMaterial` fail-closed, and the `cullStamp` lane grow. Torture
  `test/torture.mjs` gains **Phase F** (D5): a dense caster+pickable stage driven
  through `frame()` + `pickSet()` at `maxMajor/maxMinor: 0` and 0 B/op.

### Changed

- **`paint` reads a per-draw `matOverride` Uint16 lane** instead of `matL[drawNode[e]]`
  -- a CONVERTED indirection (one Uint16 read where 1.6.0 read the node material via
  `drawNode`), not an added one, written by `collect` for every emitted entry. For a
  normal face `matOverride[e]` equals the node material, so style-run batching and the
  draw output are byte-identical to 1.6.0; a shadow entry carries the stage shadow
  material. The material registry is capped at 65536 (Uint16), fail-closed at
  `stage.material()`.
- **`maxDrawFaces` sizing.** A shadow-casting node counts TWICE against the budget
  (its own faces + its shadow faces); size for `visible faces + caster faces`.
- **FLAGS D-14.** Every `FLAGS` bit is now consumed by code (`VISIBLE`, `DIRTY`,
  `NON_UNIFORM_SCALE`, `DOUBLE_SIDED`, `STROKE`, `PICKABLE`, `CAST_SHADOW`) or reserved
  with a dated milestone comment (`BILLBOARD` -- tag maintained, no draw consumer yet).

### Fixed

- **CHANGELOG 1.6.0 clip-limit wording.** The 1.6.0 entry said the clip buffers cap
  "`maxClipVerts`, default 16 verts/face", conflating two constants. Corrected:
  `maxClipVerts` is the per-frame clip-scratch budget (default 4096); the per-face
  vertex cap is the fixed `CLIP_CAP` (16).
- **llms.txt D4 surface.** The API body never documented the v1.6.0 pick surface;
  added `pick`/`pickRect`/`pickRay`/`nearest`, `useSpatialIndex`/`dropSpatialIndex`,
  `attachPointer`/`detachPointer`, and the `clipNear` / `maxClipVerts` options.

## [1.6.0] - 2026-09-13

Roadmap D4 "Touch": near-plane Sutherland-Hodgman clipping and a DI-bound
spatial-index pick surface. Also folds in the demo modernization previously staged
under Unreleased (`demo/` ships in neither `package.json` `files[]` nor the tarball).

### Added

- **Near-plane Sutherland-Hodgman clip.** A face straddling the near plane (>= 1
  vertex in front, >= 1 behind) is clipped to the plane and drawn, rather than
  whole-face rejected. Two preallocated ping-pong polygon buffers allocate lazily
  on the first straddle. Two distinct limits govern the clip: `maxClipVerts` is the
  per-FRAME clip-scratch vertex budget (default 4096), and `CLIP_CAP` is the fixed
  per-FACE vertex cap (16) -- a face with >= 16 vertices straddling near is rejected
  whole (fail closed). A
  fully-front face keeps a byte-identical hot body; a fully-behind face is culled
  with no clip work and no allocation. The `clipNear` flag (default true) restores
  the prior whole-face reject when set false.
- **DI-bound spatial index.** `stage.useSpatialIndex(tree, { margin })` /
  `stage.dropSpatialIndex()` bind a caller-supplied `DynamicBVH2D` (`@zakkster/lite-bvh`)
  the same way `useSignals` binds an effect runner -- lite-bvh is a devDependency,
  never a runtime dependency. Per frame the packed node-box lane is fattened via
  `aabb2.fattenAll` into a disjoint buffer (margin clamped by `aabb2.marginFloor`)
  and the tree is rebuilt with `clear()` + `insertLeaves`.
- **Pick API.** `stage.pick(x, y, out) -> count` returns the depth-topmost hit via a
  `queryPoint` broadphase then a back-to-front `aabb2.containsPoint` walk over the
  sorted draw list. `stage.pickRect(x0, y0, x1, y1, out)` (marquee via `query`),
  `stage.pickRay(p0x, p0y, p1x, p1y, out)` (via `raycast`), and
  `stage.nearest(x, y, radius)` (via `aabb2.distanceSq`, no `sqrt`). Without a bound
  index every pick call falls back to an O(n) back-to-front `containsPoint` scan over
  the packed lane -- same topmost answer, zero allocation. Hit buffers are
  caller-owned `Int32Array`s. Binding an index forces the node-box lane on so a pick
  never broadphases a stale lane; `pick` with no index and `dirtyRect` false throws
  (fail closed).
- **Pointer plumbing.** `stage.attachPointer(el)` / `stage.detachPointer()` route
  `pointerdown`/`move`/`up` to pick calls. Orbit interaction stays external.
- **`demo/demo.html`: three new scenes** covering the v1.4.0-v1.5.0 surface --
  Wireframe/Stroke (`fill:false + stroke` wireframe vs `fill:true + stroke`
  fill-then-outline vs `fill:false` alone), Hierarchy Lighting (non-uniform rotated
  parent + uniform child proving world-normal shading and `stats.nodesNonUniform`),
  and Cull + DirtyRect (`stats.nodesCulled` vs `facesCulled` readouts, an opt-in
  `stage.dirtyRect` toggle, and an overlay stroking `sceneBox` U `prevSceneBox`) --
  plus a `clear()`/`reserve()` scene-reload panel reading `remainingNodes` and
  `structureEpoch`.
- **`#profile` dev gate.** With `location.hash === '#profile'` the demo dynamically
  imports `@zakkster/lite-layout-profiler` for forced-reflow auditing and calls
  `destroy()` on unload; a normal load never fetches it. Never in `files[]`.

### Changed

- **Index and clip buffers allocate lazily.** `fatNodeBox`, the index-id lane, and
  the pick scratch buffers allocate on `useSpatialIndex()`; the clip scratch allocates
  on the first straddle. A stage that binds no index and never straddles keeps the
  1.5.1 memory footprint.
- **Torture gate now enforces `maxMinor: 0`.** `RULES` in `test/torture.mjs`
  previously gated `maxMajor`, `maxPauseMs`, and `maxArrayBuffersGrowth` but not minor
  GC; it is now at least as strict as the package's own dirtyRect zero-GC test.
  `test/` ships in neither `files[]` nor the tarball.
- **Demo importmap repinned** to the installed peers (`@zakkster/lite-aabb` 2.x,
  `@zakkster/lite-arena` 1.9, `@zakkster/lite-fastbit32` 1.2). `demo/demo.html` was
  still pinned to `lite-aabb@1.0.0`, whose missing `FORMAT_VERSION` tripped the
  `createStage` `FORMAT_VERSION === 1` assert added in 1.5.0 and stopped the demo
  from booting.
- **Eliminated per-frame forced reflow in the demo `fit()` paths.** Canvas size is
  read once in a `ResizeObserver` callback and cached as integers; the rAF loop no
  longer reads `getBoundingClientRect`/`clientWidth`/`clientHeight` per frame
  (`demo/demo.html` and `demo/motion.html`).
- **`demo/motion.html`** caches loop/rate/ease control values on `change` instead of
  reading `.value` per frame, and adds a clock-vs-standalone-dt toggle, an ease-bank
  select, and an explicit `quatKey` slerp track.

## [1.5.1] - 2026-08-31

Test-harness hardening only. The published library surface (`Depth.js`) is byte-for-byte
unchanged from 1.5.0; `test/` ships in neither `package.json` `files[]` nor the tarball.

### Changed

- **Phase A retention rebuilt on two oracles.** The prior gate tracked a throwaway
  `{slot}`, then untracked it immediately, so its `size() === 0` was a tautology.
  Phase A now asserts the arena conservation law per cycle (the node-slot oracle --
  lite-depth is arena-backed SoA with no per-node JS object) alongside a
  finalization-authority witness on the STAGE (the real JS object each cycle
  allocates), tracked without untrack across fresh create/frame/despawn/drop cycles,
  hard-settled, residual `<= RES` (16).

### Added

- **`DEPTH_TORTURE_LEAK=1` extended to trip both oracles.** The fault-injection path
  now pins stages and skips removes, so both the arena-conservation oracle and the
  stage finalization-authority witness fail closed under injected retention.

## [1.5.0] - 2026-08-15

Per-node screen-space cull + opt-in dirty-rect (roadmap D3). The per-face viewport
test loses its `aabb2.set` + `aabb2.intersects` pair for four inline positive-form
compares against cached viewport scalars (the min/max already fall out of the
per-face vertex loop). A new per-node screen-space AABB cull rejects a whole node
whose projected box misses the viewport BEFORE its face loop runs, and an opt-in
`stage.dirtyRect` lane exposes the merged scene bounding box for incremental redraw.
The default hot path stays at 0 B/op with `gc major=0`; the dirtyRect lane and the
node-box cull are proven zero-alloc by the torture gate's new Phase D.

> **STATS SEMANTICS CHANGE (`nodesCulled` / `facesCulled`).** A node whose projected
> screen box misses the viewport is now culled WHOLE: `stats.nodesCulled` counts it
> and its face loop runs ZERO iterations, so its faces are no longer tallied in
> `stats.facesCulled`. Previously every off-screen face was counted individually in
> `facesCulled`. For any node at least partially on screen, `facesDrawn` and
> `facesCulled` are byte-identical to 1.4.0 (the per-face test is unchanged, only
> inlined). Rendered pixels are unchanged.

### Added

- **Per-node screen-space AABB cull.** Each visible node accumulates a screen box
  over its FRONT-OF-NEAR vertices (`z <= -near`) during projection. If the box
  misses the cached viewport scalars the whole node is culled (`stats.nodesCulled`
  +1) and its face loop is skipped entirely. A node whose box is empty or non-finite
  (all verts behind the near plane) FAILS OPEN -- it is drawn, never node-culled and
  never counted in `nodesInvalid`, because a wrongly-fired geometry cull loses
  picture; its faces are then rejected by the existing per-face near door,
  byte-identical to 1.4.0. This is the deliberate inverse of the face-bound-NaN
  door, which fails CLOSED (a NaN face bound makes a compare false, so the face is
  culled -- losing a degenerate face is safe).
- **Opt-in `stage.dirtyRect` (default `false`).** When enabled, each drawn node's
  screen box is stored (rounded OUTWARD to f32 so the stored box never clips the
  true box) into a packed `nodeBox` lane and merged once per frame into a new
  `stage.sceneBox` getter (packed lite-aabb `Float32Array[4]`); the previous
  frame's union is kept in `stage.prevSceneBox` for a redraw delta. OFF => zero
  added hot cost (no per-node box write, no merge). The `nodeBox` lane grows in
  lockstep with the other node lanes in `stage.reserve(n)`.
- **`FORMAT_VERSION` re-export.** `@zakkster/lite-aabb`'s packed-format contract
  version is re-exported and asserted `=== 1` in `createStage` (fail closed with a
  clear throw if the peer's `[minX, minY, maxX, maxY]` float32x4 layout ever drifts).

### Changed

- **Per-face viewport cull inlined.** The per-face `aabb2.set(_box, ...)` +
  `aabb2.intersects(_box, _viewport)` pair is replaced by four inline compares
  (`minx <= vx1 && maxx >= vx0 && miny <= vy1 && maxy >= vy0`) against viewport
  scalars cached at create/resize. Byte-identical to the `intersects` predicate;
  the face-bound min/max seed is now `Infinity` / `-Infinity`.

### Tested

- Torture gate gains **Phase D** (node-box cull): an inverted control (an on-screen
  node is never node-culled), an edge matrix (a node off each of the four viewport
  edges + two corners culls the whole node with zero face-loop work, exercising each
  inline compare), the fail-open door (a behind-near node is drawn, not culled), and
  a dense down-z stage with `dirtyRect` enabled + ~1/3 nodes off-screen driven
  through the same `measureOps` + `measureAllocs` windows at 0 major GC / 0 B/op.

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
