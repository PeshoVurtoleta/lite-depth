// lite-depth vs Zdog + throughput sweep. Matched rotating box fields, identical
// no-op Canvas2D ctx (both hit the same backend in production, so a no-op ctx
// isolates the JS pipeline — the real differentiator). GC via lite-gc-profiler
// with settle() (perf_hooks delivers async; a naive sync read reports a false 0).
//
// Container-measured — timings are INDICATIVE, not the pinned MBP/iPhone bars.
//
// Env note: Zdog needs a DOM. The window/document mocks are installed into a
// localized wrapper and RESTORED afterward, so importing this file cannot leak
// globals into a larger test process.
import { GcProfiler } from '@zakkster/lite-gc-profiler';

const noop = () => { };
const mkctx = () => ({ setTransform: noop, transform: noop, translate: noop, scale: noop, rotate: noop, save: noop, restore: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop, closePath: noop, arc: noop, fill: noop, stroke: noop, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { }, set lineCap(v) { }, set lineJoin(v) { } });
const now = () => performance.now();

// ── localized env mocks (installed, then restored) ──
function installDomMocks() {
  const sharedCtx = mkctx();
  const fakeCanvas = { nodeName: 'CANVAS', width: 1280, height: 720, style: {}, getContext: () => sharedCtx, addEventListener: noop, removeEventListener: noop };
  const saved = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
  globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: noop, removeEventListener: noop, PointerEvent: function () { } };
  globalThis.document = { querySelector: () => fakeCanvas, createElementNS: () => ({ style: {}, setAttribute: noop }) };
  const restore = () => {
    if (saved.window) Object.defineProperty(globalThis, 'window', saved.window); else delete globalThis.window;
    if (saved.document) Object.defineProperty(globalThis, 'document', saved.document); else delete globalThis.document;
  };
  return { fakeCanvas, restore };
}

async function main() {
  const { fakeCanvas, restore } = installDomMocks();
  const Zdog = (await import('zdog')).default;
  const { createStage, geometry, material } = await import('../Depth.js');

  const FRAMES = 400, COUNTS = [500, 1000, 2000];

  const liteScene = (N) => {
    const stage = createStage(mkctx(), { width: 1280, height: 720, maxNodes: N + 4, maxVerts: (N + 4) * 8, maxDrawFaces: (N + 4) * 6, camera: { radius: Math.max(20, Math.sqrt(N) * 1.3), near: 0.5, far: 4000 } });
    const boxG = stage.geometry(geometry.box(1, 1, 1)), mat = stage.material(material({ r: 90, g: 200, b: 120 }));
    const root = stage.addNode(boxG, mat, {}); stage.setVisible(root, false);
    const side = Math.ceil(Math.cbrt(N)); let made = 0;
    for (let x = 0; x < side && made < N; x++) for (let y = 0; y < side && made < N; y++) for (let z = 0; z < side && made < N; z++) { stage.addNode(boxG, mat, { x: (x - side / 2) * 1.6, y: (y - side / 2) * 1.6, z: (z - side / 2) * 1.6, parent: root }); made++; }
    return { step: (f) => { stage.setEuler(root, f * 0.01, f * 0.013, 0); stage.frame(16); }, stage };
  };
  const zdogScene = (N) => {
    const illo = new Zdog.Illustration({ element: fakeCanvas, zoom: 1 });
    const side = Math.ceil(Math.cbrt(N)); let made = 0;
    for (let x = 0; x < side && made < N; x++) for (let y = 0; y < side && made < N; y++) for (let z = 0; z < side && made < N; z++) { new Zdog.Box({ addTo: illo, width: 1, height: 1, depth: 1, stroke: false, color: '#5ac878', translate: { x: (x - side / 2) * 1.6, y: (y - side / 2) * 1.6, z: (z - side / 2) * 1.6 } }); made++; }
    return { step: (f) => { illo.rotate.x = f * 0.01; illo.rotate.y = f * 0.013; illo.updateRenderGraph(); } };
  };
  const run = async (make) => {
    const { step, stage } = make;
    for (let f = 0; f < 120; f++) step(f);
    if (globalThis.gc) { globalThis.gc(); globalThis.gc(); }
    const gc = new GcProfiler().start();
    const t0 = now(); for (let f = 0; f < FRAMES; f++) step(f); const ms = (now() - t0) / FRAMES;
    await gc.settle(); const g = gc.summary().gc; gc.stop();
    return { ms, gc: g, faces: stage ? stage.stats.facesDrawn : null };
  };

  console.log('lite-depth v1.0.0 vs Zdog — matched rotating box fields, no-op ctx, ' + FRAMES + ' frames');
  console.log('(container measurement — INDICATIVE only, not the pinned MBP/iPhone bars)\n');
  console.log('   N  | lite ms | lite GC | Zdog ms  | Zdog GC (maj/min) | speedup');
  console.log('  ----|---------|---------|----------|-------------------|--------');
  for (const N of COUNTS) {
    const L = await run(liteScene(N)), Z = await run(zdogScene(N));
    console.log('  ' + String(N).padStart(4) + ' | ' + L.ms.toFixed(3).padStart(7) + ' | ' + String(L.gc.major + '/' + L.gc.minor).padStart(7) + ' | ' + Z.ms.toFixed(3).padStart(8) + ' | ' + String(Z.gc.major + '/' + Z.gc.minor).padStart(17) + ' | ' + (Z.ms / L.ms).toFixed(1) + 'x');
  }

  console.log('\nlite-depth throughput sweep (all-boxes, whole field rotating, zero-GC at every size):');
  console.log('     N   | ms/frame | faces/frame | Mface/s | GC');
  console.log('  -------|----------|-------------|---------|-----');
  for (const N of [1000, 4000, 8000, 16000]) {
    const r = await run(liteScene(N));
    console.log('  ' + String(N).padStart(6) + ' | ' + r.ms.toFixed(3).padStart(8) + ' | ' + String(r.faces).padStart(11) + ' | ' + ((r.faces / (r.ms / 1000)) / 1e6).toFixed(1).padStart(7) + ' | ' + (r.gc.major + '/' + r.gc.minor));
  }

  restore();   // undo the DOM mocks — no global side effects leak out
  console.log('\nglobals restored:', 'window' in globalThis ? 'window still set (unexpected)' : 'window cleared', '·', 'document' in globalThis ? 'document still set' : 'document cleared');
}
main();
