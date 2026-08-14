/**
 * @zakkster/lite-depth — zero-GC Canvas2D software-projected 3D.
 * Zdog's niche, arena-backed. Zdog allocates; lite-depth doesn't.
 */

/** 2 * Math.PI. */
export const TAU: number;

/** Package version string. */
export const version: string;

/** Node flag namespace (lite-fastbit32 BitMapper). Bit names below. */
export const FLAGS: {
  get(name: FlagName): number;
  getMask(): number;
  getName(bit: number): string;
};

export type FlagName =
  | 'VISIBLE' | 'PICKABLE' | 'DIRTY' | 'NON_UNIFORM_SCALE'
  | 'BILLBOARD' | 'CAST_SHADOW' | 'DOUBLE_SIDED' | 'STROKE';

/** A built, shareable geometry. Instanced per node; never mutated on the hot path. */
export interface Geometry {
  /** Vertex count. */
  readonly V: number;
  /** Face count (0 for stroke geometries). */
  readonly F: number;
  /** Draw-list entries emitted per visible node: `F` for fills, `1` for strokes. Gates the overflow door. */
  readonly drawSlots: number;
  /** Local-space vertices, xyz interleaved (Float32, memory-dense). */
  readonly verts: Float32Array;
  /** CSR offset table into `faceVerts`, length F+1. */
  readonly faceVertOffset: Uint32Array;
  /** Flattened per-face vertex indices. */
  readonly faceVerts: Uint32Array;
  /** Precomputed local-space face normals, xyz interleaved (Float32). */
  readonly faceNormal: Float32Array;
  /** Bounding-sphere radius (local space) for cheap frustum reject. */
  readonly radius: number;
  /** `'fill'` for solid primitives, `'stroke'` for polylines. */
  readonly kind: 'fill' | 'stroke';
}

/** Flat-shaded material with a pre-baked fillStyle ramp (no per-frame string building). */
export interface Material {
  /** K-step hex string ramp, indexed by shade at paint time. */
  readonly lut: string[];
  readonly K: number;
  readonly stroke: string | null;
  readonly lineWidth: number;
  readonly fill: boolean;
}

export interface MaterialOptions {
  /** Base colour 0–255. Defaults: r=90, g=200, b=120. */
  r?: number; g?: number; b?: number;
  /** Ambient floor 0–1 (shade never drops below this). Default 0.35. */
  ambient?: number;
  /** Ramp resolution. Default 64. */
  steps?: number;
  /** Stroke colour for outlined/polyline nodes. */
  stroke?: string | null;
  /** Stroke width in CSS px. Default 2. */
  lineWidth?: number;
  /** Set false for stroke-only. Default true. */
  fill?: boolean;
}

/** Perspective/orthographic camera with spherical-orbit parameters. Interaction lives outside core. */
export interface Camera {
  /** World→view affine (3×4, row-major, 12 elements). Rebuilt by updateCamera. */
  view: Float64Array;
  fov: number;
  near: number;
  far: number;
  ortho: boolean;
  orthoScale: number;
  /** Orbit target. */
  tx: number; ty: number; tz: number;
  /** Spherical orbit: azimuth, polar, distance. */
  theta: number; phi: number; radius: number;
}

export interface CameraOptions {
  fov?: number; near?: number; far?: number;
  ortho?: boolean; orthoScale?: number;
  targetX?: number; targetY?: number; targetZ?: number;
  theta?: number; phi?: number; radius?: number;
}

/** Per-frame pipeline counters and phase timings (ms). */
export interface StageStats {
  facesDrawn: number;
  facesCulled: number;
  nodesCulled: number;
  drawCalls: number;
  tTransform: number;
  tProject: number;
  tSort: number;
  tPaint: number;
  /** Nodes skipped by the frame-arena overflow door (vert or draw-face budget exceeded). */
  facesOverflowed: number;
  /** Reserved always-zero hook for the NaN/invalid-node reject (wired in a later milestone). */
  nodesInvalid: number;
  /** Nodes whose parent handle was dead/recycled this frame and were reparented to ROOT. */
  nodesOrphaned: number;
  /** Live node count this frame. */
  nodesTotal: number;
}

/** Opaque generational node handle (lite-arena). Stale handles invalidate, never alias. */
export type NodeHandle = number;

export interface NodeInit {
  x?: number; y?: number; z?: number;
  /** 0–63 painter layer (high bits of the sort key). */
  layer?: number;
  /** Parent node handle (omit for root). */
  parent?: NodeHandle;
}

export interface StageOptions {
  width?: number; height?: number; dpr?: number;
  /** Node capacity (arena size). */
  maxNodes?: number;
  /** Total projected-vertex budget per frame across all instances. */
  maxVerts?: number;
  /** Total draw-face budget per frame. */
  maxDrawFaces?: number;
  camera?: CameraOptions;
}

/** Optional lite-signal dependency-injection surface (cold path). */
export interface SignalApi { effect(fn: () => void): unknown; }
export type BindChannel = 'position' | 'scale' | 'quaternion';

export interface Stage {
  readonly camera: Camera;
  readonly stats: StageStats;
  width: number; height: number; dpr: number;
  /** Normalized directional light (xyz, Float64). */
  readonly light: Float64Array;
  /** Optional external 2D view transform (Float64Array[6]) applied once per frame (lite-camera hook). */
  view2d: Float64Array | null;

  /** Register a geometry; returns its id for addNode. */
  geometry(g: Geometry): number;
  /** Register a material; returns its id for addNode. */
  material(m: Material): number;

  addNode(geomId: number, matId: number, init?: NodeInit): NodeHandle;
  setPosition(h: NodeHandle, x: number, y: number, z: number): void;
  setScale(h: NodeHandle, x: number, y?: number, z?: number): void;
  setQuaternion(h: NodeHandle, x: number, y: number, z: number, w: number): void;
  setEuler(h: NodeHandle, ex: number, ey: number, ez: number): void;
  setParent(h: NodeHandle, parent?: NodeHandle): void;
  setLayer(h: NodeHandle, layer: number): void;
  setDepthBias(h: NodeHandle, bias: number): void;
  setVisible(h: NodeHandle, visible: boolean): void;
  remove(h: NodeHandle): void;
  resize(w: number, h: number, dpr?: number): void;

  /**
   * Remove every node in place (advances all generations, so every handle minted
   * before clear() is invalid afterward) and reset the live count to 0. Geometries,
   * materials, camera, frame arenas and capacity are kept. Bumps structureEpoch.
   * Allocates nothing. Returns the stage for chaining.
   */
  clear(): Stage;
  /**
   * Grow all node-capacity-sized lanes to hold `n` nodes (cold, between frames).
   * Returns false (a defined no-op) when `n <= current capacity`, true after a
   * successful grow. Throws on a non-integer or negative `n`. Bumps structureEpoch.
   */
  reserve(n: number): boolean;
  /** Free node slots remaining before the arena is full (capacity - live count). */
  readonly remainingNodes: number;
  /**
   * Monotonic Uint32 (wraps) bumped by addNode/remove/setParent/clear. The single
   * invalidation signal for any cached dense index (read-only).
   */
  readonly structureEpoch: number;

  /** Provide a lite-signal effect() so bind() can wire cold-path reactivity. */
  useSignals(api: SignalApi): Stage;
  /** Drive a node channel from a signal getter (cold path; writes lanes + marks dirty). */
  bind(h: NodeHandle, channel: BindChannel, get: () => ArrayLike<number>): void;

  /** Run one frame: transform → project → cull → radix sort → paint. Zero allocation. */
  frame(dt: number): StageStats;
}

export const mathKernels: {
  composeTRS(out: Float64Array, tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): void;
  mulAffine(out: Float64Array, A: ArrayLike<number>, B: ArrayLike<number>): void;
  quatRotate(out: Float64Array, qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number): void;
};

export const geometry: {
  custom(verts: ArrayLike<number>, faces: number[][]): Geometry;
  box(w?: number, h?: number, d?: number): Geometry;
  plane(w?: number, d?: number): Geometry;
  sphere(radius?: number, segU?: number, segV?: number): Geometry;
  cylinder(radius?: number, height?: number, seg?: number): Geometry;
  cone(radius?: number, height?: number, seg?: number): Geometry;
  polyline(points: ArrayLike<number>): Geometry;
};

export function material(opts: MaterialOptions): Material;
/** Build a material directly from a pre-baked hex ramp (e.g. a lite-hueforge scale). */
export function materialFromRamp(hexRamp: string[], opts?: Pick<MaterialOptions, 'stroke' | 'lineWidth' | 'fill'>): Material;

export function createCamera(opts?: CameraOptions): Camera;
/** Rebuild the camera's world→view affine from its orbit parameters (cold). */
export function updateCamera(cam: Camera): void;

export function createStage(ctx: CanvasRenderingContext2D, opts?: StageOptions): Stage;
