// The headline: the render loop (transform -> project -> cull -> radix sort ->
// paint) allocates zero. Measured with @zakkster/lite-gc-profiler; settle()
// flushes the async perf_hooks GC observer (a synchronous read returns a false
// 0). Skips cleanly without --expose-gc so `npm test` stays green; `npm run
// test:gc` engages it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, checkNoGc, compareGc } from '@zakkster/lite-gc-profiler';
import { createStage, geometry, material } from '../Depth.js';

const hasGc = typeof globalThis.gc === 'function';
const noop = () => { };
const stubCtx = () => ({ setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { } });

test('steady-state render loop is allocation-free (0 major / 0 minor GC)', { skip: hasGc ? false : 'run with --expose-gc (npm run test:gc)' }, async () => {
  const N = 2000, FRAMES = 1500;
  const stage = createStage(stubCtx(), { width: 1280, height: 720, maxNodes: N + 4, maxVerts: (N + 4) * 8, maxDrawFaces: (N + 4) * 6, camera: { radius: 40, near: 0.5, far: 400 } });
  const g = stage.geometry(geometry.box(1, 1, 1)), m = stage.material(material({}));
  const H = new Array(N);
  for (let i = 0; i < N; i++) { const th = (i * 2.4) % 6.28, ph = (i * 0.9) % 3.14, r = 6 + (i % 30); H[i] = stage.addNode(g, m, { x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph), z: r * Math.sin(ph) * Math.sin(th) }); }
  const body = (f) => { const t = f * 0.016; for (let i = 0; i < N; i++) stage.setEuler(H[i], t, t * 0.7, 0.3); stage.frame(16); };

  for (let f = 0; f < 200; f++) body(f);          // warmup
  globalThis.gc(); globalThis.gc();                // collect warmup residue so it can't promote mid-window

  // control: empty frames, pure V8/profiler self-noise baseline
  const control = new GcProfiler().start();
  for (let f = 0; f < FRAMES; f++) control.markFrame(16);
  await control.settle(); const cSum = control.summary(); control.stop();

  const gc = new GcProfiler().start();
  for (let f = 0; f < FRAMES; f++) { body(f); gc.markFrame(16); }
  await gc.settle(); const sum = gc.summary(); gc.stop();

  const direct = checkNoGc(sum, { maxMajor: 0, maxMinor: 0 });
  const diff = compareGc(cSum, sum, { maxExtraMajor: 0, maxExtraMinor: 0 });
  assert.equal(sum.gc.major, 0, 'major GCs in render loop: ' + sum.gc.major);
  assert.equal(direct.verdict, 'pass', 'direct gate: ' + direct.verdict + ' (major=' + sum.gc.major + ' minor=' + sum.gc.minor + ')');
  assert.notEqual(diff.verdict, 'fail', 'differential vs control failed');
});
