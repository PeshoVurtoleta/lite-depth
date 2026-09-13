# LANES.md -- @zakkster/lite-depth frozen binary contract

`LANE_VERSION = 1` (D7 "Freeze"). This document is the NORMATIVE spec for every
binary layout `LANE_VERSION` covers. It is on a SEPARATE axis from the semver
`version` export -- the two never track each other. A change to any layout below
bumps `LANE_VERSION`; a change to behavior that does not touch these layouts does
not.

## Scope

`LANE_VERSION` COVERS:

- the per-node arena lane set (Table A): lane names + TypedArray types;
- the FLAGS bit assignment (all 8 bits, by ordinal);
- the packKey sort-key layout (6 layer bits << 26 | 26 depth bits) AND the
  linear-in-viewZ quantize curve;
- the frame-arena lane layout + the 3 cold draw sentinels;
- the D6 Worker wire (Table B): the 23-key transfer set + worldNonUnif.

`LANE_VERSION` does NOT cover (these evolve on their own rules):

- `stats` field values or ADDITIVE stats fields -- a minor `version` bump;
- geometry-store object fields (informative section below, not frozen here);
- capacity options (`maxNodes`, `maxVerts`, `maxDrawFaces`, ...);
- the packed node-box layout -- DELEGATED to `@zakkster/lite-aabb` FORMAT.md
  (FORMAT_VERSION); do not restate it here;
- `Motion.js` (the `/motion` subpath) -- its own surface.

## Table A -- per-node arena lanes

Registered once via `arena.registerComponent` (`Depth.js`). Each lane is one
TypedArray, one element per node, grown/swap-popped with the arena. The "Wire"
column marks membership in the Worker transfer set (Table B): W = transferred,
- = main-thread-only.

| # | lane | type | wire | meaning |
|--:|------|------|:----:|---------|
| 1 | px | Float64Array | W | local position x |
| 2 | py | Float64Array | W | local position y |
| 3 | pz | Float64Array | W | local position z |
| 4 | qx | Float64Array | W | local rotation quaternion x |
| 5 | qy | Float64Array | W | local rotation quaternion y |
| 6 | qz | Float64Array | W | local rotation quaternion z |
| 7 | qw | Float64Array | W | local rotation quaternion w |
| 8 | sx | Float64Array | W | local scale x |
| 9 | sy | Float64Array | W | local scale y |
| 10 | sz | Float64Array | W | local scale z |
| 11 | m0 | Float64Array | W | world matrix (3x4 row-major) [0] |
| 12 | m1 | Float64Array | W | world matrix [1] |
| 13 | m2 | Float64Array | W | world matrix [2] |
| 14 | m3 | Float64Array | W | world matrix [3] |
| 15 | m4 | Float64Array | W | world matrix [4] |
| 16 | m5 | Float64Array | W | world matrix [5] |
| 17 | m6 | Float64Array | W | world matrix [6] |
| 18 | m7 | Float64Array | W | world matrix [7] |
| 19 | m8 | Float64Array | W | world matrix [8] |
| 20 | m9 | Float64Array | W | world matrix [9] |
| 21 | m10 | Float64Array | W | world matrix [10] |
| 22 | m11 | Float64Array | W | world matrix [11] |
| 23 | parent | Int32Array | - | parent entity handle (0 = root) |
| 24 | geom | Int32Array | - | geometry id |
| 25 | mat | Int32Array | - | material id (the node's OWN material) |
| 26 | matEff | Int32Array | - | effective material id (persistent override lane) |
| 27 | flags | Uint32Array | W | lite-fastbit32 flag word (Table C) |
| 28 | layer | Uint8Array | - | painter layer, 0..63 (fail-closed on write) |
| 29 | bias | Float64Array | - | depth bias (view-space units, added before quantize) |

29 lanes total. The 12 world-matrix lanes (m0..m11) are transform OUTPUT the
main-thread transform pass writes each frame (and the Worker writes off-thread);
they are transferred so the Worker's result comes home.

**matEff normative rule.** `matEff` (lane 26) is a NORMATIVE MEMBER of the
per-node lane set but a NORMATIVE NON-MEMBER of the transfer set (Table B).
matEff MUST NOT be transferred: a Worker round trip cannot observe or drop a
material override. It is per-node persistent cold storage, distinct from the
per-frame transient `matOverride` draw lane (frame arena). `addNode` seeds it to
`mat[d]`; `setMaterialOverride` repoints it (or `-1` restores `mat[d]`).

## Table B -- per-frame Worker wire

The send leg (`_sendLaneKeys`, `Depth.js`) transfers exactly these 23 arena lane
buffers plus the stage-owned `worldNonUnif` buffer (24 transferred buffers total).
All are refilled/rebound in place each frame -- zero allocation on the send leg.

| group | keys | count |
|-------|------|------:|
| position | px, py, pz | 3 |
| rotation | qx, qy, qz, qw | 4 |
| scale | sx, sy, sz | 3 |
| world matrix | m0 .. m11 | 12 |
| flags | flags | 1 |
| **transfer set subtotal** | | **23** |
| + stage-owned | worldNonUnif (Uint8Array, one per node) | 1 |
| **total transferred buffers** | | **24** |

`worldNonUnif` is NOT an arena lane; it is stage-owned scratch (Uint8Array, one
per node) carrying the WORLD non-uniform taint (own local F_NONUNIF OR any
non-uniform ancestor), propagated parent-before-child. The Worker returns it so
the main-thread project pass reads the same taint the transform produced.

Structural buffers (`topo`, `parentDense`) travel on a SEPARATE topo message
(`_topoMsg`), not the per-frame wire, and the Worker only READS them.

## Sort key

Faces are painted back-to-front by a packed unsigned 32-bit key:

```
bit  31                      26 25                              0
     +--------------------------+---------------------------------+
     |   layer  (6 bits, 0..63) |     depth   (26 bits, DEPTH_MAX) |
     +--------------------------+---------------------------------+
packKey(layer, depth) = ((layer & 63) << 26) | (depth & DEPTH_MAX)   (>>> 0)
```

- `DEPTH_BITS = 26`, `DEPTH_MAX = (1 << 26) - 1 = 67108863`.
- Layer occupies the high 6 bits: a higher layer paints strictly LATER (on top)
  regardless of depth.
- Depth mapping: the far plane maps to 0 (painted FIRST), the near plane maps to
  DEPTH_MAX (painted LAST, on top).

### Quantize curve (CHOSEN: linear in view-space z)

```
t = (z + far) / zSpan            // z is view-space (negative), zSpan = far - near
if (t <= 0) return 0;            // far plane / beyond -> 0
if (t >= 1) return DEPTH_MAX;    // near plane / nearer -> DEPTH_MAX
if (t > 0)  return (t * DEPTH_MAX) | 0;
return DEPTH_MAX;                // D-06 fail-closed: a NaN t is unordered, fails all
                                 // three ordered compares, and rejects to DEPTH_MAX
                                 // (loud, on top) -- it can NEVER launder into 0.
```

Strictly monotonic in z (the D5 layer-0 shadow key `cvz - rad` depends on it).
The curve was frozen against measured evidence. Fixture: 4000 faces, 4 layers,
near=1, 70% of `|centroidViewZ|` in `[near, 4*near]`. Inversions = Kendall
discordant same-layer pairs vs an exact f64 oracle (centroidViewZ + bias); ties =
faces sharing a packed 26-bit depth key.

| far/near | linear inversions | linear ties | 1/z inversions | 1/z ties | linear ns/call | 1/z ns/call |
|---------:|------------------:|------------:|---------------:|---------:|---------------:|------------:|
| 100 | 0 | 6 | 0 | 2 | 1.553 | 6.581 |
| 1000 | 0 | 22 | 0 | 6 | 1.393 | 6.611 |
| 10000 | 0 | 84 | 0 | 20 | 5.520 | 8.458 |

Both curves produce ZERO same-layer inversions; neither reorders faces. The 1/z
candidate resolves ~3-4x fewer near-camera ties but costs ~4x per call on the hot
collect path (7 call sites). The incumbent linear curve is frozen.

### Layer / depth split (CHOSEN: 6 layer / 26 depth)

View-space units per depth step under the linear curve (near=1):

| split (layer/depth) | layers | depth steps | units/step @100 | @1000 | @10000 |
|--------------------:|-------:|------------:|----------------:|------:|-------:|
| 5 / 27 | 32 | 134,217,728 | 7.376e-7 | 7.443e-6 | 7.450e-5 |
| 6 / 26 (chosen) | 64 | 67,108,864 | 1.475e-6 | 1.489e-5 | 1.490e-4 |
| 7 / 25 | 128 | 33,554,432 | 2.950e-6 | 2.977e-5 | 2.980e-4 |

Peak distinct-layer utilization across the whole test/demo/bench suite is 4 (the
highest layer ever assigned is 3); 64 layers has never been approached. 6/26 is
frozen.

## Frame-arena lanes

Pre-allocated once per stage, reused every frame (0 alloc/frame). Sizes are
capacity options (NOT frozen); the TYPES and roles are.

| lane | type | size | role |
|------|------|------|------|
| screenXY | Float64Array | 2 * maxVerts | projected screen (x,y) per vert |
| viewZ | Float64Array | maxVerts | view-space z per vert |
| vertBase | Int32Array | maxNodes | per dense-node projected vert base (this frame) |
| drawKey | Uint32Array | maxDrawFaces | packed sort key (see Sort key) |
| drawNode | Uint32Array | maxDrawFaces | dense node index per draw entry |
| drawFace | Uint32Array | maxDrawFaces | face index, OR a DRAW_* sentinel |
| matOverride | Uint16Array | maxDrawFaces | per-FRAME transient material draw lane |
| clipXY | Float64Array | 2 * maxClipVerts | LAZY: screen (x,y) of near-clipped polys |
| clipRef | Uint32Array | maxDrawFaces | LAZY: (startVert << 5) | vertCount |
| nodeBox | Float32Array | 4 * maxNodes | per-node screen box [minX,minY,maxX,maxY] |
| fatNodeBox | Float32Array | 4 * maxNodes | LAZY: margin-expanded box (spatial index) |

`nodeBox`/`fatNodeBox` use the lite-aabb packed `[minX,minY,maxX,maxY]` float32x4
layout -- see `@zakkster/lite-aabb` FORMAT.md (FORMAT_VERSION); NOT restated here.
`createStage` asserts `FORMAT_VERSION === 1` before any allocation and fails
closed if the peer drifts.

### Draw sentinels (cold entry kinds in `drawFace`)

A real face index is tiny, so these top-of-range values can never collide with
one. Paint discriminates all three cold kinds with a single `fi >= DRAW_SHADOW`
compare, then splits inside the cold branch.

| sentinel | value | meaning |
|----------|-------|---------|
| DRAW_STROKE | 0xFFFFFFFF | one whole-polyline entry (stroke geometry) |
| DRAW_CLIP | 0xFFFFFFFE | one near-plane-clipped polygon (explicit clipXY verts) |
| DRAW_SHADOW | 0xFFFFFFFD | one flatten-projected ground-shadow polygon (D5) |

## FLAGS freeze table

Flag namespace via lite-fastbit32 BitMapper; bits assigned by array ordinal
(`Depth.js`). All 8 bits are frozen in this order. A bit is freeze-legal when it
is CONSUMED by code OR RESERVED with a dated milestone comment naming the
consuming session (in source, not only here).

| bit | name | status | reader(s) / rationale |
|----:|------|--------|-----------------------|
| 0 | VISIBLE | consumed | visibility skip in both collect paths + shadow pass |
| 1 | PICKABLE | consumed | bit mirrored into the Pickable tag; tag consumed by pickSet |
| 2 | DIRTY | consumed | recompose gate in the transform pass |
| 3 | NON_UNIFORM_SCALE | consumed | worldNonUnif taint (Depth.js + DepthWorker.js + Motion.js) |
| 4 | BILLBOARD | RESERVED | see below |
| 5 | CAST_SHADOW | consumed | bit mirrored into the ShadowCaster tag; tag consumed by the shadow pass |
| 6 | DOUBLE_SIDED | consumed | backface-cull override in both collect paths + shadow flatten |
| 7 | STROKE | consumed | stroke branch in both collect paths + shadow skip |

**BILLBOARD (bit 4) is reserved.** No draw consumer in 2.0.0. The bit, its public
setter (`setBillboard`), the `addNode({ billboard })` init, and the Billboard
arena tag are maintained in lockstep so a D8 "Sprites" consumer can walk the set
in O(members) via `joinN` without a flags-word renumber. Removing it would shift
CAST_SHADOW/DOUBLE_SIDED/STROKE and force a SECOND major bump when the consumer
lands -- that cost is rejected. The source declaration carries the dated
milestone comment (`reserved: D8 Sprites`).

## Geometry store (informative -- NOT frozen by LANE_VERSION)

`geometry()` returns a shareable, immutable-on-the-hot-path record: `{ V, F,
drawSlots, verts (Float32, xyz interleaved), faceVertOffset (CSR, length F+1),
faceVerts (Uint32), faceNormal (Float32), radius, kind }`. These object fields
evolve on the normal semver track; they are documented here for completeness only
and are not part of the frozen contract.

## LANE_VERSION policy

Bump `LANE_VERSION` (and cut a major `version`) when any of the following change:
a per-node lane name or type (Table A); the transfer set membership (Table B); the
packKey bit split or the quantize curve; the FLAGS bit ordinal assignment; a
frame-arena lane TYPE or a DRAW_* sentinel value. Do NOT bump it for: an additive
`stats` field, a capacity-option change, a geometry-store field, a node-box layout
change (that is lite-aabb FORMAT_VERSION's axis), or a `Motion.js` change.

## Rejection ledger

- **Stride-12 interleaved world matrix (one Float64Array, 12 floats/node,
  contiguous per node).** Rejected. Not expressible through lite-arena's
  one-TypedArray-per-field `registerComponent` schema: `{ buffers }` allocates
  `capacity * BYTES_PER_ELEMENT` per FIELD, so an interleaved 12-wide stride is not
  a field lite-arena can grow/swap-pop. Pursuing it would mean a lite-depth-local
  workaround around the arena's storage model. Correct path: measure it as a
  lite-arena FEATURE REQUEST (a strided/interleaved component kind), never a
  lite-depth workaround. The current m0..m11 twelve-lane layout stands.
