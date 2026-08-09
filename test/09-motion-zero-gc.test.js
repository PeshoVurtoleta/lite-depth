// The animation update path (mixer.update -> eval channels -> write node lanes)
// must be allocation-free, the same contract as the render loop.
//
// The primary gate is ZERO GC over a FIXED op window: measureOps runs a fixed
// 20000 ops in its steady phase, and if the loop produced young-gen pressure,
// scavenges would fire (young gen fills by bytes, not by wall clock). Zero
// minor + zero major over 20000 animated ops -> the loop isn't allocating.
//
// bytesPerOp (heapUsed deltas, self-noise cancelled) is a secondary sanity
// bound. It is bimodal on this workload -- runs land at either ~0 or ~80 B/op
// with 0 GC either way -- because V8 occasionally tiers up / transitions an
// inline cache inside the measured window and that one-time cost smears across
// the ops. So we bound it loosely (128 B/op = < 0.1 B per clip per frame over
// 1500 clips, far below one object's worth of per-clip allocation) rather than
// chase a strict 0 the heap-delta method can't deliver reliably.
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

// 128 B/op ceiling absorbs the bimodal JIT tier-up artifact (0 or ~80 B/op,
// always with 0 GC); still < 0.1 B per clip per frame over 1500 clips.
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

    const r = measureOps(op, { ops: 20000, warmup: 6000 });
    const gate = checkOps(r, { maxBytesPerOp: MAX_BYTES_PER_OP });
    assert.equal(r.summary.gc.minor, 0, 'steady-phase minor GCs: ' + r.summary.gc.minor);
    assert.equal(r.summary.gc.major, 0, 'steady-phase major GCs: ' + r.summary.gc.major);
    assert.ok(gate.ok, 'bytesPerOp ' + r.bytesPerOp.toFixed(2) + ' exceeded ' + MAX_BYTES_PER_OP);
  });
