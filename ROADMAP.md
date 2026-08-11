# @zakkster/lite-depth -- enriched roadmap (rev 4: substrate upgrade)

Eight sessions, v1.1.0 -> v2.0.0, plus a torture-suite spec this package does not
yet have. Supersedes `ROADMAP.md` rev 3 (four version headings, no gate, no
findings).

**Why it was rewritten.** Rev 3 was authored before the code existed and before
the substrate moved. Two things changed underneath it:

| Dep | Rev 3 assumed | Actual, read from source |
| --- | --- | --- |
| `@zakkster/lite-arena` | v1.4-era: spawn/despawn/registerComponent/dense | **v1.9.0**: `joinN`, `registerTag`, `reserve`, `clear`, `remainingCapacity`, `checked` mode, caller-supplied buffers, `detach`/`rebind`/`isDetached` |
| `@zakkster/lite-aabb` | v1.0: 12 single-box ops | **v2.0.0**: 22 ops incl. packed `4*N` `fattenAll`/`mergeAll`/`intersectsAny`, `isValid`/`setEmpty`/`marginFloor`, `containsPoint`/`distanceSq`/`closestPoint`, frozen namespace, `FORMAT_VERSION` |
| `@zakkster/lite-bvh` | "out of scope" | **v2.0.0**: same `FORMAT_VERSION`, `insertLeaves` over the packed buffer, `queryPoint`/`raycast`, rotations bound height to O(log n) |

And `Depth.js` v1.1.0 now exists, so the roadmap can be anchored to findings in
real lines instead of intentions. Fifteen findings are listed in section 2.

**Honesty note.** Every finding below carries a file:line citation and a
reproduction recipe. They are read-derived, not yet executed -- this package has
no torture entry point to execute them against. **Session D0 exists precisely to
close that gap**, and the first task of every later brief is to reproduce its
findings before fixing them. A finding that cannot be made to fail is not a
finding; it is a guess, and it gets deleted rather than "fixed".

---

## 0. Scope and metadata check (before anything else)

Verified in `package.json`:

| Field | Value | Verdict |
| --- | --- | --- |
| scope | `@zakkster/lite-depth` (one `s`) | correct |
| `dependencies` | `lite-arena ^1.9.0`, `lite-fastbit32 ^1.2.0`, `lite-aabb ^2.0.0` | correct, resolvable |
| `repository` / `bugs` / `funding` | all point at `lite-depth` | correct (not cross-wired like lite-arena 1.4.0 was) |
| `files[]` | ships `README.md`, `CHANGELOG.md`, `llms.txt`, no `test/` | correct |
| `devDependencies` | `@zakkster/lite-gc-profiler ^1.3.1` | **WRONG FLOOR -- see D-09** |

Three runtime deps is the declared substrate and the ceiling. **`lite-bvh` and
`lite-sat` do NOT become runtime deps** -- they enter by DI
(`stage.useSpatialIndex(tree)`), the same shape as `stage.useSignals({ effect })`
today. A renderer that cannot render without a spatial index is a different
package.

---

## 1. Shared law (holds every session)

1. **Zero allocation on the frame path.** `stage.frame(dt)` and
   `mixer.update(dt)` allocate zero bytes. Creation and reconfiguration are cold
   and may allocate freely. Gated as **bytes per op** (`measureOps`), never as a
   raw scavenge count -- a scavenge count tracks how long a loop ran, not how
   much it allocated. This is already the standard `Motion.js` was held to; it
   now applies package-wide.
2. **Bytes in a hot body, not instructions.** Every guard added below must be
   provably absent from the per-vertex and per-face loops -- diff the function or
   gate it with `assertOps`. A branch that never fires still costs its bytes in
   the hot body. A validation layer that costs the fast path is a rejected
   design, not a tradeoff.
3. **Fail closed on unverified state. Null is not zero.** A stale parent handle,
   a NaN lane, an over-budget vertex cursor and a detached Worker buffer are all
   the same bug class: an unverified state accepted silently and surfacing three
   frames later as a missing object. Each gets a decided policy: **throw**,
   **documented no-op with a counter**, or **documented undefined**. "Silently
   renders wrong" is not one of the three.
4. **The substrate's contracts are law, not suggestions.** Handle layout is
   opaque (`lite-arena` llms.txt) -- no `h & 0xFFFFF` anywhere. The AABB layout
   is `FORMAT_VERSION`-versioned -- assert it, do not assume it. `aabb2` is
   frozen; do not monkey-patch it.
5. **ASCII-only source.** `->`, `<=`, `x`, "degrees". U+00D7 and U+00B5 excepted.
   Grep every new file for stray tool-call tags before trusting it.
6. **Every gate must be provably able to fail.** Every torture tier ships a
   deliberately-broken control variant that makes it exit non-zero.

### Locked decisions carried forward from rev 3 (still correct, do not relitigate)

1. **Scope:** pure Canvas2D painter engine. No renderer abstraction, no pluggable
   projection strategies. A WebGL bridge is a separate package consuming a frozen
   lane spec.
2. **Name:** `lite-depth` -- Z-axis, projection, depth sorting. Not a rasterizer.
3. **Camera:** core ships orbit math and plain setters. Interaction
   (inertia, pinch-dolly, damping) is a companion package.
4. **Precision hybrid:** `Float32Array` for static geometry stores,
   `Float64Array` for frame arenas and math registers. One f32 -> f64 conversion
   per vertex during projection, unavoidable, cheap.
5. **Perf bars:** primary on the 10-year-old MacBook Pro; secondary 5k-face scene
   at stable 60fps on iPhone 11 / mid-tier Android.
6. **Dependency policy:** three runtime deps (arena, fastbit32, aabb). Optional
   cold-path peers only. **Amended:** rev 3 listed `lite-sat` as a v1.2 runtime
   dep -- it is demoted to an optional peer (see section 3).

---

## 2. Verified findings

Read against `Depth.js` / `Motion.js` v1.1.0. Severity: **S1** = silent wrong
output or corruption, **S2** = broken documented guarantee, **S3** =
hygiene/contract gap.

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **D-01** | **S1** | **Hand-decomposed handles, failing open.** `rebuildTopo` resolves a parent with `sparse[ph & INDEX_MASK]` (`Depth.js:405`, local `INDEX_MASK = 0xFFFFF` at line 27). lite-arena's contract: "Handle layout is opaque. Never decompose entity handles by hand." There is no liveness check, so a parent handle whose node was despawned resolves to whatever entity now occupies that slot -- the child silently inherits a stranger's world matrix, or index `0`'s. The generational handle exists to prevent exactly this and is being bypassed. | `p = addNode(); c = addNode(_,_,{parent:p}); remove(p); addNode();` -> `c` follows the new node |
| **D-02** | S1 | Same decomposition in the **hot** path: `Motion.js:210` does `sparse[cNode[id] & INDEX_MASK]` once per clip per frame. Same fail-open, plus a per-frame lookup that a cold cache would remove entirely. | animate a clip on a node, despawn the node, keep updating |
| **D-03** | **S1** | **Flat shading ignores parent rotation.** `paint()` rotates the face normal by the node's LOCAL quaternion lanes (`Depth.js:614`, `qxL[d]..qwL[d]`) while the geometry is drawn from the WORLD matrix. Any child of a rotated parent is lit as if the parent were unrotated -- wrong for every hierarchical scene, and invisible in review because ambient makes it merely "look flat". | box parented to a node at `setEuler(0, PI/2, 0)`; faces light as if unrotated |
| **D-04** | S2 | **`NON_UNIFORM_SCALE` is computed and never consumed.** `setScale` maintains `F_NONUNIF` (`Depth.js:372`) and nothing reads it. `quatRotate` assumes uniform scale, so a non-uniformly scaled node gets a wrong normal, silently, with a flag sitting right there that says so. Rev 3 promised an "inverse-transpose slow path". | `setScale(h, 3, 1, 1)` on a sphere -> shading unchanged |
| **D-05** | S2 | **`material.fill` is documented and never read.** `material({ fill: false })` is in the API (`Depth.js:225`, llms.txt line 52) and `paint()` never consults it -- every face fills regardless. Per-face stroke/fill+stroke, promised by the header's "stroke-friendly" line (`Depth.js:4`), does not exist: only `kind === 'stroke'` polylines stroke. | `material({fill:false, stroke:'#f00'})` -> solid fill |
| **D-06** | **S1** | **NaN sorts to the far plane instead of being rejected.** A NaN lane (the `scaleKey` NaN bug fixed in 1.1.0 is the precedent) yields NaN screen coords; `minx/maxx` keep their `1e9` sentinels, `aabb2.intersects` returns `false` for some faces but `quantize` returns `(NaN * DEPTH_MAX) | 0 === 0` for others, so a poisoned face paints FIRST, at the back, forever, with no counter incremented. NaN is laundered into a valid sort key. | write `NaN` into `D.px[d]`, then `frame()` -> `drawKey === 0`, `facesCulled` unchanged |
| **D-07** | S2 | **Frame-arena overflow is silent by design.** `vc` and `dc` are never checked against `maxVerts` / `maxDrawFaces` (`Depth.js:509`, `547`). Typed arrays discard out-of-range writes, so an undersized stage drops geometry with zero signal. llms.txt admits this ("Undersizing silently drops geometry", "silent OOB") -- a documented footgun is still a footgun, and one compare per NODE (not per vertex) closes it. | `createStage(ctx,{maxVerts:16})` with two boxes -> second box vanishes |
| **D-08** | S3 | No `stage.clear()`, no `stage.reserve()`, no `remainingNodes()`. A scene reload must build a whole new stage (every frame arena reallocated). lite-arena 1.9.0 ships `clear()` (O(capacity), allocates nothing) and `reserve()`; neither is surfaced. Retirement is invisible: `arena.spawn()`'s throw now names full-vs-retirement-shrunk and `addNode` passes it through unlabelled. | `stage.clear` -> `undefined` |
| **D-09** | S3 | **devDep floor too low for the gate the law requires.** `@zakkster/lite-gc-profiler ^1.3.1` (`package.json:114`). The torture spec needs `maxArrayBuffersGrowth` with `stabilize: 'deep'` and relies on unknown rule keys throwing (v1.10.0+). Under ^1.3.1 an unknown rule key may be ignored -- a gate that silently accepts a typo'd rule is decorative. No `@zakkster/lite-leak` devDep at all. | `package.json` |
| **D-10** | RESOLVED | **No torture entry point.** ~~This package has no `test/torture.mjs`, no `torture` script, and no `prepublishOnly` gate.~~ Added `test/torture.mjs` (Phases A retention / B GC-budget / C inverted control), the `torture` script, and a `prepublishOnly: npm run verify` gate. `node --expose-gc test/torture.mjs` -> `ok`, exit 0; `DEPTH_TORTURE_LEAK=1` proves the gate is load-bearing. | `npm run torture` -> ok |
| **D-11** | RESOLVED | **Docs-vs-tree drift in the test count.** llms.txt line 163 claimed "9 files: core 01-04, motion 05-09"; the tree actually has 6: `01-math`, `03-pipeline`, `04-zero-gc`, `06-motion-quaternion`, `07-motion-loop-scrub`, `09-motion-zero-gc` (02, 05, 08 never existed -- this row's own earlier "5" also miscounted, omitting 07). Reconciled: llms.txt now states "6 files: core 01/03/04, motion 06/07/09". | `ls test/*.test.js` -> 6 files |
| **D-12** | S3 | **`aabb2` used at 3 of 22 ops, all in the wrong place.** Only `create`/`set`/`intersects` are used, and `set` + `intersects` fire twice per FACE in the hot body (`Depth.js:534-535`) -- two call boundaries where four inline compares would do, on the finest-grained loop in the package. Meanwhile the coarse node level, where a packed box would reject whole meshes at once, does a scalar radius test only. The dependency is being paid for at the worst granularity. | `Depth.js:520-548` |
| **D-13** | RESOLVED | **`stats` cannot see the failure modes above.** Added `stats.nodesTotal` (live count) plus reserved always-zero `facesOverflowed` / `nodesInvalid` hooks, set in the cold preamble outside both loops. `stage._order` / `stage._drawCount` are now frozen as read-only getters (observation-only) and pinned by `test/10-stats-drawlist.test.js` -- the contract a test relied on is now written down. | `test/10-stats-drawlist.test.js` |
| **D-14** | S3 | `PICKABLE`, `BILLBOARD`, `CAST_SHADOW` occupy bits in the frozen `FLAGS` namespace (`Depth.js:34`) and are read by nothing. Bits in a published namespace are a compatibility surface; three of eight are reserved for features not on any dated milestone. | `Depth.js:34-42` |
| **D-15** | S3 | The cycle guard in `rebuildTopo` (`Depth.js:414`) treats a parent cycle as a root and continues -- silently. Fail-closed says a cycle is a caller bug that should be named. It is also untested. | `setParent(a,b); setParent(b,a)` -> renders, no signal |

### The one invariant that catches four of these at once

```
arena.activeCount + arena.retiredCount + arena.remainingCapacity() === arena.capacity
```

lite-arena guarantees it after every operation. Assert it between torture phases
and after every `stage.clear()` / churn cycle: D-01, D-08 and any future
lifecycle bug violate it or its lite-depth twin
(`nodes.count === arena.activeCount`) immediately. It is O(1), so it belongs in
the soak tier, never in `frame()`.

---

## 3. Disposition of the rev-3 roadmap

| Rev-3 item | Status | Why |
| --- | --- | --- |
| Decisions 1-5 (scope, name, camera, precision hybrid, perf bars) | **KEEP** | Correct and load-bearing; restated in section 1. |
| Decision 6 -- `lite-sat` as a v1.2 **runtime** dep | **AMENDED** | Demoted to optional peer. Narrowphase SAT is needed only for marquee/polygon picking; `aabb2.containsPoint` covers point picking with zero new deps. Three runtime deps stays the ceiling. |
| "per-instance screen AABBs `Float32Array(4*maxNodes)` in lite-aabb format" | **REVIVED, was never shipped** | v1.1.0 has no such buffer. It is now the centrepiece of D3 and the feed for D4, made worthwhile by `mergeAll`/`fattenAll`/`intersectsAny`. |
| v1.2 "Touch": picking = lite-aabb broadphase + lite-sat narrowphase | **SUPERSEDED (partly)** | Broadphase is now `DynamicBVH2D` via DI -- `FORMAT_VERSION`-compatible leaf boxes, `insertLeaves` over the same packed buffer `fattenAll` produces, `queryPoint`/`raycast` shipped. A linear per-node scan is no longer the best available answer. `lite-sat` survives for convex narrowphase and marquee MTV only. |
| v1.2 near-plane Sutherland-Hodgman clip | **KEEP** | Dependency-independent correctness. Moves to D4. |
| v1.2 "orbit interaction stays external" | **KEEP** | Decision 3. |
| v1.3 "Shade": hemisphere/rim modes, per-face material lane, dashes, billboards, sprites, affine-textured quads | **KEEP, RESEQUENCED** | Presentation work is correctly last. But **D-03/D-04/D-05 must land first**: adding shade modes on top of a normal that ignores parent rotation ships a prettier wrong answer. |
| v1.3 planar projected ground shadows via layer/bias | **KEEP, UPGRADED** | The caster set becomes a `registerTag()` membership set consumed by `joinN([Caster],[Culled])`, so the shadow pass iterates casters, not all nodes. |
| "Perspective + orthographic camera" | **DONE in 1.1.0** | The `stage.ortho` vs `camera.ortho` bug is fixed; ortho is reachable. Remaining ortho work is depth quantization (residual item 2). |
| Residual 1: orbit companion package naming | **KEEP OPEN** | Decide by D4. |
| Residual 2: `quantize26` linear vs 1/z | **KEEP OPEN, now blocking** | Must be decided and frozen in D7, because the key format becomes a published contract there. |
| Residual 3: layer bit budget (6 bits) | **KEEP OPEN, now blocking** | Same -- frozen in D7. |
| `lite-depth-gl` bridge, "Beyond the line" | **KEEP** | Requires the frozen lane spec that D7 produces. Go/no-go after real projects hit the painter ceiling. |
| "true frustum culling out of scope; lite-aabb is 2D, post-projection" | **KEEP** | Still true. `aabb2` is screen-space only. The node-level reject stays a view-space sphere test. |

---

## 4. The torture suite (`test/torture.mjs`) -- spec

One harness, ten tiers, built once in D0 and extended by each later session.
This is the DONE-WHEN gate every brief leans on.

### Layout

```
test/
  torture.mjs           # entry: runs tiers in order, prints exactly "ok", exit 0/1
  torture/
    harness.mjs         # scratch pool, zero-alloc asserts, seeded PRNG, gc wrappers, stub ctx
    t0-laws.mjs         # metamorphic laws of the pipeline
    t1-degenerate.mjs   # NaN / zero-scale / near==far / 1e9 coords
    t2-packed.mjs       # packed 4*N box aliasing matrix
    t3-adversarial.mjs  # hierarchy and churn sequences
    t4-handles.mjs      # stale handles, retirement sweep, clear()
    t5-fuzz.mjs         # differential fuzz vs a brute-force painter oracle
    t6-alloc.mjs        # bytes/op + maxArrayBuffersGrowth gate
    t7-soak.mjs         # 4096 build/teardown cycles + conservation law
    t8-cross.mjs        # aabb <-> bvh FORMAT_VERSION conformance
    t9-controls.mjs     # every gate above, deliberately broken, must fail
```

`test/` never enters `files[]`. `npm pack --dry-run` proves it.

### Harness rules

- Every stage, geometry, material, scratch box and packed buffer is allocated
  **once**, outside every loop. No `aabb2.create()`, no `createStage()`, no
  closure per iteration.
- Canvas2D `ctx` is a pre-allocated stub object with counter methods. It must not
  build strings: a template literal per `fillStyle` assignment is an allocation
  and will fail your own gate.
- Assertions in hot loops compare into pre-allocated scratch and build a message
  string **only on failure**.
- Seeded xorshift32 PRNG. On failure print the seed and the op index:
  `TORTURE_SEED=... node --expose-gc test/torture.mjs`.
- lite-gc-profiler: **one measurement at a time**. `measureOps` / `measureFrames`
  / `measureOpsAsync` share the heap and throw "already in flight" if nested.
  Tiers run sequentially, never nested.
- Unknown rule keys **throw** as of profiler v1.10.0 -- which is why D-09 raises
  the devDep floor before any tier is written. There is no `maxExternalGrowth`.
- Never resolve an unexpected `inconclusive` with `allowInconclusive`. Triage via
  the profiler's `INCONCLUSIVE.md`.
- `await gc.settle()` before reading any summary -- the perf_hooks GC observer
  delivers asynchronously (already documented in llms.txt line 113).

### Tier T0 -- metamorphic laws

- Paint order is depth-monotonic: for all `i < j`, `drawKey[order[i]] <= drawKey[order[j]]`.
- Layer dominates depth: a node at `layer 1` always paints after every `layer 0`
  face, at any depth.
- `frame()` is idempotent on a static scene: two consecutive frames produce
  byte-identical `drawKey`, `drawNode`, `drawFace` and `screenXY`.
- Translating the whole scene and the camera by the same vector leaves
  `screenXY` unchanged within f64 noise.
- `setVisible(h,false)` removes exactly that node's faces from the draw list and
  changes nothing else.
- `facesDrawn + facesCulled` equals the visible-node face total, always. Today no
  counter accounts for overflowed faces -- that is D-07.

### Tier T1 -- degenerate values

Cross every stage op with: NaN in each of `px..sz`; zero scale; negative scale;
`near === far`; `far < near`; a node at exactly the near plane; coordinates at
`1e7` (where f32 margins evaporate -- lite-aabb finding A-01); quaternions that
are not unit; a geometry with `V === 0`; `maxNodes` of 1. Pin the ACTUAL answer
for each, including the ugly ones. Pinning "this drops the face and increments
`nodesInvalid`" is a valid contract; leaving it unpinned is not.

### Tier T2 -- the packed aliasing matrix

For the node-box buffer introduced in D3:

| Case | Rule (from lite-aabb `FORMAT.md` / decisions/0005 D4) |
| --- | --- |
| `fattenAll(out, in, m, n)` with `out === in` | **safe** (in place) |
| `fattenAll` with `out` fully disjoint | **safe** |
| `fattenAll` with `out` a shifted/overlapping view of `in` | **FORBIDDEN** -- element-wise write clobbers a neighbour |
| `mergeAll(out4, in, n)` with `out4` anywhere inside `in` | **safe** (single terminal write) |
| `intersectsAny(in, b, n)` with `b` a view into `in` | **safe** (read-only) |
| `count` of 0 / negative / NaN | zero iterations, `mergeAll` yields the empty sentinel |

Each row gets a named test. lite-depth must never construct the forbidden shape,
and the test is what proves it never will.

### Tier T3 -- adversarial scenes

Chain of 2000 nodes each parented to the previous (topo depth 2000); reparent
storm (500 reparents per frame); parent cycle (D-15); despawn a parent with 100
live children (D-01); every node dirty every frame; every node invisible; all
nodes at one point; a scene entirely behind the camera; a scene entirely in front
of the near plane; `maxDrawFaces` exactly hit, then exceeded by one (D-07).

### Tier T4 -- handle and lifecycle abuse

Stale handle after `remove()`; `setPosition` on a stale handle; parent set to a
stale handle; handle held across `stage.clear()`; a generation sweep driving one
slot to retirement and asserting `remainingCapacity()` tracks exactly;
`addNode()` on an exhausted arena asserting the throw NAMES retirement vs full.
Each case gets a decided policy: throw, documented no-op with a counter, or
documented undefined.

### Tier T5 -- differential fuzz against an oracle

Brute-force reference painter: plain arrays, `Array.prototype.sort` with a
comparator, naive per-face transform. Run 100k mixed ops (add / remove /
reparent / move / frame) against both and compare the **sorted draw list** --
same faces, same relative depth order. Divergence prints the seed and op index.
This is the tier that finds the bug nobody thought to name.

### Tier T6 -- the zero-alloc gate

```js
// shape only -- read ../LiteGCProfiler/llms.txt for the exact current surface
const summary = await measureOps(runFrames, { stabilize: 'deep' /* ... */ });
const verdict = checkNoGc(summary, {
  maxMajor: 0,
  maxPauseMs: 4,
  maxArrayBuffersGrowth: 0,
});
```

Plus direct structural assertions no heap gate can substitute for:

```js
assert.equal(stage._draw.screenXY.buffer.byteLength, BYTES_BEFORE);
assert.equal(nodeBoxes.length, 4 * maxNodes, 'node box lane grew');
```

Bytes per op is the primary number; scavenge counts are confounded by wall-clock
time and are reported, not gated.

### Tier T7 -- soak and conservation

`leak_cycles: 4096` build-up / tear-down cycles over ONE stage using
`stage.clear()` (D1) rather than a new stage per cycle -- a stage per cycle is
itself an allocation the gate would have to tolerate. After each cycle assert
`nodes.count === 0`, `arena.activeCount === 0`, and the conservation law from
section 2. Sample the heap across cycles, never within one.

### Tier T8 -- cross-package conformance

- `import { FORMAT_VERSION as A } from '@zakkster/lite-aabb'` and the same from
  `@zakkster/lite-bvh`; assert `A === B`. This is the fail-closed door for a
  format skew and costs one comparison at stage setup.
- Build the packed node-box buffer with `aabb2.fattenAll`, feed it to
  `DynamicBVH2D.insertLeaves(packed, dataArray, count)`, `query` it, assert the
  hit set equals a linear `aabb2.intersects` scan over the same buffer.
- The margin-evaporation detector: at screen coordinates 1, 1e3, 1e6 and 1e7,
  assert `fatten` widened the box, using `aabb2.marginFloor(box)` as the clamp.

### Tier T9 -- controls (the gate must be able to fail)

An allocating frame loop (one `aabb2.create()` per face); a corrupted oracle; the
depth quantizer forced to a constant; the packed box lane fed a shifted `out`
view; a NaN lane that bypasses the `isValid` door. If a control passes, the gate
is decorative.

---

## 5. Session order

```
D0 --> D1 --> D2 --> D3 --> D4 --> D5 --> D6 --> D7
                      |              |
                      +--------------+
             (D3's packed box lane feeds both D4 picking and D5 shadows)
```

- **D0 blocks everything.** No finding below may be called fixed without a gate
  that could have caught it.
- **D1 before D3** -- the packed box lane is indexed by dense index; resolving
  dense indices correctly (D-01) comes first.
- **D2 before D5** -- shadows reuse the shading path; fixing normals after
  building a shadow pass on top of them means measuring the fix twice.
- **D3 blocks D4 and D5** -- both consume the packed `4*N` node-box buffer.
- **D7 is the only breaking session** and comes last by construction: it freezes
  the lane layout and the sort key, and nothing can be frozen while it still
  moves.

Breaking vs additive: **D0-D6 are additive** (D1, D2 and D3 change rendered
output where it was wrong, documented in CHANGELOG under Fixed, not Breaking).
**D7 is breaking.**

---

## 6. The briefs

===============================================================================
# D0 -- lite-depth v1.1.1 -- the gate this package does not have
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 1.1.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [D-09, D-10, D-11, D-13]
blocks: [D1, D2, D3, D4, D5, D6, D7]
---

# lite-depth -- stand up the torture harness, raise the profiler floor

PURPOSE
  Every zero-GC claim in README, llms.txt and CHANGELOG rests on two node:test
  files that SKIP without --expose-gc, gated by a profiler pinned three minor
  versions below the one whose behaviour the gate depends on. Build the harness
  first; fix nothing this session.

TASKS
  - Raise `@zakkster/lite-gc-profiler` to `^1.10.0` (or current). Under ^1.3.1 an
    unknown rule key may be ignored instead of throwing, so a typo in a rule name
    silently disables that rule. Add `@zakkster/lite-leak` as a devDep.
  - Build `test/torture.mjs` + `test/torture/harness.mjs` per section 4. Wire
    T0, T1, T3, T6, T7, T9 now. Register T2, T4, T5, T8 as EMPTY tiers that later
    sessions fill -- an empty registered tier is a visible debt; a missing one is
    an invisible one.
  - Add `"torture": "node --expose-gc test/torture.mjs"` and a `prepublishOnly`
    that runs `test:gc` then `torture`.
  - Reconcile the test count (D-11). llms.txt claims 9 files; the tree has 5
    (01, 03, 04, 06, 09). Either restore the missing suites or stop quoting a
    number -- describe the groups instead. Whichever, the numbering gaps get an
    explanation in the test README or the numbers get closed up.
  - Publish the draw-list introspection the tests already depend on: freeze
    `stage._order` / `stage._drawCount` as a documented read-only view, or add
    `stage.drawList()` returning them. A test pinning an underscore-private is a
    contract nobody wrote down (D-13).
  - Add `stats.facesOverflowed`, `stats.nodesInvalid`, `stats.nodesTotal` as
    always-zero counters. Wiring lands in D1/D3; the SHAPE lands now so no later
    session changes the stats object twice.

HOT PATH
  Three integer stores into an existing stats object, all outside the per-face
  loop. Diff `frame()` and prove the per-vertex and per-face bodies are byte-
  identical to v1.1.0.

ASSERTIONS
  - `node --expose-gc test/torture.mjs` prints exactly "ok", exit 0.
  - T9 control (one `aabb2.create()` per face) exits non-zero.
  - T6 gates `maxMajor: 0`, `maxPauseMs: 4`, `maxArrayBuffersGrowth: 0` with
    `stabilize: 'deep'` over 20000 frames of a 2000-node all-dirty scene, at
    0 bytes/op. This is the same bar Motion.js already meets over 20000 ops.
  - T7: 4096 build/teardown cycles; `nodes.count` returns to 0 every cycle and
    `arena.activeCount + arena.retiredCount + arena.remainingCapacity() === arena.capacity`
    after every one.
  - Passing an unknown rule key to `checkNoGc` THROWS (proves the floor is real).
  - `npm pack --dry-run` excludes `test/` and includes `CHANGELOG.md`.

NON-GOALS
  No behaviour change. No fixes -- every finding is recorded in CHANGELOG as a
  known issue with its ID and fixed in D1-D5.

DONE WHEN
  torture prints "ok"; every control fails; the profiler floor is raised;
  the stats shape is final; the test-count claim matches the tree
```

===============================================================================
# D1 -- lite-depth v1.2.0 -- stop decomposing handles; own the lifecycle
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 1.2.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: [D-01, D-02, D-07, D-08, D-15]
depends_on: [D0]
blocks: [D3]
---

# lite-depth -- the generational handle exists; use it

PURPOSE
  `Depth.js:405` and `Motion.js:210` both compute `sparse[handle & 0xFFFFF]`
  with a locally-redeclared `INDEX_MASK`. lite-arena's contract says the handle
  layout is opaque, and the reason is exactly this: the mask throws away the
  generation, which is the ONLY thing distinguishing a live parent from a
  despawned one whose slot has been reissued. A child then inherits a stranger's
  world matrix. Silently. Every frame.

  Rev 3 called generational handles the reason to use an arena at all. The code
  opts out of them in the one place they matter.

SUBSTRATE APIS USED (verified in ../LiteArena/Arena.js)
  - `SparseSet.has(entity)` (Arena.js:859) -- O(1), validates liveness AND
    membership. Zero-GC implication: a boolean test on two typed-array reads;
    it runs on the COLD topo rebuild, not per frame, so the hot body gains zero
    bytes.
  - `SparseSet.idx(entity)` (Arena.js:939) -- the unchecked fast path. Legal only
    after `has()`; used once per structural change, never per frame.
  - `Arena.clear()` (Arena.js:726) -- resets in place, rebuilds the free list,
    bumps every generation, revives retired slots, zeroes each component count.
    O(capacity) and allocates NOTHING, which is what makes a 4096-cycle soak
    tier possible without a stage per cycle.
  - `Arena.reserve(newCapacity)` (Arena.js:638) -- explicit, between-frames
    growth. Reallocates every backing array, so hoisted lane refs go STALE.
    `frame()` re-reads `nodes.data` every call, so it is already safe; the
    per-clip caches added below are not, and must be invalidated.
  - `Arena.remainingCapacity()` (Arena.js:407) -- O(1), three field reads.
  - `new Arena(n, { checked: true })` (Arena.js:220) -- dev-only assertions,
    OFF and zero-cost in production; the checked `idx` shadows the prototype
    method as an own property, so the production fast path is byte-for-byte
    unchanged.

TASKS
  - `rebuildTopo`: replace `sparse[ph & INDEX_MASK]` with
    `nodes.has(ph) ? nodes.idx(ph) : -1`. A dead parent resolves to ROOT and
    increments `stats.nodesOrphaned` -- fail closed and visible, not fail open
    and silent. Delete the local `INDEX_MASK` constant from Depth.js.
  - `Motion.js`: delete its `INDEX_MASK` too. Resolve each clip's dense index
    ONCE per structural epoch into an `Int32Array` cache keyed by clip id, and
    re-resolve when `stage.structureEpoch` changes. This removes the hand
    decomposition AND a per-clip lookup from the hot body -- bytes and
    instructions both go down.
  - Add `stage.structureEpoch` (monotonic Uint32), bumped by `addNode`,
    `remove`, `setParent` and `clear`. It is the invalidation signal for every
    cached dense index in the package and for any consumer.
  - `stage.clear()` -> `arena.clear()`, reset `nodes` counts, zero the frame
    cursors, bump the epoch. Document loudly: every handle minted before
    `clear()` is invalid afterwards -- the honest contract of a reset, and
    already lite-arena's.
  - `stage.reserve(n)` -> `arena.reserve(n)` PLUS reallocation of every
    stage-owned maxNodes-sized array (`vertBase`, `topo`, `parentDense`,
    `recomputed`, `depthArr`, `stackArr`, `levelOff`). Cold, between frames,
    explicit. Returns false when `n <= capacity`. Refuse (throw) while any
    component is detached -- lite-arena's `reserve` already refuses; do not let
    lite-depth's wrapper mask the reason.
  - `stage.remainingNodes()` -> `arena.remainingCapacity()`.
  - `addNode` must NOT swallow or rewrap `arena.spawn()`'s throw: lite-arena
    1.9.0's message already names capacity, activeCount, retiredCount and
    whether the arena is full or retirement-shrunk. Rewrapping it destroys the
    only diagnostic that distinguishes "raise maxNodes" from "stop churning one
    slot".
  - `createStage(ctx, { checked: true })` forwards to `new Arena(n, {checked:true})`.
    Default off. On in every torture tier.
  - D-07: fail closed on frame-arena overflow. ONE compare per NODE before the
    vertex loop (`vc + g.V > maxVerts`) and one before the face loop
    (`dc + g.F > maxDrawFaces`); on overflow, skip the node and increment
    `stats.facesOverflowed`. Not per vertex, not per face.
  - D-15: a parent cycle throws from `rebuildTopo` (cold) naming the two nodes,
    instead of being silently treated as a root.

HOT PATH
  `rebuildTopo` is cold (structural change only). The Motion cache resolution is
  cold. The only hot-body change is two integer compares per NODE for the
  overflow door -- measure them; a 2000-node scene pays 4000 compares per frame
  against ~100k vertex projections. Record the measured delta in the CHANGELOG;
  if it is not within noise, the design is wrong and the door moves to a
  per-frame precheck against the worst-case visible total.

ASSERTIONS
  - T4: spawn parent P, child C parented to P, `remove(P)`, spawn a new node
    (which reuses P's slot). C's world matrix equals its LOCAL matrix and
    `stats.nodesOrphaned === 1`. This test FAILS on v1.1.0 and PASSES after --
    prove both directions.
  - Grep proves zero occurrences of `& INDEX_MASK`, `& 0xFFFFF` and
    `.sparse[` in Depth.js and Motion.js.
  - `stage.clear()` allocates nothing: `maxArrayBuffersGrowth: 0` with
    `stabilize: 'deep'` over 4096 clear/rebuild cycles; `nodes.count === 0` and
    the conservation law holds after every one.
  - Every handle minted before `clear()` returns false from `arena.isAlive`.
  - `stage.reserve(8192)` on a 4096-node stage: every live node still renders
    identically, every stage-owned array has length 8192 (or 4*8192), and a
    second `frame()` is byte-identical to the pre-reserve frame.
  - Generation sweep: drive one slot to retirement, assert
    `stage.remainingNodes()` is exact after every operation, and that
    `addNode()` at exhaustion throws a message containing "retired".
  - `createStage(ctx,{maxVerts:16})` with two boxes: `stats.facesOverflowed > 0`
    and NO out-of-range write occurs.
  - `frame()` bytes/op still 0 over 20000 frames; per-face `assertOps` within
    noise of the v1.1.1 baseline.

NON-GOALS
  No shading changes (D2). No packed boxes (D3). No picking. No new deps.

DONE WHEN
  no handle is decomposed anywhere; a dead parent is named, not inherited;
  clear/reserve/remainingNodes shipped; overflow is counted, never silent
```

===============================================================================
# D2 -- lite-depth v1.3.0 -- the shading is wrong; the flags say so
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 1.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: [D-03, D-04, D-05, D-06]
depends_on: [D1]
blocks: [D5]
---

# lite-depth -- light the face that is actually drawn

PURPOSE
  `paint()` rotates the face normal by the node's LOCAL quaternion while drawing
  the face from the WORLD matrix. A child of a rotated parent is therefore lit as
  if its parent were not rotated. Every hierarchical scene in the demo set is
  affected, and ambient shading makes it read as "flat-looking" rather than
  "wrong" -- which is why it survived a release.

  Two smaller lies ride along: `NON_UNIFORM_SCALE` is maintained and never read
  (so a stretched node is lit with a normal that no longer points where the
  surface does), and `material.fill` is documented and never read (so
  `fill: false` fills).

WHY THESE FOUR TOGETHER
  They are one bug in four costumes: the shading path reads inputs that are not
  the ones the geometry path used. Fixing them separately means touching the
  same nine lines four times and measuring the hot body four times.

TASKS
  - Shade from the WORLD matrix, not the local quaternion. The upper 3x3 of the
    node's world affine already sits in lanes `m0,m1,m2,m4,m5,m6,m8,m9,m10`.
    Rotate the local face normal by it and renormalize. Decide WHERE, and record
    it: (a) in `paint()` per drawn face -- correct, but adds a normalize to the
    hottest body; (b) during collect, writing one shade byte per draw entry into
    a `Uint8Array(maxDrawFaces)` lane, so `paint()` becomes `mat.lut[shade[e]]`
    and gets FASTER than today. Recommendation: (b). It moves work off the paint
    loop entirely and pre-sizes the LUT index, and the lane is allocated once.
    Measure both; the decision record carries the numbers.
  - D-04: consume `NON_UNIFORM_SCALE`. Under non-uniform scale a normal must be
    transformed by the inverse-transpose. Options, decide and record: (a) compute
    the inverse-transpose of the upper 3x3 for flagged nodes only, once per node
    per frame, in the collect pass -- cost scales with FLAGGED nodes, not all;
    (b) reject non-uniform scale at `setScale` with a documented throw.
    Recommendation: (a) -- rev 3 promised it, the flag exists to route it, and
    per-node cost is amortized across all its faces.
  - D-05: honour `material.fill`. `fill === false` emits no fill; a material with
    a `stroke` strokes the face outline in the same style-run batching (one
    `beginPath` per style run, `stroke()` instead of / in addition to `fill()`).
    This is what "stroke-friendly" in the module header has been claiming.
  - D-06: fail closed on NaN. After the per-node collect, gate the node's screen
    box with `aabb2.isValid(box)` (see D3 for the box; if D3 has not landed,
    gate the node centroid's `cvz`). An invalid node is skipped and increments
    `stats.nodesInvalid`. Additionally, `quantize` must not launder NaN into 0:
    an unordered comparison result becomes a REJECT, not the far plane.
  - Update `Depth.d.ts`, `llms.txt` (the Light and Material sections both state
    the old behaviour), README, CHANGELOG under Fixed with the visual-change
    warning.

SUBSTRATE APIS USED
  - `aabb2.isValid(a)` (Aabb.js:276) -- four `Number.isFinite` plus two compares.
    It is a DOOR at the node boundary, called once per node, never per face:
    lite-aabb's own law is that validation never gets bolted into a hot op, and
    lite-depth inherits that shape rather than reinventing it.

HOT PATH
  Option (b) REMOVES a `quatRotate` + dot product + float-to-int from the paint
  loop and replaces it with one `Uint8Array` read. The per-node inverse-transpose
  runs only for `NON_UNIFORM_SCALE` nodes. The `isValid` door is one call per
  node. Net: the per-face body must be SMALLER than v1.2.0, not larger. If it is
  not, the design is wrong.

ASSERTIONS
  - A box parented to a node at `setEuler(0, PI/2, 0)` produces the same shade
    values as the same box given that world rotation directly. Fails on v1.1.0.
  - A 500-random-pose hierarchy fixture: every drawn face's shade index matches
    a reference computed from the world matrix, exactly (integer LUT index, not
    epsilon).
  - `setScale(h, 3, 1, 1)` changes at least one face's shade index; the
    inverse-transpose path is entered exactly for flagged nodes
    (`stats.nodesNonUniform === 1`).
  - `material({fill:false, stroke:'#f00'})` produces 0 `fill()` calls and >0
    `stroke()` calls on the stub ctx; `fill: true` is byte-identical to v1.2.0.
  - A NaN written into any of `px..sz`: the node is skipped,
    `stats.nodesInvalid === 1`, and NO draw entry has `drawKey === 0` from that
    node. Fails on v1.1.0, where the face paints at the far plane.
  - Per-face `assertOps` STRICTLY better than or equal to the v1.2.0 baseline.
  - bytes/op still 0 over 20000 frames; torture "ok"; T9 controls fail.

NON-GOALS
  No new shade modes (hemisphere/rim are D7-era presentation). No shadows (D5).
  No per-face material lane. No textures.

DONE WHEN
  shading reads the same transform the geometry does; the non-uniform flag is
  consumed; fill/stroke honour the material; NaN is rejected, never sorted
```

===============================================================================
# D3 -- lite-depth v1.4.0 -- the packed node-box lane (rev 3's missing buffer)
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 1.4.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: [D-12, D-06]
depends_on: [D1, D2]
blocks: [D4, D5]
---

# lite-depth -- pay for lite-aabb at the right granularity

PURPOSE
  Today `aabb2` is used at 3 of its 22 operations, and the two that run do so
  twice per FACE (`Depth.js:534-535`): `aabb2.set(_box, ...)` then
  `aabb2.intersects(_box, _viewport)`. That is two call boundaries on the finest
  loop in the package, computing a test whose four comparisons the caller could
  inline for free. Meanwhile the node level -- where one rejected box removes
  hundreds of faces at once -- gets a scalar sphere test and nothing else.

  Rev 3 specified `per-instance screen AABBs Float32Array(4*maxNodes) in
  lite-aabb format` and v1.1.0 never shipped it. lite-aabb 2.0.0's packed ops
  are what make it worth shipping now.

SUBSTRATE APIS USED (verified in ../LiteAabb/Aabb.js)
  - `aabb2.mergeAll(out4, inPacked, count)` (Aabb.js:466) -- unions N packed
    boxes into one, accumulating in registers with a single terminal write.
    Zero-GC implication: no per-box `subarray`, no allocation, and `out4` may
    alias anywhere inside `inPacked`. Gives the scene's screen union in one call
    -> a dirty-rect `clearRect` instead of a full-canvas clear.
  - `aabb2.setEmpty(out)` (Aabb.js:304) -- the canonical `[Inf,Inf,-Inf,-Inf]`
    merge identity. It is the correct SEED for the per-node accumulate; the
    current `1e9` sentinels are a hand-rolled approximation that silently wins a
    min-compare against a legitimately huge coordinate.
  - `aabb2.isValid(a)` (Aabb.js:276) -- the NaN/inverted door at the node
    boundary (shared with D2).
  - `aabb2.intersects(a, b)` (Aabb.js:228) -- stays, at the NODE level (once per
    node), where a call boundary is amortized over the node's whole face set.
  - `aabb2.FORMAT_VERSION` (Aabb.js:26) -- asserted once at `createStage`.
  - REJECTED, in writing: `aabb2.intersectsAny(inPacked, b, count)`
    (Aabb.js:497) cannot replace the viewport cull. It returns the FIRST
    intersecting index and stops; the cull needs every visible node, not the
    first. It is the right tool for picking (D4) and for a boolean
    "does anything overlap this rect" (D5), and it is written down here so
    nobody "optimizes" the cull into a one-hit probe.

TASKS
  - Allocate `nodeBox = new Float32Array(4 * maxNodes)` at stage creation, in
    lite-aabb packed layout (box for dense index d at slots 4d..4d+3). This is
    the FORMAT.md packed convention, byte-identical to what lite-bvh's
    `insertLeaves` consumes -- which is the whole reason to use it rather than
    four parallel arrays.
  - During the per-node projection pass, accumulate the node's screen bounds into
    registers (already free -- the vertex loop touches every screen coordinate)
    and write the four slots ONCE at the end of the node. Seed from `setEmpty`
    semantics (Inf/-Inf), not `1e9`.
  - Gate the node with `aabb2.isValid(nodeBox subview)` -- or better, on the four
    accumulated registers before the write, avoiding even a subview. An invalid
    node increments `stats.nodesInvalid` and contributes no faces.
  - Reject the whole node against the viewport with ONE `aabb2.intersects` call
    per node (not per face). A rejected node skips its entire face loop:
    `stats.nodesCulled` becomes meaningful for screen-space rejection, not just
    the depth sphere test.
  - Per-FACE, the `aabb2.set` + `aabb2.intersects` pair leaves the hot body. The
    face's min/max are already computed inline; compare them against four cached
    viewport scalars (`_vx0.._vy1`, written by `stage.resize`, cold). The
    semantics must be IDENTICAL to `aabb2.intersects` including the touching-edge
    convention (`<=` / `>=`, touching counts) -- a torture case pins the parity.
  - `aabb2.mergeAll(sceneBox, nodeBox, drawnNodeCount)` once per frame after
    collect. If `stage.dirtyRect` is enabled, `clearRect` the union of this
    frame's and last frame's `sceneBox` instead of the whole canvas. Default OFF
    (a caller compositing other layers under the canvas may depend on a full
    clear); enabling it is one boolean and is a large win on sparse scenes.
  - Assert `FORMAT_VERSION` at stage creation if a spatial index is later bound
    (D4); export it from lite-depth so a consumer can check without importing
    lite-aabb.
  - Fill torture T2 (the packed aliasing matrix) and T8 (format conformance).

HOT PATH
  Per FACE the body SHRINKS by two call boundaries. Per NODE it grows by one
  `isValid`, one `intersects` and four stores -- amortized over every face in
  the node, and it deletes the face loop entirely for offscreen nodes. Per FRAME
  it grows by one `mergeAll` over `count` boxes. `mergeAll` and `fattenAll` must
  never be handed a shifted `outPacked` view -- lite-aabb's element-wise
  `fattenAll` explicitly forbids it, and T2 is what proves lite-depth never
  constructs that shape.

ASSERTIONS
  - Face cull parity: over a 500-random-pose fixture, `facesDrawn` and
    `facesCulled` are byte-identical to v1.3.0, including faces exactly touching
    the viewport edge (touching counts as visible).
  - A node entirely offscreen executes ZERO face-loop iterations
    (`stats.nodesCulled` increments; instrument the tier, do not infer it).
  - `mergeAll(sceneBox, nodeBox, n)` equals a per-box `merge` fold, exactly, for
    n in {0, 1, 2, 1000}. n === 0 yields the empty sentinel and `isEmpty` is true.
  - `nodeBox` for a node with a NaN lane fails `isValid` and the node contributes
    zero faces.
  - Every T2 packed-aliasing row is named and passing or explicitly forbidden.
  - T8: `aabb2.FORMAT_VERSION === DynamicBVH2D FORMAT_VERSION === 1`.
  - Dirty-rect mode: on a scene occupying 10 percent of the canvas, `clearRect`
    is called with an area <= 15 percent of the canvas and the rendered output is
    pixel-identical to full-clear mode.
  - bytes/op 0 over 20000 frames; `nodeBox.length === 4 * maxNodes` before and
    after; per-face `assertOps` strictly better than the v1.3.0 baseline.

NON-GOALS
  No BVH (D4). No picking. No shadows. `aabb2` stays 2D and post-projection --
  true 3D frustum culling remains out of scope (rev 3 decision, still correct).

DONE WHEN
  the packed lane exists in FORMAT.md layout; the per-face aabb2 call pair is
  gone; node-level rejection is real and counted; mergeAll drives dirty-rect
```

===============================================================================
# D4 -- lite-depth v1.5.0 -- "Touch": near-plane clip + a real pick index
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 1.5.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-bvh", "@zakkster/lite-sat", "@zakkster/lite-gc-profiler"]
findings: []
depends_on: [D3]
---

# lite-depth -- clip the near plane, and stop scanning for picks

PURPOSE
  Two things rev 3 scheduled for v1.2 and v1.1.0 shipped without. The near-plane
  handling is still a conservative whole-face reject (CHANGELOG v1.0.0 notes say
  so explicitly), and picking does not exist at all. The substrate upgrade
  changes the second one from "linear scan over screen boxes" to "a tree that is
  already format-compatible with the buffer D3 built".

SUBSTRATE APIS USED
  - `aabb2.fattenAll(outPacked, inPacked, margin, count)` (Aabb.js:439) --
    produces the fat leaf bounds a dynamic BVH wants, over the whole packed lane
    in one call, no per-box view, zero allocation. ALIASING LAW: in-place
    (`outPacked === inPacked`) or fully disjoint ONLY -- a shifted/overlapping
    view would clobber a neighbour's input. lite-depth uses a disjoint
    `fatNodeBox` buffer, and T2 pins it.
  - `aabb2.marginFloor(a)` (Aabb.js:331) -- the smallest margin that PROVABLY
    widens a box at its coordinates. Clamp with
    `Math.max(margin, aabb2.marginFloor(box))`; without it a small margin at
    large screen coordinates silently no-ops and every `updateLeaf` takes the
    slow path forever (lite-aabb finding A-01). Fails closed: NaN -> NaN,
    Inf -> Inf.
  - `aabb2.containsPoint(a, px, py)` (Aabb.js:362) -- the exact point test,
    edges included, fails closed to `false` on NaN. Replaces the hand-rolled
    four-compare every picker writes.
  - `aabb2.distanceSq(a, b)` (Aabb.js:378) -- squared, so a hover radius is
    `distanceSq(box, pointBox) < r * r` with no `Math.sqrt` in the handler.
  - `aabb2.closestPoint(out2, a, px, py)` (Aabb.js:405) -- tooltip/anchor snap.
    `out2` is a LENGTH-2 buffer, the only one in the package; allocate it once
    at stage creation and name it `_out2` so the arity is visible at the call.
  - `DynamicBVH2D.insertLeaves(packed, dataArray, count)` (lite-bvh 2.0.0) --
    bulk insert straight from the packed lane, batch-atomic (validates every box
    before any mutation, so one bad box throws with the tree unchanged).
  - `DynamicBVH2D.queryPoint(x, y, outBuffer)` / `.raycast(p0x,p0y,p1x,p1y,out)` /
    `.query(box, out)` -- hits written into a caller-owned `Int32Array`, no
    callbacks, fixed-size traversal stack (rotations bound height to O(log n)).
  - `DynamicBVH2D.clear()` / `.updateLeaf(leaf, box, margin)` -- reuse across
    frames without reallocating.

  DEPENDENCY POLICY: lite-bvh is bound by DI --
  `stage.useSpatialIndex(tree, { margin })` -- exactly like
  `stage.useSignals({ effect })`. It does NOT become a fourth runtime dep.
  Without it, `stage.pick()` falls back to `aabb2.intersectsAny(nodeBox, b, n)`
  over the packed lane (correct, O(n), zero-alloc) and says so in its doc.
  `lite-sat` is an optional peer for convex narrowphase and marquee MTV only --
  demoting rev 3's decision-6 runtime-dep promise.

TASKS
  - Near-plane Sutherland-Hodgman clip: two pre-allocated ping-pong polygon
    buffers (cap 16 verts per face), paid ONLY by straddling faces. The whole-
    face reject stays the fast path; the clip is entered only when the face's
    vertex loop saw both a front and a behind vertex.
  - `stage.useSpatialIndex(tree, opts)`. Per frame, after D3's node boxes are
    written: `aabb2.fattenAll(fatNodeBox, nodeBox, margin, count)` with the
    margin clamped by `marginFloor`, then rebuild or update the tree. Decide and
    record: `clear()` + `insertLeaves` per frame (simple, O(n log n), no stale
    handles) vs `updateLeaf` per node (O(1) fast path, but lite-depth must store
    a leaf id per dense index and re-map it on swap-and-pop). Recommendation:
    `clear()` + `insertLeaves` first -- swap-and-pop reindexing plus leaf ids is
    exactly the kind of second bookkeeping structure that needs its own zero-alloc
    proof. Ship the simple one, measure, and only then consider the other.
  - `stage.pick(x, y, outBuffer)` -> count. `queryPoint` for the broadphase,
    then walk the SORTED draw list back-to-front and return the topmost hit
    whose face passes `containsPoint`, or (with lite-sat bound) point-in-convex.
  - `stage.pickRect(x0, y0, x1, y1, outBuffer)` for marquee selection;
    `stage.pickRay(...)` mapped onto `raycast`.
  - `stage.nearest(x, y, radius)` using `distanceSq` -- no sqrt.
  - Pointer plumbing ONLY (pointerdown/move/up -> pick calls). Orbit interaction
    stays external (decision 3). Resolve residual item 1 (the orbit companion's
    home) this session and write it down.
  - Fill torture T5 (differential fuzz: pick results vs a brute-force
    back-to-front scan) and extend T8 with the aabb -> bvh round trip.

HOT PATH
  `pick()` is not per-frame; the tree rebuild is. `fattenAll` walks the packed
  lane by index -- no per-box `subarray`, which is the entire reason the batch
  op exists. `insertLeaves` reads by index and allocates nothing per box. Hit
  buffers are caller-owned `Int32Array`s allocated at stage creation. The clip
  buffers are allocated once and are entered only by straddling faces -- a scene
  with no straddling face must show a byte-identical hot body to v1.4.0.

ASSERTIONS
  - A face straddling the near plane renders its clipped polygon; the same scene
    with the clip disabled drops it entirely (prove the feature by its absence).
  - `pick(x, y, out)` equals a brute-force back-to-front `containsPoint` scan
    over the full T5 fuzz corpus -- same topmost hit, every time, both with and
    without a bound spatial index.
  - Rebuilding the tree from the packed lane and querying returns the same hit
    set as `aabb2.intersectsAny` over the same lane (first-index agreement).
  - `marginFloor` clamp asserted at screen coordinates 1, 1e3, 1e6 and 1e7: the
    fat box is STRICTLY larger than the tight box at every scale.
  - `insertLeaves` with one non-finite box throws and `tree.validate()` still
    passes -- the tree is unchanged (batch-atomic).
  - Tree buffers do not grow: `tree.maxNodes` and every backing byteLength are
    identical before and after 20000 frames of rebuild+query.
  - bytes/op 0 over 20000 frames INCLUDING the pick path;
    `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'`.
  - Without `useSpatialIndex`, every pick API still returns the correct answer
    via `intersectsAny` and allocates nothing.

NON-GOALS
  No lite-bvh runtime dependency. No callback-style query APIs (they re-enter
  user code mid-traversal while the shared stack is held). No 3D raycast against
  geometry -- picking is post-projection, screen-space, by design.

DONE WHEN
  straddling faces clip; picking is oracle-verified with and without an index;
  the packed lane feeds the tree with no per-box view; margins provably widen
```

===============================================================================
# D5 -- lite-depth v1.6.0 -- "Layers": tag sets, exclusion joins, ground shadows
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 1.6.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: [D-14]
depends_on: [D2, D3]
---

# lite-depth -- iterate the set you mean, not every node

PURPOSE
  `PICKABLE`, `CAST_SHADOW` and `BILLBOARD` occupy bits in a frozen public
  namespace and drive nothing. Rev 3's ground-shadow pass would, as specced,
  walk every node and test a bit -- correct, but it pays for the whole scene to
  find the casters. lite-arena 1.9.0 has the right shape for exactly this.

SUBSTRATE APIS USED (verified in ../LiteArena/Arena.js)
  - `arena.registerTag()` (Arena.js:452) -- `registerComponent({})`: membership
    only, `data` is an empty null-prototype object. Cost is two capacity-sized
    Int32Arrays per tag (32 KB at maxNodes 4096) allocated once, cold.
  - `arena.joinN(required, excluded)` (Arena.js:549) -- "every REQ, none of EXC".
    Returns REUSED scratch `{driver, count, others, othersCount, excl, exclCount}`
    with driver = the RAREST required set. Zero-GC implication: it is a cold
    PLANNER, allocates nothing, and is called once per pass per frame -- the
    caller writes the loop. Loop to `othersCount`/`exclCount`, never `.length`
    (grow-once scratch with a possible stale tail), and consume the plan before
    the next `join`/`joinN` on the same arena.
  - `arena.join(a, b)` (Arena.js:484) -- the two-set fast path, unchanged.
  - `new Arena(n, { checked: true })` -- in checked mode, reading a stale join
    plan throws, as does a set that is both required and excluded. This is the
    test-mode guard that makes plan reuse safe to rely on.

  THE CONSTRAINT, stated once and loudly: a join driver iterates DENSE order, not
  topological order. It is therefore legal for ORDER-INDEPENDENT passes only --
  the shadow-caster pass, the pick set, a billboard pass. The transform pass must
  keep walking `topo[]`, because a parent must be composed before its child. Do
  not "optimize" the transform walk into a join.

TASKS
  - Register tags for `Pickable`, `ShadowCaster` and `Billboard`, kept in sync
    with the existing FLAGS bits (the bit stays the hot per-node test; the tag is
    the cold membership set). Record the duplication decision: the bit is one
    masked compare in the hot body and costs nothing per node; the tag turns an
    O(nodes) scan into an O(members) walk for secondary passes. Both, not either.
  - Planar projected ground shadows: `joinN([ShadowCaster], [Culled])` selects
    the caster set, flatten-project those faces onto y=0 along the light
    direction, and emit them into the SAME draw list with a lower `layer` and a
    depth bias -- rev 3's packed-key mechanism, unchanged, zero extra sort cost.
    Cost scales with flagged nodes, not scene size.
  - Feed `Culled` from D3's node-level screen rejection so the exclusion clause
    does real per-frame work rather than being decorative.
  - `stage.pickSet()` uses `joinN([Pickable],[Culled])` to bound D4's pick
    broadphase to the pickable set.
  - Per-face material override lane (`Uint16Array(maxDrawFaces)`), needed by the
    shadow pass to paint casters' flattened copies in a shadow material.
  - Document the plan-reuse rule in llms.txt: lite-depth calls `joinN` at most
    once per pass and consumes it immediately. A consumer calling `arena.joinN`
    on the same arena mid-frame invalidates lite-depth's plan -- this is
    lite-arena's documented shared-scratch contract, and it must be surfaced,
    not hidden.

HOT PATH
  `joinN` is called once per pass per frame (2-3 calls), never per node. The
  per-member loop is `driver.dense[i]` plus `has()` checks -- typed-array reads,
  no closures. The shadow pass adds draw entries, so `maxDrawFaces` sizing
  guidance in llms.txt must be updated: casters count twice.

ASSERTIONS
  - `joinN([ShadowCaster],[Culled])` returns exactly the flagged, unculled set
    over a 1000-node fixture with a randomized caster/culled assignment; compared
    against a brute-force filter, every frame, for 1000 frames.
  - Shadow faces always paint UNDER their casters: for every caster, its shadow
    entries' `drawKey` is strictly less than its own.
  - The shadow pass costs zero when no node is flagged: `assertOps` byte-
    identical to v1.5.0 on an unflagged scene.
  - `stats.facesDrawn` accounts for shadow faces separately
    (`stats.shadowFacesDrawn`), so a caster is never double-counted.
  - In checked mode, reading a lite-depth join plan after a consumer's `joinN`
    THROWS rather than iterating a rewritten plan.
  - bytes/op 0 over 20000 frames with shadows on; tag registration allocates only
    at setup (`maxArrayBuffersGrowth: 0` across the frame loop).
  - Every FLAGS bit is either consumed by code or removed from the namespace
    (D-14). A reserved bit ships only with a dated milestone beside it.

NON-GOALS
  No transform-pass join (topological order is not negotiable). No soft shadows,
  no shadow maps -- this is a flatten-matrix projection onto one plane.
  No textures, no billboards beyond the tag (presentation is D7-era).

DONE WHEN
  every FLAGS bit is consumed or deleted; shadows iterate casters, not the scene;
  the exclusion clause does visible work; plan reuse is documented and guarded
```

===============================================================================
# D6 -- lite-depth v1.7.0 -- "Offthread": Worker transform via detach/rebind
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 1.7.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: []
depends_on: [D3]
---

# lite-depth -- move the matrix composition off the main thread, opt-in

PURPOSE
  The transform pass is pure arithmetic over typed arrays with no canvas
  interaction, which makes it the one stage that can leave the main thread.
  lite-arena 1.9.0 ships the exact mechanism, and it works INSIDE a Twitch
  extension iframe -- plain `ArrayBuffer` transfer, no SharedArrayBuffer, no
  cross-origin isolation, no atomics. That is the constraint that killed every
  previous off-thread idea in this ecosystem.

SUBSTRATE APIS USED (verified in ../LiteArena/Arena.js)
  - `SparseSet.detach(keys)` (Arena.js:988) -- collects the backing buffer(s) for
    a `postMessage` transfer list. Transferring detaches the sender's view
    (`byteLength` 0). Zero-copy: nothing is cloned, so the hot path pays no
    serialization.
  - `SparseSet.isDetached(key)` (Arena.js:1024) -- truthful (`byteLength === 0`)
    and explicitly sanctioned as a ONCE-PER-FRAME system guard. Raw `data[key][i]`
    reads are NOT policed (they cannot be without taxing the hot path), so a hot
    loop over a detached field is a caller bug -- which is why the guard runs at
    the top of `frame()`, not inside it.
  - `SparseSet.rebind(buffers)` (Arena.js:1055) -- re-adopts the returned
    buffer(s). PARTIAL and fail-closed: unknown key, wrong type or wrong size
    throws, and NOTHING is re-pointed until every buffer passes.
  - `registerComponent(schema, { buffers })` (Arena.js:434) -- the caller-backed
    variant, one buffer per field, exactly `capacity * BYTES_PER_ELEMENT` bytes,
    validated both directions.
  - `arena.reserve()` refuses a component with a detached field, and refuses any
    caller-backed component outright. `stage.reserve()` (D1) must surface that
    refusal, not mask it.

  THE CONSTRAINT: only `data.*` is shareable. `count` and `dense` are NOT, so a
  Worker cannot iterate the set itself. lite-depth therefore transfers its OWN
  `topo` and `parentDense` arrays as ordinary transferables alongside the arena
  lanes -- they are stage-owned `Uint32Array`/`Int32Array`, not arena state, so
  this is not a workaround, it is the documented division.

TASKS
  - `stage.useWorker(worker)` -- opt-in, DI, default absent. Absent means the
    code path does not exist in the frame body (a branch that never fires still
    costs its bytes: gate it at the top of `frame()` on one boolean, and keep the
    off-thread body in a separate function so V8 never inlines it into the hot
    one).
  - Send leg: `nodes.detach(['px'..'sz', 'm0'..'m11'])` plus the stage-owned
    `topo` / `parentDense` buffers, one `postMessage` with a transfer list.
  - Worker: composes TRS -> local -> world in topo order (`composeTRS` +
    `mulAffine`, already exported as `mathKernels`, already out-param and
    allocation-free -- the Worker imports the SAME kernels, it does not
    reimplement them) and transfers everything back.
  - Return leg: `nodes.rebind({ px: buf, ... })`, fail-closed; a size or type
    mismatch throws with nothing re-pointed.
  - Fail-closed frame policy, decided and recorded: if the buffers have not
    returned when `frame()` runs, `isDetached('m0')` is true -> the transform
    pass is SKIPPED and the previous frame's world matrices are reused. But the
    Worker holds the world-lane buffer while composing, so "reuse the previous
    world matrices" requires a main-thread SHADOW COPY of the world lanes, or a
    whole-frame skip. Decide which, measure the memory cost of the shadow copy,
    and write the rejection of the other down. Under no circumstances may
    `frame()` read a detached lane.
  - One-frame pipeline latency is inherent and must be documented, not hidden:
    frame N paints matrices composed from frame N-1's lanes.
  - `demo/` gains an off-thread toggle mirroring lite-arena's own demo backend.

HOT PATH
  The main-thread frame body must be byte-identical to v1.6.0 when no Worker is
  bound -- diff it. With a Worker bound, the transform loop is GONE from the main
  thread and replaced by one `isDetached` check plus one `postMessage`. The
  transfer is the fence: the buffer is owned by exactly one thread at a time.
  No atomics, no locking, no multi-writer.

ASSERTIONS
  - A `worker_threads` test proving the round trip twice: detach -> transfer ->
    compose -> transfer back -> rebind, with world matrices byte-identical to the
    single-threaded path (f64 exact, not epsilon).
  - `frame()` while a lane is detached does NOT read it: the recorded policy
    fires and `stats.offthreadStalls` increments.
  - `rebind` with a wrong-size buffer throws and NO lane is re-pointed (assert
    every lane's `byteLength` is unchanged after the throw).
  - `stage.reserve()` while detached throws, and the message names the detached
    field.
  - No-Worker path: `assertOps` and bytes/op byte-identical to v1.6.0.
  - Worker path: 0 bytes/op on the main thread over 20000 frames; transfer count
    is exactly 1 postMessage per frame per direction (no per-buffer message).

NON-GOALS
  No SharedArrayBuffer (it would break the iframe target). No multi-worker fan
  out. No off-thread projection or paint -- projection writes the screen arena
  that paint reads on the same tick, and Canvas2D is main-thread by definition.

DONE WHEN
  the round trip is proven across a real thread boundary, twice; a detached lane
  is never read; the stall policy is recorded with its memory cost
```

===============================================================================
# D7 -- lite-depth v2.0.0 -- freeze the lane spec and the sort key (BREAKING)
===============================================================================

```markdown
---
package: "@zakkster/lite-depth"
version_target: 2.0.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: []
depends_on: [D4, D5, D6]
---

# lite-depth -- publish the binary contract, then stop moving it

PURPOSE
  Rev 3 promised `LANES.md`, "frozen at v1.0.0", as the precondition for a
  `lite-depth-gl` bridge. It was never written, and three residual decisions are
  still open: the depth quantization curve, the layer bit budget, and the flag
  bit assignment. Every one of them is a wire format the moment a second package
  reads it. This session decides all three, writes them down, and takes the major
  bump that publishing a binary layout deserves.

TASKS
  - `LANES.md`: the per-node lane names and types, the geometry store layout, the
    frame-arena layout, the packed node-box layout (deferring to lite-aabb's
    `FORMAT.md` rather than restating it), the sort-key bit layout, and a
    `LANE_VERSION` integer constant exported from `Depth.js`, on a separate axis
    from the semver `VERSION` -- the same shape lite-aabb and lite-bvh use for
    `FORMAT_VERSION`, and for the same reason.
  - **Residual 2, decided:** `quantize26` linear-in-viewZ vs 1/z-weighted.
    Measure both on the reference hardware against a fixture with heavy near-
    camera geometry, count the sort inversions each produces, pick once, freeze.
    The measurement table goes in the decision record; "we chose linear" without
    the table is not a decision.
  - **Residual 3, decided:** the layer bit budget. 6 bits / 26 bits of depth is
    the current split. Confirm against a real scene's layer needs before freezing;
    once `LANE_VERSION` ships, changing it is another major.
  - Freeze the `FLAGS` bit assignment as part of the spec. Any bit not consumed
    by code at this point is REMOVED (D-14 closed either way).
  - Assert `aabb2.FORMAT_VERSION` at stage creation and export lite-depth's own
    `FORMAT_VERSION` re-export so a consumer can detect a substrate skew without
    importing lite-aabb directly. Fail closed on mismatch: throw at
    `createStage`, not at first paint.
  - Migration note in CHANGELOG under Breaking, covering every renamed lane and
    the stats-object shape.
  - Presentation work rides along ONLY if it does not touch the frozen surface:
    hemisphere/rim shade modes (LUT-indexed, one dot product), dash patterns
    (pre-baked `setLineDash` arrays per style run), billboards from pre-rendered
    offscreen canvases. Textures and affine-mapped quads stay a stretch goal and
    are explicitly deferred with a written reason if they slip.

  REJECTED, in writing (this is the rejection ledger entry this session owes):
  interleaving the world matrix into one stride-12 `Float64Array` lane for cache
  locality. It is NOT expressible through lite-arena's schema -- `registerComponent`
  maps one TypedArray per field, and `{ buffers }` requires each buffer to be
  exactly `capacity * BYTES_PER_ELEMENT` bytes for its single field, so twelve
  keys cannot be views into one buffer at stride 12. Achieving it would mean
  leaving the arena for the matrix lanes, which forfeits swap-and-pop compaction
  and generational safety for a locality win nobody has measured. Measure it as a
  standalone microbenchmark first; if the win is real, it is a lite-arena feature
  request, not a lite-depth workaround.

HOT PATH
  A version assert at `createStage` is cold. Shade modes are a LUT index change,
  not a new branch per face. If the quantization decision changes `quantize`, it
  changes ONE function on the collect path -- measure it and put the number in
  the decision record.

ASSERTIONS
  - `LANE_VERSION` is exported, documented in llms.txt, and asserted by a
    conformance test that also enumerates every lane name and type.
  - A stage built against a mismatched `aabb2.FORMAT_VERSION` throws at
    `createStage` with a message naming both versions.
  - The chosen quantization produces strictly fewer sort inversions than the
    rejected one on the near-camera fixture -- with the number recorded.
  - Every FLAGS bit in the frozen namespace is consumed by code.
  - The full v1.x test suite passes against v2.0.0 except the cases the migration
    note names, and each of those has a named test asserting the NEW behaviour.
  - bytes/op 0 over 20000 frames; torture "ok"; every T9 control fails.
  - `npm pack --dry-run` ships `LANES.md`, excludes `test/`.

NON-GOALS
  No WebGL bridge (separate package, consuming this spec). No 3D frustum
  culling. No renderer abstraction -- decision 1 holds.

DONE WHEN
  LANES.md + LANE_VERSION shipped and asserted; all three residual decisions are
  closed with measurements; the stride-12 rejection is in the ledger
```

---

## 7. How to run it

In order. `status: planned -> shipped` after each `/release`. Author the brief in
the package, then `Use the planner subagent on BRIEF.md`, then coder, reviewer,
qa, then `/release <semver>`. Reviewer REJECTED goes back to coder, not forward.

The budget frontmatter is identical in every brief. This package has exactly one
identity -- a 3D renderer that allocates zero bytes per frame -- and those four
numbers never move.

### If you only do a subset

1. **D0 first, regardless.** Every claim in this document is unfalsifiable until
   there is a gate. The profiler floor (D-09) is a one-line fix that decides
   whether a typo'd rule name disables a gate silently. Nothing else has that
   ratio.
2. **D1 is non-negotiable.** `sparse[h & 0xFFFFF]` in `rebuildTopo` throws away
   the generation, which is the entire reason this package uses an arena. A
   despawned parent is inherited by its children, silently, every frame after.
   The fix is `has()` then `idx()`.
3. **D2 is the one users can see.** Flat shading reads the local quaternion while
   the geometry reads the world matrix. Every hierarchical scene has been lit
   wrong since v1.0.0, and ambient made it look like a style choice.
4. **D3 before D4 and D5, always.** Both consume the packed `4*N` node-box lane,
   and that lane is the format lite-bvh's `insertLeaves` already speaks. Building
   picking on a hand-rolled box array would mean building it twice.
5. **D7 last by construction.** A spec cannot be frozen while three of its
   constants are still open questions.

### The habit this roadmap is built around

Fifteen findings, every one carrying a file:line. Four of them -- D-01, D-03,
D-06, D-07 -- are invisible in review and obvious in a five-line probe, and all
four are the same failure shape: an unverified value accepted, used, and never
reported. A masked handle. A local quaternion where a world matrix belonged. A
NaN that quantized to a valid sort key. A cursor that walked past the end of a
typed array into nowhere.

The v1.1.0 CHANGELOG already documents this package finding two of these in
itself during hardening: the inverted back-face winding cull, masked by ambient
shading, and the depth quantization that collapsed every key to zero while the
renderer kept producing plausible pictures. Both shipped through review. Both
were caught by a test that asserted a NUMBER, not a look.

So when a brief above says "this test FAILS on v1.1.0 and PASSES after -- prove
both directions", that is not ceremony. A regression test that never failed is
decoration, and a green suite over a hole is worse than no suite: it is the
reason nobody looks there again. When the reviewer subagent reads a test, the
question is not "does this test the feature" -- it is "would this test fail if
the feature were broken".

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
