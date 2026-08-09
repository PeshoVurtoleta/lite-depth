/**
 * @zakkster/lite-depth/motion — v1.1.0 animation layer for lite-depth.
 * Composes lite-clock (time base), lite-keyframe (scalar channels) and
 * lite-ease (easing bank); adds quaternion slerp tracks and a clip table
 * bound to lite-depth node lanes. Allocation-free update path.
 */

import type { Stage, NodeHandle } from './Depth';

/** Loop-mode constants (also settable by string on `play`). */
export const ONCE: 0;
export const LOOP: 1;
export const PINGPONG: 2;

export const version: string;

/** Minimal lite-clock surface the mixer consumes. */
export interface ClockLike {
  readonly simTime: number;
}

export interface MixerOptions {
  /** lite-clock instance. Omit for standalone dt mode (`update(dt)`). */
  clock?: ClockLike | null;
  /** Max concurrent clips (one per animated node). Default 256. */
  maxClips?: number;
  /** Max keys per scalar channel row. Default 8. */
  maxKeys?: number;
  /** Max keys per quaternion track. Default 8. */
  maxQuatKeys?: number;
  /**
   * Easing bank as lite-ease function names. Index 0 should be 'linear'.
   * Names become the ids used by the `ease` argument on `*Key` calls.
   */
  easings?: string[];
}

export type LoopMode = 'loop' | 'pingpong' | number;

export interface PlayOptions {
  /** Clip length in seconds. Defaults to the max key time across channels. */
  duration?: number;
  /** 'loop' | 'pingpong' | numeric loop-mode. Default: play once. */
  loop?: LoopMode;
  /** Playback-rate multiplier. Default 1. */
  timescale?: number;
  /** Absolute start time in the clock's domain. Default: now. */
  start?: number;
}

/** Easing selector: a bank name, a bank index, or omit for linear. */
export type Ease = string | number | undefined;

/** A clip animates one node. All `*Key` and lifecycle calls are chainable. */
export interface Clip {
  readonly id: number;
  /** Position key at time `t` (seconds). */
  posKey(t: number, x: number, y: number, z: number, ease?: Ease): Clip;
  /** Scale key; pass only `x` for uniform scale. */
  scaleKey(t: number, x: number, y?: number, z?: number, ease?: Ease): Clip;
  /** Depth-bias scalar key. */
  biasKey(t: number, v: number, ease?: Ease): Clip;
  /** Quaternion key (slerp between quats; nlerp fast path near-parallel). */
  quatKey(t: number, x: number, y: number, z: number, w: number, ease?: Ease): Clip;
  /** Quaternion key from XYZ Euler angles (radians). */
  quatEuler(t: number, ex: number, ey: number, ez: number, ease?: Ease): Clip;

  play(opts?: PlayOptions): Clip;
  pause(): Clip;
  resume(): Clip;
  stop(): Clip;
  /** Jump to a local time (seconds) within the clip. */
  seek(local: number): Clip;

  readonly done: boolean;
  readonly playing: boolean;
}

export interface Mixer {
  /** Create a clip bound to a node handle. */
  clip(node: NodeHandle): Clip;
  /** Standalone mode: advance internal time by `dt` (seconds), then apply. */
  update(dt: number): Mixer;
  /** Clock mode: apply at the clock's current simTime (after clock.advance). */
  sync(): Mixer;
  readonly time: number;
  readonly clipCount: number;
}

export function createMixer(stage: Stage, opts?: MixerOptions): Mixer;
