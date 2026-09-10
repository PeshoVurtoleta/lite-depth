// demo/gc-smoke.mjs -- headless zero-GC proof for the THREE NEW demo scenes
// (wireframe, hierarchy, cull+dirtyRect) added by this diff, against the frozen
// v1.5.0 library surface (../Depth.js). Not a package file (never in package.json
// files[]); a dev sanity harness only.
//
//   node --expose-gc demo/gc-smoke.mjs
//
// What this proves and what it does NOT prove:
//   - The library's own frame()/paint() zero-alloc property is ALREADY proven by
//     test/torture.mjs (phases B/D). This harness does not re-litigate that.
//   - This harness proves the DEMO's per-frame GLUE around frame() -- the exact
//     arithmetic each new scene's frame handler runs every tick -- allocates 0 B
//     and triggers 0 major GC, for >=20000 warm frames per scene.
//   - hud() itself (DOM textContent write) cannot run headless -- node:test has no
//     DOM. Per scene, hud()'s call sites are replaced by an equivalent in-memory
//     stat READ (accumulated into a scalar so V8 cannot dead-code it), executed
//     under the SAME (f & 7) === 0 mask the real demo uses, faithfully replicating
//     the arithmetic without the DOM write it would otherwise gate. This is stated
//     explicitly wherever it applies below.
//   - cullFrame's overlay glue (drawCullOverlay) is replicated in full: the 4-scalar
//     sceneBox/prevSceneBox union read + compare, INCLUDING the canonical-empty
//     early-out, exactly as demo.html implements it. The actual ctx.strokeRect/
//     clearRect calls are stubbed no-ops (that is what the stub ctx already gives
//     the library itself; browser Canvas2D allocation is out of scope for node:test
//     per the QA charter -- BROWSER-ONLY, see A2/A6 in the QA report).
import { createStage, geometry, material, updateCamera, TAU } from '../Depth.js';
import { checkNoGc, measureOps, measureAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const HOT_FRAMES = 20000;
const DT = 16;
const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

const noop = () => {};
function makeCtx() {
  return {
    canvas: { width: 800, height: 512 },
    setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, fill: noop, stroke: noop, save: noop, restore: noop, rect: noop,
    set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {}, set lineJoin(_) {},
  };
}

let fails = 0;
const results = [];
function gate(name, res, bytesPerCall) {
  const report = checkNoGc(res.summary, RULES);
  const ok = report.ok && bytesPerCall === 0;
  results.push({ name, ok, major: res.summary.gc.major, minor: res.summary.gc.minor, bytesPerCall });
  if (!ok) {
    fails++;
    console.error('  FAIL ' + name + ' major=' + res.summary.gc.major +
      ' bytesPerCall=' + bytesPerCall + ' verdict=' + report.verdict);
    for (const v of report.violations) {
      console.error('    violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
    }
  } else {
    console.log('  ok   ' + name + ' major=' + res.summary.gc.major +
      ' minor=' + res.summary.gc.minor + ' bytesPerCall=' + bytesPerCall + ' B/op');
  }
}

// =========== scene 04 (wire) cold setup -- byte-identical to demo.html ===========
function buildWireStage() {
  const wStage = createStage(makeCtx(), {
    width: 800, height: 512, maxNodes: 8, maxVerts: 2048, maxDrawFaces: 2048,
    camera: { radius: 8.5, theta: 0.6, phi: 1.05, near: 0.1, far: 60 },
  });
  const wGeo = wStage.geometry(geometry.sphere(0.95, 14, 10));
  const wMatWire = wStage.material(material({ r: 95, g: 227, b: 161, fill: false, stroke: '#5fe3a1', lineWidth: 1.4 }));
  const wMatFillOutline = wStage.material(material({ r: 79, g: 217, b: 232, ambient: 0.34, fill: true, stroke: '#05070a', lineWidth: 1.4 }));
  const wMatNoFill = wStage.material(material({ r: 232, g: 107, b: 208, fill: false }));
  const wNodes = [
    wStage.addNode(wGeo, wMatWire, { x: -2.7, y: 0, z: 0 }),
    wStage.addNode(wGeo, wMatFillOutline, { x: 0, y: 0, z: 0 }),
    wStage.addNode(wGeo, wMatNoFill, { x: 2.7, y: 0, z: 0 }),
  ];
  updateCamera(wStage.camera);
  return { wStage, wNodes };
}

// =========== scene 05 (hier) cold setup -- byte-identical to demo.html ===========
function buildHierStage() {
  const hStage = createStage(makeCtx(), {
    width: 800, height: 512, maxNodes: 8, maxVerts: 2048, maxDrawFaces: 2048,
    camera: { radius: 9.5, theta: 0.7, phi: 1.02, near: 0.1, far: 60 },
  });
  const hParentGeo = hStage.geometry(geometry.box(1.6, 1.6, 1.6));
  const hChildGeo = hStage.geometry(geometry.box(0.9, 0.9, 0.9));
  const hMatParent = hStage.material(material({ r: 232, g: 180, b: 95, ambient: 0.3 }));
  const hMatChild = hStage.material(material({ r: 79, g: 217, b: 232, ambient: 0.3 }));
  const hParent = hStage.addNode(hParentGeo, hMatParent, { x: 0, y: 0, z: 0 });
  const hChild = hStage.addNode(hChildGeo, hMatChild, { x: 0, y: 1.7, z: 0 });
  hStage.setScale(hParent, 2.1, 0.6, 1.0);
  hStage.setScale(hChild, 0.85);
  hStage.setParent(hChild, hParent);
  updateCamera(hStage.camera);
  return { hStage, hParent };
}

// =========== scene 06 (cull + dirtyRect) cold setup -- byte-identical ===========
const C_N = 48, C_CAP = 64;
function buildCullStage() {
  const cStage = createStage(makeCtx(), {
    width: 800, height: 512, maxNodes: C_CAP, maxVerts: C_CAP * 8, maxDrawFaces: C_CAP * 6,
    camera: { radius: 15, theta: 0.6, phi: 1.05, near: 0.5, far: 120 },
  });
  const cBox = cStage.geometry(geometry.box(1, 1, 1));
  const cMat = [
    cStage.material(material({ r: 95, g: 227, b: 161, ambient: 0.3 })),
    cStage.material(material({ r: 79, g: 217, b: 232, ambient: 0.3 })),
    cStage.material(material({ r: 232, g: 180, b: 95, ambient: 0.3 })),
  ];
  const cNodes = new Array(C_N);
  const cRad = new Float64Array(C_N);
  const cPhase = new Float64Array(C_N);
  for (let i = 0; i < C_N; i++) {
    cRad[i] = 6 + (i % 8) * 1.7;
    cPhase[i] = (i * 2.39996) % TAU;
    cNodes[i] = cStage.addNode(cBox, cMat[i % 3], { x: 0, y: 0, z: 0 });
  }
  cStage.dirtyRect = true; // exercise the sceneBox/prevSceneBox lane (demo default is off, but the
                            // overlay glue is only live when on -- torture the ON path, the heavier one)
  updateCamera(cStage.camera);
  return { cStage, cNodes, cRad, cPhase };
}

// ---- warm loop 1: wireFrame glue, byte-identical arithmetic to demo.html --------
{
  const { wStage, wNodes } = buildWireStage();
  wStage.frame(DT); // warm once outside the measured window, as torture.mjs does
  let f = 0, acc = 0;
  const res = measureOps(function () {
    // if (wState.auto) { theta += ...; updateCamera(); } -- auto is always true in
    // the demo's default state, so replicate the true branch every frame (the
    // heavier of the two -- the false branch is strictly cheaper, no extra work).
    wStage.camera.theta += DT * 0.00016;
    updateCamera(wStage.camera);
    const spin = f * 0.01;
    for (let i = 0; i < 3; i++) wStage.setEuler(wNodes[i], spin * 0.6, spin, 0);
    const s = wStage.frame(DT);
    // hud($wFd, s.facesDrawn); hud($wDc, s.drawCalls) -- DOM write, replaced by a
    // scalar read under the identical (f & 7) === 0 mask.
    if ((f & 7) === 0) acc = acc + s.facesDrawn + s.drawCalls;
    f++;
  }, { ops: HOT_FRAMES, warmup: 8, source: 'gc', stabilize: 'deep' });
  if (!Number.isFinite(acc)) { fails++; console.error('  FAIL wireFrame glue: non-finite acc'); }
  const { wStage: wStage2, wNodes: wNodes2 } = buildWireStage();
  wStage2.frame(DT);
  let f2 = 0, acc2 = 0;
  const alloc = measureAllocs(function () {
    wStage2.camera.theta += DT * 0.00016;
    updateCamera(wStage2.camera);
    const spin = f2 * 0.01;
    for (let i = 0; i < 3; i++) wStage2.setEuler(wNodes2[i], spin * 0.6, spin, 0);
    const s = wStage2.frame(DT);
    if ((f2 & 7) === 0) acc2 = acc2 + s.facesDrawn + s.drawCalls;
    f2++;
  }, { iterations: 4096, warmup: 16 });
  if (!Number.isFinite(acc2)) { fails++; console.error('  FAIL wireFrame glue alloc probe: non-finite acc2'); }
  gate('wireFrame glue (scene 04)', res, alloc.bytesPerCall);
}

// ---- warm loop 2: hierFrame glue, byte-identical arithmetic to demo.html -------
{
  const { hStage, hParent } = buildHierStage();
  hStage.frame(DT);
  let f = 0, acc = 0;
  const res = measureOps(function () {
    hStage.camera.theta += DT * 0.00016;
    updateCamera(hStage.camera);
    const spin = f * 0.008;
    hStage.setEuler(hParent, spin * 0.4, spin, spin * 0.2);
    const s = hStage.frame(DT);
    // hud($hNu, s.nodesNonUniform); hud($hFd, s.facesDrawn); hud($hNt, s.nodesTotal)
    if ((f & 7) === 0) acc = acc + s.nodesNonUniform + s.facesDrawn + s.nodesTotal;
    f++;
  }, { ops: HOT_FRAMES, warmup: 8, source: 'gc', stabilize: 'deep' });
  if (!Number.isFinite(acc)) { fails++; console.error('  FAIL hierFrame glue: non-finite acc'); }
  const { hStage: hStage2, hParent: hParent2 } = buildHierStage();
  hStage2.frame(DT);
  let f2 = 0, acc2 = 0;
  const alloc = measureAllocs(function () {
    hStage2.camera.theta += DT * 0.00016;
    updateCamera(hStage2.camera);
    const spin = f2 * 0.008;
    hStage2.setEuler(hParent2, spin * 0.4, spin, spin * 0.2);
    const s = hStage2.frame(DT);
    if ((f2 & 7) === 0) acc2 = acc2 + s.nodesNonUniform + s.facesDrawn + s.nodesTotal;
    f2++;
  }, { iterations: 4096, warmup: 16 });
  if (!Number.isFinite(acc2)) { fails++; console.error('  FAIL hierFrame glue alloc probe: non-finite acc2'); }
  gate('hierFrame glue (scene 05)', res, alloc.bytesPerCall);
}

// ---- warm loop 3: cullFrame + drawCullOverlay glue, byte-identical arithmetic --
{
  const { cStage, cNodes, cRad, cPhase } = buildCullStage();
  cStage.frame(DT);
  let f = 0, acc = 0, now = 0;
  const res = measureOps(function () {
    cStage.camera.theta += DT * 0.00014;
    updateCamera(cStage.camera);
    now += DT;
    const t = now * 0.00035;
    for (let i = 0; i < C_N; i++) {
      const a = cPhase[i] + t, r = cRad[i];
      cStage.setPosition(cNodes[i], Math.cos(a) * r, Math.sin(a * 1.3) * r * 0.5, Math.sin(a) * r);
    }
    const s = cStage.frame(DT);
    // drawCullOverlay(): the 4-scalar sceneBox/prevSceneBox union read + canonical-
    // empty early-out, in place from the getters, exactly as demo.html. The actual
    // canvas clearRect/strokeRect calls are the makeCtx() no-ops (browser Canvas2D
    // allocation itself is BROWSER-ONLY, see A2/A6).
    const bx = cStage.sceneBox, by = cStage.prevSceneBox;
    let minx = bx[0], miny = bx[1], maxx = bx[2], maxy = bx[3];
    if (by[0] < minx) minx = by[0];
    if (by[1] < miny) miny = by[1];
    if (by[2] > maxx) maxx = by[2];
    if (by[3] > maxy) maxy = by[3];
    const boxOk = maxx > minx && maxy > miny;
    // hud($cNc, s.nodesCulled); hud($cFc, s.facesCulled); hud($cFd, s.facesDrawn)
    if ((f & 7) === 0) acc = acc + s.nodesCulled + s.facesCulled + s.facesDrawn + (boxOk ? 1 : 0);
    f++;
  }, { ops: HOT_FRAMES, warmup: 8, source: 'gc', stabilize: 'deep' });
  if (!Number.isFinite(acc) || acc <= 0) { fails++; console.error('  FAIL cullFrame glue: acc=' + acc + ' (no work / dead code)'); }
  const { cStage: cStage2, cNodes: cNodes2, cRad: cRad2, cPhase: cPhase2 } = buildCullStage();
  cStage2.frame(DT);
  let f2 = 0, acc2 = 0, now2 = 0;
  const alloc = measureAllocs(function () {
    cStage2.camera.theta += DT * 0.00014;
    updateCamera(cStage2.camera);
    now2 += DT;
    const t = now2 * 0.00035;
    for (let i = 0; i < C_N; i++) {
      const a = cPhase2[i] + t, r = cRad2[i];
      cStage2.setPosition(cNodes2[i], Math.cos(a) * r, Math.sin(a * 1.3) * r * 0.5, Math.sin(a) * r);
    }
    const s = cStage2.frame(DT);
    const bx = cStage2.sceneBox, by = cStage2.prevSceneBox;
    let minx = bx[0], miny = bx[1], maxx = bx[2], maxy = bx[3];
    if (by[0] < minx) minx = by[0];
    if (by[1] < miny) miny = by[1];
    if (by[2] > maxx) maxx = by[2];
    if (by[3] > maxy) maxy = by[3];
    const boxOk = maxx > minx && maxy > miny;
    if ((f2 & 7) === 0) acc2 = acc2 + s.nodesCulled + s.facesCulled + s.facesDrawn + (boxOk ? 1 : 0);
    f2++;
  }, { iterations: 4096, warmup: 16 });
  if (!Number.isFinite(acc2)) { fails++; console.error('  FAIL cullFrame glue alloc probe: non-finite acc2'); }
  gate('cullFrame + drawCullOverlay glue (scene 06)', res, alloc.bytesPerCall);
}

// ---- A5: 200 clear()+rebuild cycles on the cull scene's exact node population --
// c-reload's real handler is `cStage.clear(); buildCull(); updateCullReadouts();`.
// Replicated verbatim, 200x: after EVERY clear() remainingNodes must snap back to
// maxNodes (C_CAP), structureEpoch must strictly increase (a fresh epoch per
// structural rebuild -- never repeat, never regress), and an external per-node
// resource tracked via lite-leak (one per handle, mirroring how a real caller
// would pair its own bookkeeping to each addNode()) must drain back to 0.
// clear() itself invalidates every prior handle (per the demo's own comment at
// c-reload), so the correct external-bookkeeping response is to untrack() the
// PRIOR cycle's resources before rebuilding -- exactly as Phase A of
// test/torture.mjs pairs addNode()/track() with remove()/untrack(). A tracker
// that is never paired with untrack() would trivially also reach size()===0
// once GC'd, which would prove nothing; pairing it is what makes this a real
// oracle, not a vacuous one.
{
  const { cStage: rStage } = buildCullStage();
  rStage.clear(); // buildCullStage() already populated C_N nodes; start this
                   // section from an empty stage so the tracked-rebuild loop
                   // below owns 100% of the node population it reasons about.
  const NOOP = function () {};
  const tracker = createLeakTracker({ name: 'cull-clear-reserve' });
  const cBox2 = rStage.geometry(geometry.box(1, 1, 1));
  const cMat2 = rStage.material(material({ r: 95, g: 227, b: 161, ambient: 0.3 }));
  const INDEX_MASK = 0xFFFFF;

  let liveHandles = []; // lite-leak handles for the CURRENT rebuild's C_N nodes

  function rebuild() {
    const handles = new Array(C_N);
    for (let i = 0; i < C_N; i++) {
      const h = rStage.addNode(cBox2, cMat2, { x: 0, y: 0, z: 0 });
      const slot = h & INDEX_MASK; // primitive tag -- never close over `h` itself
      handles[i] = tracker.track({ slot }, NOOP, slot);
    }
    liveHandles = handles;
  }

  rebuild();
  let prevEpoch = rStage.structureEpoch;
  let epochMonotonic = true;
  let remOk = true;
  const CYCLES = 200;
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    // clear() invalidates every prior handle -- release the paired external
    // bookkeeping in the same breath, exactly as the demo's c-reload does.
    for (let i = 0; i < liveHandles.length; i++) tracker.untrack(liveHandles[i]);
    rStage.clear();
    if (rStage.remainingNodes !== C_CAP) remOk = false;
    if (!(rStage.structureEpoch > prevEpoch)) epochMonotonic = false;
    prevEpoch = rStage.structureEpoch;
    rebuild();
  }
  // final cycle: release the last rebuild's bookkeeping too, so the drained-to-0
  // check is not left hostage to nodes the demo would still consider "live".
  for (let i = 0; i < liveHandles.length; i++) tracker.untrack(liveHandles[i]);
  rStage.clear();
  globalThis.gc?.();
  await new Promise((r) => setTimeout(r, 50));
  const trackerSize = tracker.size();
  const findings = tracker.audit().length;
  const a5ok = remOk && epochMonotonic && trackerSize === 0 && findings === 0;
  if (!a5ok) fails++;
  console.log((a5ok ? '  ok   ' : '  FAIL ') +
    'A5 clear/reserve retention: 200 cycles, remainingNodes===maxNodes every cycle=' + remOk +
    ' structureEpoch strictly increasing=' + epochMonotonic +
    ' finalEpoch=' + prevEpoch +
    ' leakTracker.size()=' + trackerSize + ' (must be 0)' +
    ' findings=' + findings + ' (must be 0)');
}

console.log(fails === 0 ? 'GC-SMOKE ok' : ('GC-SMOKE FAIL (' + fails + ')'));
for (const r of results) {
  console.log('  ' + r.name + ': major=' + r.major + ' minor=' + r.minor + ' bytesPerCall=' + r.bytesPerCall);
}
process.exitCode = fails === 0 ? 0 : 1;
