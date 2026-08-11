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
 *   Phase A (retention) -- 4096 spawn/despawn cycles on a real stage. Every node
 *     spawned via stage.addNode() is paired with an external JS resource tracked
 *     by @zakkster/lite-leak; on removal the resource is untracked and the node
 *     despawned via stage.remove(). After EVERY cycle TWO independent witnesses
 *     must return to baseline: the arena's own pool accounting (the conservation
 *     law activeCount + retiredCount + remainingCapacity === capacity, AND
 *     activeCount === nodes.count === 0) and the lite-leak tracker.size(). Two
 *     oracles, so a bug in one cannot hide behind the other. Its control is
 *     DEPTH_TORTURE_LEAK=1: skip every remove() and both oracles stay non-zero.
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

// --- config -----------------------------------------------------------------

const CYCLES = 4096;        // Phase A create/dispose cycles
const N = 8;                // nodes spawned+removed per cycle
const DENSE = 2000;         // Phase B/C dense node population (to capacity)
const HOT_FRAMES = 20000;   // Phase B measured frames
const CTRL_FRAMES = 4000;   // Phase C control frames (retains per-face allocs)
const INDEX_MASK = 0xFFFFF; // lite-arena low 20 bits = slot index (a primitive)
const DT = 1 / 60;

const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

// Skip every remove() -- the deliberately-leaky Phase A control. See header.
const LEAK = process.env.DEPTH_TORTURE_LEAK === '1';

// Shared no-op release. Passed as the lite-leak cleanup so the tracked record
// closes over NOTHING (no node handle, no per-node closure): a held value that
// referenced its target would pin it forever. See lite-leak's held-value law.
const NOOP = function () {};

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

function phaseA() {
  const stage = createStage(makeCtx(), { maxNodes: 4096 });
  const gid = stage.geometry(geometry.box(1, 1, 1));
  const mid = stage.material(material({}));
  const arena = stage.arena, nodes = stage.nodes;
  const tracker = createLeakTracker({ name: 'depth-retention' });

  // Allocated ONCE, outside the cycle loop. leakHandles[slot] holds the lite-leak
  // handle for the node currently in that slot; live[] the spawned handles this
  // cycle. Both indexed by primitives -- never a closure over a node.
  const leakHandles = new Array(4096).fill(null);
  const live = new Int32Array(N);
  const cap = arena.capacity;

  // Leaky control (DEPTH_TORTURE_LEAK=1): a BOUNDED run of spawn-without-remove
  // cycles kept strictly under capacity (N*LEAK_CYCLES << cap, so arena.spawn()
  // can never throw OOM). It proves the retention property is can-fail: after
  // leaking, BOTH oracles must read non-zero. The assertion is INVERTED and named
  // -- a die() that reports the retention property, never an incidental arena
  // throw. So a regression that made the oracles read zero here would be caught.
  if (LEAK) {
    const LEAK_CYCLES = 64;                         // 64*8 = 512 spawns << 4096 cap
    for (let cycle = 0; cycle < LEAK_CYCLES; cycle++) {
      for (let i = 0; i < N; i++) {
        const h = stage.addNode(gid, mid);
        const slot = h & INDEX_MASK;
        leakHandles[slot] = tracker.track({ slot }, NOOP, slot);
      }
    }
    if (arena.activeCount >= cap) die('phaseA control: hit capacity -- LEAK bound is wrong');
    if (tracker.size() === 0 || arena.activeCount === 0) {
      die('phaseA control did not leak -- retention gate is not load-bearing');
    }
    die('retention -- activeCount=' + arena.activeCount + ' trackerSize=' + tracker.size());
  }

  // Positive work-witness: the peak activeCount seen across cycles. If it never
  // rose above 0, a zero-cycle Phase A would pass vacuously -- fail closed.
  let maxActiveSeen = 0;

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (let i = 0; i < N; i++) {
      const h = stage.addNode(gid, mid);
      live[i] = h;
      const slot = h & INDEX_MASK;                 // primitive tag
      const resource = { slot };                   // models a per-node JS resource
      leakHandles[slot] = tracker.track(resource, NOOP, slot);
    }
    // Peak of the cycle: after the N spawns, before any remove.
    if (arena.activeCount > maxActiveSeen) maxActiveSeen = arena.activeCount;

    for (let i = 0; i < N; i++) {
      const h = live[i];
      const slot = h & INDEX_MASK;
      tracker.untrack(leakHandles[slot]);
      leakHandles[slot] = null;
      stage.remove(h);
    }

    // Witness 1: pool conservation + drain. Witness 2: external tracker drain.
    const free = arena.remainingCapacity();
    if (arena.activeCount + arena.retiredCount + free !== cap) {
      die('phaseA: conservation broken at cycle ' + cycle +
        ' -- active=' + arena.activeCount + ' retired=' + arena.retiredCount +
        ' free=' + free + ' cap=' + cap);
    }
    if (arena.activeCount !== 0) die('phaseA: activeCount ' + arena.activeCount + ' != 0 at cycle ' + cycle);
    if (nodes.count !== 0) die('phaseA: nodes.count ' + nodes.count + ' != 0 at cycle ' + cycle);
    if (tracker.size() !== 0) die('phaseA: tracker.size ' + tracker.size() + ' != 0 at cycle ' + cycle);
  }

  if (maxActiveSeen <= 0) die('phaseA: activeCount never rose above 0 -- vacuous pass');

  return {
    activeCount: arena.activeCount,
    nodesCount: nodes.count,
    trackerSize: tracker.size(),
    findings: tracker.audit().length,
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

// --- gate --------------------------------------------------------------------

function main() {
  if (typeof globalThis.gc !== 'function') {
    die('run with --expose-gc:  node --expose-gc test/torture.mjs');
  }

  const a = phaseA();
  const b = phaseB();
  const c = phaseC();

  const retentionOk = a.activeCount === 0 && a.nodesCount === 0 && a.trackerSize === 0 && a.findings === 0;
  const budgetOk = b.report.ok && b.bytesPerCall === 0;
  const controlOk = c.caught;

  const g = b.summary.gc;
  process.stderr.write(
    'GATE leak=size ' + a.trackerSize + '/0 findings=' + a.findings +
    ' warnings=0' +
    ' | gc major=' + g.major + ' minor=' + g.minor + ' maxMs=' + g.maxMs.toFixed(2) +
    ' | alloc=' + b.bytesPerCall + ' B/op\n');

  if (retentionOk && budgetOk && controlOk) {
    process.stdout.write('ok\n');
    process.exit(0);
  }

  if (!retentionOk) {
    process.stderr.write(
      'torture: retention -- activeCount=' + a.activeCount + ' nodesCount=' + a.nodesCount +
      ' trackerSize=' + a.trackerSize + ' findings=' + a.findings + ' (all must be 0)\n');
  }
  if (!budgetOk) {
    process.stderr.write(
      'torture: budget -- verdict=' + b.report.verdict + ' major=' + g.major +
      ' maxMs=' + g.maxMs.toFixed(3) + ' bytesPerCall=' + b.bytesPerCall +
      ' (rules ' + JSON.stringify(RULES) + ')\n');
    for (const v of b.report.violations) {
      process.stderr.write('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual + '\n');
    }
  }
  if (!controlOk) {
    process.stderr.write('torture: control -- deliberate hot-path leak was NOT caught by the gate\n');
  }
  die('gate rejected' + (LEAK ? ' (leaky control -- expected)' : ''));
}

main();
