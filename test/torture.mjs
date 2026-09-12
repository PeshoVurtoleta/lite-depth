/**
 * @zakkster/lite-depth -- torture gate.
 *
 * The suite DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints "ok", exit 0
 *
 * It gates three independent properties of the real Depth.js stage entry. Each
 * phase carries a docstring stating the property it gates and WHY; each phase is
 * self-controlling and trips die() (exit non-zero) on regression. On full pass
 * stdout is exactly "ok"; the GATE metrics line and all diagnostics go to stderr.
 *
 *   Phase A (retention) -- 4096 stage build/tear-down cycles. Each cycle creates
 *     a FRESH real stage, spawns N box nodes, drives one frame, despawns them all,
 *     then drops the stage. TWO independent witnesses gate retention, and they
 *     answer DIFFERENT questions:
 *       1. Arena conservation (per cycle): the pool accounting law
 *          activeCount + retiredCount + remainingCapacity === capacity, AND
 *          activeCount === nodes.count === 0 after the despawns. This is the
 *          genuine node-SLOT oracle -- lite-depth stores nodes in an arena of
 *          typed-array (SoA) components, so there is NO per-node JS object to
 *          finalize; a leaked node is a leaked arena slot, which is exactly what
 *          this law catches.
 *       2. Finalization residual (AUTHORITY, after the loop): the STAGE is the
 *          real JS object a cycle allocates (its arena + frame buffers). Each
 *          dropped stage is tracked with lite-leak WITHOUT untracking it (shared
 *          NOOP cleanup + numeric tag capture NOTHING -- held-value contract), so
 *          a stage that was truly released is collected (size--) and one retained
 *          by a stray reference is not. After the loop we settle HARD (>= 10
 *          gc()+tick passes) and assert tracker.size() <= RES = max(16, CYCLES/1000).
 *     (An earlier version tracked a THROWAWAY { slot } per node and untracked it
 *     the same cycle, asserting size()===0 -- a VACUOUS TAUTOLOGY: untrack
 *     decrements the counter synchronously, netting to 0 even if the object were
 *     retained forever, and it tracked a proxy rather than any real resource. The
 *     arena law was the only genuine retention oracle; the lite-leak line added
 *     nothing. Fixed here to witness the real stage object by finalization.)
 *     Control DEPTH_TORTURE_LEAK=1: skip every remove() AND pin every stage in a
 *     module sink -- the arena law reads activeCount>0 and the finalization
 *     residual stays ~cycles, so BOTH oracles trip.
 *
 *   Phase B (GC budget / zero-alloc hot path) -- a dense stage of 2000 box nodes
 *     is pre-spawned to capacity and marked dirty OUTSIDE the measured loop, then
 *     the real stage.frame()/paint() path is driven for 20000 frames inside a
 *     measureOps(stabilize:'deep') window. It is gated at maxMajor:0,
 *     maxPauseMs:4 AND maxArrayBuffersGrowth:0 -- and, independently, the same
 *     frame op is run through measureAllocs() and required to be 0 bytes/op.
 *     stabilize:'deep' forces the double settle the external arrayBuffers channel
 *     needs to report a gateable growthBytes, so the summary is read only after a
 *     fully settled window (never an empty one).
 *
 *   Phase C (control / the gate proves itself) -- the T9 control. It drives the
 *     SAME dense frame path but deliberately allocates on the hot path: one fresh
 *     per-face AABB buffer (a Float32Array of 4 floats x drawn faces) allocated
 *     and retained every frame -- the exact anti-pattern lite-depth avoids by
 *     reusing a single _box register. Its backing store lands OUTSIDE the JS heap
 *     in process arrayBuffers, so run through the identical measureOps window and
 *     the SAME three-rule gate, maxArrayBuffersGrowth:0 MUST light up. The
 *     assertion is INVERTED: the phase passes only if checkNoGc REPORTS a
 *     violation. So the failing path is genuinely exercised in-process while the
 *     main run still prints "ok" -- proof the gate catches a real leak rather
 *     than always printing ok. If the deliberately-leaky frame is reported clean,
 *     die().
 *
 *   Phase D (node-box cull -- correctness + zero-alloc lane) -- exercises the
 *     v1.5.0 per-node screen-space AABB cull and the opt-in dirtyRect lane. A
 *     down-z camera maps world x/y to screen x/y, so a lateral offset pushes a
 *     node off-screen while its depth stays in-frustum -- the SCREEN-box cull, not
 *     the coarse depth reject, is what fires. It gates three things: an INVERTED
 *     control (an on-screen node is NEVER node-box-culled), an EDGE MATRIX (a node
 *     off each of the four viewport edges + two corners must cull the whole node
 *     with ZERO face-loop work, so each of the four inline compares is the one
 *     that trips), and the FAIL-OPEN door (a node whose verts are all behind the
 *     near plane builds an empty box and MUST still be drawn, its faces rejected
 *     by the per-face near door exactly as v1.4.0 -- geometry culling that fires
 *     wrongly loses picture). Then a dense down-z stage with dirtyRect ENABLED and
 *     ~1/3 of nodes off-screen is driven through the same measureOps + measureAllocs
 *     windows: the nodeBox writes, the once-per-frame scene-bbox merge and the
 *     culled-slot path must all stay 0 major GC and 0 bytes/op.
 *
 * A pass means something only if the gate can fail. Phase C is the always-on
 * self-control; DEPTH_TORTURE_LEAK=1 is the Phase-A retention control:
 *
 *     DEPTH_TORTURE_LEAK=1 node --expose-gc test/torture.mjs   -> exit non-zero
 *
 * Peers are devDependencies, never runtime deps: Depth.js's runtime deps are only
 * lite-arena / lite-fastbit32 / lite-aabb.
 *
 * @license MIT
 */

import { createStage, geometry, material } from '../Depth.js';
import { checkNoGc, measureOps, measureAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
// lite-bvh is DI-bound (devDependency, never a runtime dep of Depth.js). Phase E
// drives the real pick index through the stage's useSpatialIndex() binding.
import { DynamicBVH2D } from '@zakkster/lite-bvh';

// --- config -----------------------------------------------------------------

const CYCLES = 4096;        // Phase A create/dispose cycles
const N = 8;                // nodes spawned+removed per cycle
const STAGE_CAP = 64;       // per-cycle stage capacity (N spawns + slack)
const DENSE = 2000;         // Phase B/C dense node population (to capacity)
const HOT_FRAMES = 20000;   // Phase B measured frames
const CTRL_FRAMES = 4000;   // Phase C control frames (retains per-face allocs)
const DT = 1 / 60;

// Finalization residual ceiling for the Phase A stage witness. A cleanly dropped
// stage is collected; a leaked one is not. Clean runs leave single digits; a
// real leak leaves ~CYCLES.
const RES = Math.max(16, (CYCLES / 1000) | 0); // 16

// maxMinor:0 is enforced so the official gate is at least as strict as the
// package's own zero-GC node:test (test/14 gates minor=0). A minor-GC regression
// on the always-on frame path must never slip through green again.
const RULES = { maxMajor: 0, maxMinor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

// Skip every remove() AND pin every stage -- the deliberately-leaky Phase A
// control. See header.
const LEAK = process.env.DEPTH_TORTURE_LEAK === '1';

// LEAK pins each tracked stage here so it can NEVER be finalized -> the Phase A
// residual stays ~CYCLES. Read after the settle (main's GATE line) so a top-level
// module sink is not elided as dead under V8 liveness analysis.
const stageSink = [];

// Shared no-op release. Passed as the lite-leak cleanup so the tracked record
// closes over NOTHING (no stage handle, no per-cycle closure): a held value that
// referenced its target would pin it forever. See lite-leak's held-value law.
const NOOP = function () {};

// Hard settle: run FinalizationRegistry callbacks to ground (>= 10 gc()+tick
// passes) before reading tracker.size(), or the residual reads an empty window
// and the gate falsely passes.
async function settleHard() {
  for (let i = 0; i < 10; i++) {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 15));
  }
}

// --- helpers -----------------------------------------------------------------

function die(msg) {
  process.stderr.write('torture: FAIL -- ' + msg + '\n');
  process.exit(1);
}

// A no-op Canvas2D-shaped sink. Every method the paint() hot path calls exists
// and does nothing; property writes land on plain fields. Zero allocation, so it
// never contaminates the measured window with ctx-side garbage.
function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

// Build a dense stage filled to `count` box nodes scattered across the frustum,
// so projection/cull/sort/paint all do real work every frame. Returns the stage.
function buildDenseStage(count) {
  const stage = createStage(makeCtx(), { maxNodes: count, width: 800, height: 600 });
  const gid = stage.geometry(geometry.box(1, 1, 1));
  const mid = stage.material(material({ r: 200, g: 120, b: 90 }));
  const side = Math.ceil(Math.cbrt(count));
  for (let i = 0; i < count; i++) {
    const gx = i % side, gy = (i / side | 0) % side, gz = (i / (side * side) | 0);
    stage.addNode(gid, mid, {
      x: (gx - side / 2) * 1.6,
      y: (gy - side / 2) * 1.6,
      z: (gz - side / 2) * 1.6,
    });
  }
  return stage;
}

// --- Phase A: retention ------------------------------------------------------

async function phaseA() {
  const tracker = createLeakTracker({ name: 'depth-retention' });
  const live = new Int32Array(N);                   // this cycle's spawned handles

  // Leaky control (DEPTH_TORTURE_LEAK=1): a BOUNDED run of stages that spawn
  // WITHOUT removing AND are pinned in stageSink. After a hard settle BOTH oracles
  // must read non-zero -- the arena law (active slots outstanding on the last
  // stage) and the finalization residual (pinned stages never collect). The
  // assertion is INVERTED and named, so a regression that made either oracle read
  // clean here would be caught.
  if (LEAK) {
    const LEAK_CYCLES = 64;
    let lastArena = null;
    for (let cycle = 0; cycle < LEAK_CYCLES; cycle++) {
      const stage = createStage(makeCtx(), { maxNodes: STAGE_CAP });
      const gid = stage.geometry(geometry.box(1, 1, 1));
      const mid = stage.material(material({}));
      for (let i = 0; i < N; i++) stage.addNode(gid, mid);   // no remove -> slots leak
      lastArena = stage.arena;
      tracker.track(stage, NOOP, cycle);
      stageSink.push(stage);                                  // pin -> never finalize
    }
    await settleHard();
    if (lastArena.activeCount === 0 || tracker.size() === 0) {
      die('phaseA control did not leak -- retention gate is not load-bearing');
    }
    die('retention -- lastArena.activeCount=' + lastArena.activeCount +
      ' residual=' + tracker.size() + ' pinned=' + stageSink.length);
  }

  // Positive work-witness: the peak activeCount seen across cycles. If it never
  // rose above 0, a zero-cycle Phase A would pass vacuously -- fail closed.
  let maxActiveSeen = 0;

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    // A FRESH stage per cycle -- the real JS object whose release we witness.
    const stage = createStage(makeCtx(), { maxNodes: STAGE_CAP });
    const gid = stage.geometry(geometry.box(1, 1, 1));
    const mid = stage.material(material({}));
    const arena = stage.arena, nodes = stage.nodes;
    const cap = arena.capacity;

    for (let i = 0; i < N; i++) live[i] = stage.addNode(gid, mid);
    // Peak of the cycle: after the N spawns, before any remove.
    if (arena.activeCount > maxActiveSeen) maxActiveSeen = arena.activeCount;
    stage.frame(DT);                                // exercise project/cull/paint
    for (let i = 0; i < N; i++) stage.remove(live[i]);

    // Witness 1: pool conservation + drain on THIS stage.
    const free = arena.remainingCapacity();
    if (arena.activeCount + arena.retiredCount + free !== cap) {
      die('phaseA: conservation broken at cycle ' + cycle +
        ' -- active=' + arena.activeCount + ' retired=' + arena.retiredCount +
        ' free=' + free + ' cap=' + cap);
    }
    if (arena.activeCount !== 0) die('phaseA: activeCount ' + arena.activeCount + ' != 0 at cycle ' + cycle);
    if (nodes.count !== 0) die('phaseA: nodes.count ' + nodes.count + ' != 0 at cycle ' + cycle);

    // Witness 2 (AUTHORITY): track the STAGE without untracking; finalization
    // decides its fate. Neither NOOP nor the numeric tag closes over the stage.
    tracker.track(stage, NOOP, cycle);
  }

  if (maxActiveSeen <= 0) die('phaseA: activeCount never rose above 0 -- vacuous pass');

  await settleHard();
  const residual = tracker.size();

  return {
    activeCount: 0,          // asserted 0 every cycle above (per-stage arena)
    nodesCount: 0,           // asserted 0 every cycle above
    trackerSize: residual,
    residualCeiling: RES,
    findings: tracker.audit().length,
    pinned: stageSink.length,
  };
}

// --- Phase B: GC budget / zero-alloc hot path --------------------------------

function phaseB() {
  const stage = buildDenseStage(DENSE);
  // Warm one frame so topo + transforms are built and lanes are hot BEFORE the
  // window. Re-mark every node dirty afterward so the first measured frame still
  // exercises the transform lane; steady-state frames re-run project/sort/paint.
  stage.frame(DT);
  if (stage._drawCount <= 0) die('phaseB: dense stage produced an empty draw list');
  if (stage.stats.nodesTotal !== DENSE) die('phaseB: nodesTotal=' + stage.stats.nodesTotal + ' != ' + DENSE);

  let acc = 0;
  const res = measureOps(function () {
    const s = stage.frame(DT);
    acc = acc + s.facesDrawn + s.nodesTotal; // read stats so V8 cannot dead-code
  }, { ops: HOT_FRAMES, warmup: 8, source: 'gc', stabilize: 'deep' });

  if (!Number.isFinite(acc) || acc <= 0) die('phaseB: frame loop produced no work (acc=' + acc + ')');
  const report = checkNoGc(res.summary, RULES);

  // Independent B/op witness: the same frame op measured for bytes-per-call.
  const stage2 = buildDenseStage(DENSE);
  stage2.frame(DT);
  let acc2 = 0;
  const alloc = measureAllocs(function () {
    const s = stage2.frame(DT);
    acc2 = acc2 + s.facesDrawn;
  }, { iterations: 4096, warmup: 16 });
  if (!Number.isFinite(acc2)) die('phaseB: alloc probe produced non-finite acc');

  return { report, summary: res.summary, bytesPerCall: alloc.bytesPerCall };
}

// --- Phase C: control -- the gate must catch a real hot-path allocation ------

const cSink = []; // retains the control's per-frame allocations

function phaseC() {
  const stage = buildDenseStage(DENSE);
  stage.frame(DT);

  let acc = 0;
  const res = measureOps(function () {
    const s = stage.frame(DT);
    acc = acc + s.facesDrawn;
    // Deliberate hot-path leak: a fresh per-face AABB buffer (4 floats x drawn
    // faces) allocated and RETAINED every frame -- the exact anti-pattern
    // lite-depth avoids by reusing one _box register. The backing store lives
    // outside the JS heap in process arrayBuffers, so a healthy gate trips
    // maxArrayBuffersGrowth:0. _drawCount is the read-only handle Task 7 publishes.
    const dc = stage._drawCount;
    cSink.push(new Float32Array(4 * dc));
  }, { ops: CTRL_FRAMES, warmup: 4, source: 'gc', stabilize: 'deep' });

  if (!Number.isFinite(acc)) die('phaseC: control frame produced non-finite acc');
  const report = checkNoGc(res.summary, RULES);
  // INVERTED assertion: the deliberately-leaky path MUST be reported dirty.
  if (report.ok) {
    die('phaseC: control retained ' + cSink.length + ' per-frame buffers on the hot ' +
      'path but the gate reported CLEAN -- the budget gate is not load-bearing');
  }
  return { caught: !report.ok, retained: cSink.length, verdict: report.verdict };
}

// --- Phase D: node-box cull -- correctness matrix + fail-open + zero-alloc lane -

// A camera looking straight down -z from (0,0,radius): the world x/y axes map to
// screen x/y, so a lateral offset pushes a node OFF-SCREEN while its view depth
// stays in-frustum -- forcing the new SCREEN-space AABB cull to fire, NOT the
// coarse depth reject. Deterministic geometry so every assertion is exact.
function nodeBoxCam() { return { theta: 0, phi: Math.PI / 2, radius: 40, near: 0.5, far: 200 }; }

// Build a dense down-z stage where ~1/3 of nodes are shoved fully off-screen (in
// depth), so the measured window exercises the cull's culled-slot path AND the
// opt-in dirtyRect lane (nodeBox writes + once-per-frame scene-bbox merge).
function buildNodeBoxStage(count) {
  const stage = createStage(makeCtx(), { maxNodes: count, width: 800, height: 600, camera: nodeBoxCam() });
  stage.dirtyRect = true;
  const gid = stage.geometry(geometry.box(1, 1, 1));
  const mid = stage.material(material({ r: 200, g: 120, b: 90 }));
  for (let i = 0; i < count; i++) {
    if ((i % 3) === 0) stage.addNode(gid, mid, { x: 120, y: 0, z: 0 });                  // off-screen right, in-depth
    else stage.addNode(gid, mid, { x: (i % 7) - 3, y: ((i / 7 | 0) % 7) - 3, z: 0 });    // on-screen cluster
  }
  return stage;
}

function phaseD() {
  // --- correctness matrix on a single node (small, exact) --------------------
  const s = createStage(makeCtx(), { width: 800, height: 600, maxNodes: 8, camera: nodeBoxCam() });
  const gid = s.geometry(geometry.box(1, 1, 1)), mid = s.material(material({}));
  const h = s.addNode(gid, mid, {});

  // (1) INVERTED CONTROL: an on-screen node must NOT be node-box-culled. If this
  // fires, the cull is over-eager and drops picture -- the whole feature is unsafe.
  s.setPosition(h, 0, 0, 0); s.frame(DT);
  if (s.stats.facesDrawn <= 0) die('phaseD: on-screen node drew nothing');
  if (s.stats.nodesCulled !== 0) die('phaseD: on-screen node was node-box-culled (nodesCulled=' + s.stats.nodesCulled + ')');
  const drawnOnScreen = s.stats.facesDrawn;

  // (2) EDGE MATRIX: push the node fully off each viewport edge (and two corners),
  // in-depth every time, so all four inline compares (minx<=vx1, maxx>=vx0,
  // miny<=vy1, maxy>=vy0) are each the one that trips. Every row MUST cull the
  // whole node: nodesCulled +1, and the face loop runs ZERO iterations
  // (facesDrawn 0, facesCulled 0 -- no per-face work at all).
  const EDGES = [[120, 0, 0], [-120, 0, 0], [0, 120, 0], [0, -120, 0], [120, 120, 0], [-120, -120, 0]];
  for (let r = 0; r < EDGES.length; r++) {
    const row = EDGES[r];
    s.setPosition(h, row[0], row[1], row[2]); s.frame(DT);
    if (s.stats.nodesCulled !== 1) die('phaseD: off-screen row ' + r + ' not node-box-culled (nodesCulled=' + s.stats.nodesCulled + ')');
    if (s.stats.facesDrawn !== 0) die('phaseD: culled row ' + r + ' still drew ' + s.stats.facesDrawn + ' faces');
    if (s.stats.facesCulled !== 0) die('phaseD: culled row ' + r + ' ran the face loop (facesCulled=' + s.stats.facesCulled + ' must be 0)');
    if (s.stats.nodesInvalid !== 0) die('phaseD: node-box cull wrongly bumped nodesInvalid on row ' + r);
  }

  // (3) FAIL-OPEN control: a node whose verts are ALL behind the near plane builds
  // an empty node box. It MUST still be drawn (never node-box-culled) -- a wrongly
  // fired geometry cull loses picture. Its faces are then all near-culled by the
  // face door, exactly as v1.4.0: nodesCulled 0, facesDrawn 0, facesCulled > 0
  // (the face door, not the node door, did the rejecting).
  s.setPosition(h, 0, 0, 40.2); s.frame(DT);   // just behind the eye (z=radius): vz=+0.2 center, every vert vz > -near -> empty box
  if (s.stats.nodesCulled !== 0) die('phaseD: behind-near node was node-box-culled -- FAIL-OPEN violated (nodesCulled=' + s.stats.nodesCulled + ')');
  if (s.stats.facesDrawn !== 0) die('phaseD: behind-near node drew ' + s.stats.facesDrawn + ' faces (all should near-cull)');
  if (s.stats.facesCulled <= 0) die('phaseD: behind-near node did not reach the per-face near door (facesCulled=' + s.stats.facesCulled + ')');

  // --- zero-alloc proof of the cull + opt-in dirtyRect lane ------------------
  const dense = buildNodeBoxStage(DENSE);
  dense.frame(DT);
  if (dense.stats.nodesCulled <= 0) die('phaseD: dense scatter never exercised the node-box cull (nodesCulled=0)');
  if (dense._drawCount <= 0) die('phaseD: dense node-box stage produced an empty draw list');
  // dirtyRect lane actually ran: the scene box must be a valid, finite, non-empty
  // box (the union of the on-screen cluster). A stale empty box means the merge
  // was skipped.
  const sb = dense.sceneBox;
  const sceneValid = Number.isFinite(sb[0]) && Number.isFinite(sb[1]) && Number.isFinite(sb[2]) && Number.isFinite(sb[3]) && sb[0] <= sb[2] && sb[1] <= sb[3];
  if (!sceneValid) die('phaseD: dirtyRect scene box invalid/empty after a drawn frame [' + sb[0] + ',' + sb[1] + ',' + sb[2] + ',' + sb[3] + ']');

  let accD = 0;
  const gcRes = measureOps(function () {
    const st = dense.frame(DT);
    accD = accD + st.facesDrawn + st.nodesCulled;
  }, { ops: HOT_FRAMES, warmup: 8, source: 'gc', stabilize: 'deep' });
  if (!Number.isFinite(accD) || accD <= 0) die('phaseD: node-box frame loop produced no work (acc=' + accD + ')');
  const report = checkNoGc(gcRes.summary, RULES);

  const dense2 = buildNodeBoxStage(DENSE);
  dense2.frame(DT);
  let accD2 = 0;
  const alloc = measureAllocs(function () {
    const st = dense2.frame(DT);
    accD2 = accD2 + st.facesDrawn;
  }, { iterations: 4096, warmup: 16 });
  if (!Number.isFinite(accD2)) die('phaseD: node-box alloc probe produced non-finite acc');

  return {
    report, bytesPerCall: alloc.bytesPerCall,
    culled: dense.stats.nodesCulled, drawnOnScreen, sceneValid,
  };
}

// --- Phase E: pick index -- differential correctness + zero-alloc pick path ---
//
// D4 "Touch". A down-z stage with a DI-bound DynamicBVH2D. It gates:
//   - the nodeBox->bvh ROUND TRIP (phaseD extension): binding an index forces the
//     box lane on, the per-frame clear()+insertLeaves rebuilds the tree, and the
//     tree stays VALID with maxNodes + every backing byteLength IDENTICAL across
//     HOT_FRAMES (no realloc -- the clear()+insertLeaves path, not updateLeaf).
//   - the pick DIFFERENTIAL: pick(x,y) == the brute-force back-to-front
//     containsPoint scan over the sorted draw list, for both the INDEX path and
//     the no-index (dirtyRect) fallback, over a large fuzz sweep.
//   - zero-alloc INCLUDING the pick path: HOT_FRAMES of frame()+pick() through
//     measureOps(stabilize:'deep') at maxMajor 0 / maxPauseMs<=4 /
//     maxArrayBuffersGrowth 0, and measureAllocs at 0 B/op.
function buildPickStage(count, withIndex) {
  const stage = createStage(makeCtx(), {
    maxNodes: count, width: 800, height: 600,
    camera: { theta: 0, phi: Math.PI / 2, radius: 12, near: 0.5, far: 200 },
  });
  stage.dirtyRect = true;                              // no-index fallback needs the box lane
  const gid = stage.geometry(geometry.box(1, 1, 1));
  const mid = stage.material(material({ r: 200, g: 120, b: 90 }));
  let seed = 24681357;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < count; i++) {
    stage.addNode(gid, mid, { x: (rnd() - 0.5) * 10, y: (rnd() - 0.5) * 7, z: (rnd() - 0.5) * 8 });
  }
  let tree = null;
  if (withIndex) { tree = new DynamicBVH2D(count * 2 + 1); stage.useSpatialIndex(tree, { margin: 0.5 }); }
  return { stage, tree };
}

// Brute-force topmost oracle: independent of pick(), reads only the public draw
// list + box lane. Must equal pick() exactly (with and without an index).
function pickOracle(stage, x, y) {
  const order = stage._order, dc = stage._drawCount, box = stage._draw.box, dn = stage._draw.node;
  for (let i = dc - 1; i >= 0; i--) {
    const d = dn[order[i]], j = d << 2;
    if (x >= box[j] && x <= box[j + 2] && y >= box[j + 1] && y <= box[j + 3]) return d;
  }
  return -1;
}

async function phaseE() {
  const PICK_N = 512;
  const idx = buildPickStage(PICK_N, true);
  const noidx = buildPickStage(PICK_N, false);
  idx.stage.frame(DT); noidx.stage.frame(DT);
  if (idx.stage._drawCount <= 0) die('phaseE: indexed stage produced an empty draw list');
  if (!idx.tree.validate()) die('phaseE: bound tree invalid after first frame');

  // Differential fuzz: pick == oracle for BOTH paths.
  const out = new Int32Array(1);
  let seed = 13579, hits = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 6000; i++) {
    const x = rnd() * 800, y = rnd() * 600;
    const gi = idx.stage.pick(x, y, out); const goti = gi > 0 ? out[0] : -1;
    if (goti !== pickOracle(idx.stage, x, y)) die('phaseE: indexed pick != oracle at (' + x + ',' + y + ')');
    const gn = noidx.stage.pick(x, y, out); const gotn = gn > 0 ? out[0] : -1;
    if (gotn !== pickOracle(noidx.stage, x, y)) die('phaseE: no-index pick != oracle at (' + x + ',' + y + ')');
    if (goti >= 0) hits++;
  }
  if (hits < 100) die('phaseE: pick fuzz never hit a node (hits=' + hits + ')');

  // Round trip: tree conserved across HOT_FRAMES (no realloc under clear()+insert).
  const before = {
    maxNodes: idx.tree.maxNodes,
    bboxes: idx.tree.bboxes.byteLength, parents: idx.tree.parents.byteLength,
    children: idx.tree.children.byteLength, userData: idx.tree.userData.byteLength,
  };

  // Zero-alloc INCLUDING pick: step frame() then a pick() every iteration.
  const pk = new Int32Array(1);
  let acc = 0;
  const res = measureOps(function () {
    const s = idx.stage.frame(DT);
    acc = acc + s.facesDrawn + idx.stage.pick(400, 300, pk);
  }, { ops: HOT_FRAMES, warmup: 8, source: 'gc', stabilize: 'deep' });
  if (!Number.isFinite(acc) || acc <= 0) die('phaseE: frame+pick loop produced no work (acc=' + acc + ')');

  if (idx.tree.maxNodes !== before.maxNodes) die('phaseE: tree.maxNodes changed across frames');
  if (idx.tree.bboxes.byteLength !== before.bboxes || idx.tree.parents.byteLength !== before.parents ||
      idx.tree.children.byteLength !== before.children || idx.tree.userData.byteLength !== before.userData) {
    die('phaseE: a tree backing byteLength changed across frames -- clear()+insertLeaves reallocated');
  }
  if (!idx.tree.validate()) die('phaseE: tree invalid after ' + HOT_FRAMES + ' frames');
  const report = checkNoGc(res.summary, RULES);

  const idx2 = buildPickStage(PICK_N, true);
  idx2.stage.frame(DT);
  const pk2 = new Int32Array(1);
  let acc2 = 0;
  const alloc = measureAllocs(function () {
    idx2.stage.frame(DT);
    acc2 = acc2 + idx2.stage.pick(400, 300, pk2);
  }, { iterations: 4096, warmup: 16 });
  if (!Number.isFinite(acc2)) die('phaseE: alloc probe produced non-finite acc');

  // Retention (A6): build a stage, bind an index, run a frame, DROP the index, then
  // release the stage. A dropped index must not pin the stage (nor vice versa).
  // Track each stage without untracking; a hard settle decides its fate. Neither
  // NOOP nor the numeric tag closes over the stage (held-value contract).
  const rt = createLeakTracker({ name: 'depth-index-retention' });
  const RES_E = Math.max(16, (CYCLES / 1000) | 0);
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const b = buildPickStage(32, true);
    b.stage.frame(DT);
    b.stage.dropSpatialIndex();
    rt.track(b.stage, NOOP, cycle);
  }
  await settleHard();
  const residual = rt.size();
  const findings = rt.audit().length;

  return { report, bytesPerCall: alloc.bytesPerCall, hits, residual, findings, RES_E };
}

// --- gate --------------------------------------------------------------------

async function main() {
  if (typeof globalThis.gc !== 'function') {
    die('run with --expose-gc:  node --expose-gc test/torture.mjs');
  }

  const a = await phaseA();
  const b = phaseB();
  const c = phaseC();
  const d = phaseD();
  const e = await phaseE();

  const retentionOk = a.activeCount === 0 && a.nodesCount === 0 &&
    a.trackerSize <= a.residualCeiling && a.findings === 0 &&
    e.residual <= e.RES_E && e.findings === 0;
  const budgetOk = b.report.ok && b.bytesPerCall === 0 && d.report.ok && d.bytesPerCall === 0 &&
    e.report.ok && e.bytesPerCall === 0;
  const controlOk = c.caught;

  const g = b.summary.gc;
  process.stderr.write(
    'GATE leak=size ' + a.trackerSize + '/' + a.residualCeiling + ' findings=' + a.findings +
    ' warnings=0 pinned=' + a.pinned + ' pickResidual=' + e.residual + '/' + e.RES_E +
    ' | gc major=' + g.major + ' minor=' + g.minor + ' maxMs=' + g.maxMs.toFixed(2) +
    ' | alloc=' + b.bytesPerCall + ' B/op pick=' + e.bytesPerCall + ' B/op\n');

  if (retentionOk && budgetOk && controlOk) {
    process.stdout.write('ok\n');
    process.exit(0);
  }

  if (!retentionOk) {
    process.stderr.write(
      'torture: retention -- activeCount=' + a.activeCount + ' nodesCount=' + a.nodesCount +
      ' trackerSize=' + a.trackerSize + ' > ceiling ' + a.residualCeiling +
      ' findings=' + a.findings + ' (a dropped stage outlived Phase A)\n');
  }
  if (!budgetOk) {
    process.stderr.write(
      'torture: budget -- verdict=' + b.report.verdict + ' major=' + g.major +
      ' maxMs=' + g.maxMs.toFixed(3) + ' bytesPerCall=' + b.bytesPerCall +
      ' | nodeBox verdict=' + d.report.verdict + ' bytesPerCall=' + d.bytesPerCall +
      ' culled=' + d.culled +
      ' (rules ' + JSON.stringify(RULES) + ')\n');
    for (const v of b.report.violations) {
      process.stderr.write('  violation phaseB ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual + '\n');
    }
    for (const v of d.report.violations) {
      process.stderr.write('  violation phaseD ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual + '\n');
    }
  }
  if (!controlOk) {
    process.stderr.write('torture: control -- deliberate hot-path leak was NOT caught by the gate\n');
  }
  die('gate rejected' + (LEAK ? ' (leaky control -- expected)' : ''));
}

main().catch((e) => {
  process.stderr.write('torture: FAIL -- ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
