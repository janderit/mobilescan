/**
 * Live document detection on the camera view: runs the paper edge search
 * on the video element a few times per second, from the static camera
 * frame, feeds a `DetectionTracker` and reports its state; `detectStill`
 * is the capture rule that runs once more on the still after the shutter.
 * Pure scheduling and glue; the maths lives in detect.ts, the rendering in
 * canvas.ts.
 */

import {
  AGREE_FRACTION,
  createDetectScratch,
  DetectionTracker,
  detectFrameIn,
  detectFrameStrict,
  releaseDetectScratch,
  type DetectScratch,
  type TrackerState,
} from './detect';
import { quadCorners } from './geometry';
import type { Frame } from './model';

/** Minimum time between the starts of two runs. */
export const RUN_INTERVAL_MS = 150;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface LiveDetectorOptions {
  /** Called after every run with the tracker's state. */
  onResult: (state: TrackerState) => void;
  /** Time source, for tests. */
  now?: () => number;
  /** The detection on one working copy, for tests. */
  detect?: typeof detectFrameStrict;
}

export class LiveDetector {
  private readonly video: FrameCallbackVideo;
  private readonly now: () => number;
  private readonly detect: typeof detectFrameStrict;
  private tracker: DetectionTracker | null = null;
  /** Working canvas and luminance buffers reused across runs. */
  private scratch: DetectScratch | null = null;
  private frame: Frame | null = null;
  private imageWidth = 0;
  private lastRun = Number.NEGATIVE_INFINITY;
  private handle: number | null = null;
  private usesVideoFrames = false;

  constructor(
    video: HTMLVideoElement,
    private readonly options: LiveDetectorOptions,
  ) {
    this.video = video;
    this.now = options.now ?? (() => performance.now());
    this.detect = options.detect ?? detectFrameStrict;
  }

  /** True while runs are scheduled. */
  get running(): boolean {
    return this.handle !== null;
  }

  /** The tracker's current state. */
  get state(): TrackerState {
    return this.tracker?.state() ?? { found: false, corners: null };
  }

  /**
   * Starts (or restarts, with an empty tracker) detecting the given static
   * frame in the video's intrinsic pixels.
   */
  start(frame: Frame, imageWidth: number): void {
    this.stop();
    this.frame = frame;
    this.imageWidth = imageWidth;
    this.tracker = new DetectionTracker(AGREE_FRACTION * frame.width);
    this.scratch = createDetectScratch();
    this.lastRun = Number.NEGATIVE_INFINITY;
    this.schedule();
  }

  /** Stops the runs and forgets the tracker state. */
  stop(): void {
    if (this.handle !== null) {
      if (this.usesVideoFrames) this.video.cancelVideoFrameCallback?.(this.handle);
      else cancelAnimationFrame(this.handle);
      this.handle = null;
    }
    this.tracker = null;
    this.frame = null;
    if (this.scratch) releaseDetectScratch(this.scratch);
    this.scratch = null;
  }

  private schedule(): void {
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.usesVideoFrames = true;
      this.handle = this.video.requestVideoFrameCallback(() => this.tick());
    } else if (typeof requestAnimationFrame === 'function') {
      this.usesVideoFrames = false;
      this.handle = requestAnimationFrame(() => this.tick());
    } else {
      this.handle = null;
    }
  }

  private tick(): void {
    this.handle = null;
    if (!this.tracker || !this.frame) return;
    const now = this.now();
    if (now - this.lastRun >= RUN_INTERVAL_MS) {
      this.lastRun = now;
      this.options.onResult(this.run());
    }
    this.schedule();
  }

  /** One detection run on the current video frame. */
  run(): TrackerState {
    if (!this.tracker || !this.frame) return this.state;
    let corners = null;
    try {
      const detected = detectFrameIn(this.video, this.frame, this.imageWidth, this.detect, this.scratch ?? undefined);
      corners = detected ? quadCorners(detected) : null;
    } catch (error) {
      // A run that fails (canvas memory, detached stream) is a miss; the loop goes on.
      console.error('Live-Erkennung fehlgeschlagen', error);
    }
    return this.tracker.push(corners);
  }
}

/**
 * The strict detection on a captured still, from the static frame. Null when
 * no document is found or the detection fails (logged); the capture then
 * keeps the static frame. Runs synchronously (about 0.5 MP of work).
 */
export function detectStill(image: HTMLCanvasElement, frame: Frame): Frame | null {
  try {
    return detectFrameIn(image, frame, image.width, detectFrameStrict);
  } catch (error) {
    console.error('Erkennung fehlgeschlagen', error);
    return null;
  }
}
