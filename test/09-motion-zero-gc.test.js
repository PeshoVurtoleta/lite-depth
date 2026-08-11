// The animation update path (mixer.update -> eval channels -> write node lanes)
// must be allocation-free, the same contract as the render loop.
//
// The primary gate is ZERO GC over a FIXED op window: measureOps runs a fixed
// 20000 ops in its steady phase, and if the loop produced young-gen pressure,
// scavenges would fire (young gen fills by bytes, not by wall clock). Zero
// minor + zero major over 20000 animated ops -> the loop isn't allocating.
//
// bytesPerOp is a secondary sanity bound. Measured as a raw heapUsed delta over
// the steady window it is intrinsically bimodal on this workload -- runs land at
// either ~0 or a few hundred B/op with 0 GC either way -- because V8
// occasionally tiers up / transitions an inline cache inside the measured window
// and that one-time, transient cost is still resident at the end sample, so it
// smears across the ops. Whether it lands inside the window is pure timing, and
// a CPU-heavy sibling suite under `node --test`'s default per-file concurrency
// makes it land more often -- which is what turned this into an intermittent
// full-suite failure. So we measure retention, not transient allocation:
// measureOps(stabilize:true) forces a full GC at both steady boundaries, so
// bytesPerOp reflects surviving bytes (deterministically ~0 for a zero-alloc
// loop; measured <= 0.1 B/op) instead of whatever JIT churn happened to be live
// at the end. Those forced GCs are attributed to a separate 'stabilize' phase,
// so the real zero-alloc gate below reads phases.steady.gc (0 minor / 0 major
// over the fixed op window) and is unaffected by them.
//
// Skips without --expose-gc so `npm test` stays green; `npm run test:gc` engages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureOps, checkOps } from '@zakkster/lite-gc-profiler';
import { createStage, geometry, material } from '../Depth.js';
import { createClock } from '@zakkster/lite-clock';
import { createMixer } from '../Motion.js';

const hasGc = typeof globalThis.gc === 'function';
const noop = () => { };
const stub = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });

// Retention ceiling. With stabilize:true bytesPerOp is surviving-allocation
// delta, which sits at ~0 for this zero-alloc loop (measured <= 0.1 B/op); the
// 128 B/op bound is left generous so a lone JIT/IC artifact that somehow
// survives a forced GC can't flake the gate, while still catching any genuine
// per-op retention (< 0.1 B per clip per frame over 1500 clips).
const MAX_BYTES_PER_OP = 128;

test('animation update path is allocation-free (bytes/op at noise floor, 0 steady GC)',
  { skip: hasGc ? false : 'run with --expose-gc (npm run test:gc)' }, () => {
    const N = 1500;
    const s = createStage(stub(), { width: 1280, height: 720, maxNodes: N + 4, maxVerts: (N + 4) * 8, maxDrawFaces: (N + 4) * 6, camera: { radius: 50, near: 0.5, far: 400 } });
    const g = s.geometry(geometry.box(1, 1, 1)), m = s.material(material({}));
    const clock = createClock({ capacity: N + 4 });
    const mx = createMixer(s, { clock, maxClips: N + 4 });
    for (let i = 0; i < N; i++) {
      const th = (i * 2.4) % 6.28, ph = (i * 0.9) % 3.14, r = 6 + (i % 30);
      const n = s.addNode(g, m, {});
      mx.clip(n)
        .posKey(0, r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th))
        .posKey(1, -r * Math.sin(ph), r * Math.cos(ph) * 0.5, r * Math.sin(ph) * Math.sin(th), 'easeInOutCubic')
        .quatEuler(0, 0, 0, 0).quatEuler(1, Math.PI, Math.PI * 0.5, 0, 'easeOutCubic')
        .scaleKey(0, 1).scaleKey(1, 1.4, 'easeInOutSine')
        .play({ duration: 1, loop: 'pingpong', timescale: 0.5 + (i % 10) * 0.1 });
    }
    const op = () => { clock.advance(1 / 60); mx.sync(); s.frame(16); };

    const r = measureOps(op, { ops: 20000, warmup: 6000, stabilize: true });
    const gate = checkOps(r, { maxBytesPerOp: MAX_BYTES_PER_OP });
    // Read the steady phase directly: the stabilize forced GCs live in their own
    // 'stabilize' phase, so steady.gc is the untainted zero-alloc window.
    const steady = r.summary.phases.steady.gc;
    assert.equal(steady.minor, 0, 'steady-phase minor GCs: ' + steady.minor);
    assert.equal(steady.major, 0, 'steady-phase major GCs: ' + steady.major);
    assert.ok(gate.ok, 'bytesPerOp ' + r.bytesPerOp.toFixed(2) + ' exceeded ' + MAX_BYTES_PER_OP);
  });
