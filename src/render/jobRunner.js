// Frame job runner built on a DenoiseRenderer.
//
// Executes a scheduler plan segment by segment. For each segment it renders
// the warm-up frames (discarding their output but keeping history) and then
// the delivered frames. Every delivered frame produces:
//   * denoised RGBA8 preview
//   * noisy RGBA8 preview (raw path-traced frame, for review)
//   * independent RGBA8 preview (per-frame denoise, for comparison)
//   * adoption RGBA8 visualization (history acceptance)
//   * per-frame metrics (history weight, reject reasons, history version)
//   * raw noisy float data + history float data, retained for inspection
//
// History ownership lives in the renderer's HistoryStore; this runner only
// borrows it through the normal frame path. Canceling never invalidates or
// disposes the chain — a canceled run returns its frames and leaves the
// history identity intact so a rerun can present the matching frame. Segment
// boundaries are pinned in a CheckpointStore with epoch/version/frame.
//
// No extra samples are taken for previews: all capture paths re-tonemap the
// existing float buffers, so the comparison cannot be "helped" by raising the
// per-frame sample count.

import { CheckpointStore } from '../temporal/checkpointStore.js';

export class JobRunner {
  constructor(renderer, plan, options = {}) {
    this.renderer = renderer;
    this.plan = plan;
    this.onFrame = options.onFrame || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.onSegment = options.onSegment || (() => {});
    this.checkpoints = options.checkpoints || new CheckpointStore();
    this.cancelled = false;
    this.frames = [];
    this.seams = [];
  }

  cancel() {
    this.cancelled = true;
  }

  async run() {
    const { renderer, plan } = this;
    const totalDelivered = plan.totalFrames;
    let delivered = 0;
    // A fresh job starts from an explicit, named empty chain. This is the
    // only invalidation the runner performs; cancellation below never clears.
    renderer.clearHistory();

    for (const seg of plan.segments) {
      if (this.cancelled) {
        renderer.releaseFrame();
        return { cancelled: true, frames: this.frames, checkpoints: this.checkpoints.listCheckpoints() };
      }

      this.onSegment({ type: 'start', segment: seg });

      if (seg.index > 0) {
        // Warm-up: replay the frames immediately preceding this segment
        // through the exact same temporal path. Their output is discarded but
        // history is rebuilt, so the first delivered frame has the same
        // history weight as a continuous run. The replay window is opened
        // explicitly so out-of-order frames never reuse stale history.
        renderer.beginReplay(`segment-${seg.index}-warmup`);
        for (let f = seg.warmupStart; f <= seg.warmupEnd; f++) {
          if (this.cancelled) {
            renderer.releaseFrame();
            return { cancelled: true, frames: this.frames, checkpoints: this.checkpoints.listCheckpoints() };
          }
          renderer.renderFrame(f);
          this.onSegment({ type: 'warmup', segment: seg, frame: f });
          await yieldToBrowser();
        }
        this.seams.push({
          frame: seg.start,
          warmupFrames: seg.warmup,
          warmupRange: [seg.warmupStart, seg.warmupEnd],
        });
      }

      for (let f = seg.start; f <= seg.end; f++) {
        if (this.cancelled) {
          renderer.releaseFrame();
          return { cancelled: true, frames: this.frames, checkpoints: this.checkpoints.listCheckpoints() };
        }
        const metrics = renderer.renderFrame(f, { resetHistory: false });
        const record = {
          frame: f,
          metrics,
          denoised: renderer.captureRGBA8('denoised'),
          noisy: renderer.captureRGBA8('noisy'),
          independent: renderer.captureRGBA8('independent'),
          adoption: renderer.captureRGBA8('adoption'),
          rawNoisyFloat: new Float32Array(renderer.captureFloatCurrent()),
          rawHistoryFloat: new Float32Array(renderer.captureFloatHistory()),
          width: renderer.width,
          height: renderer.height,
          segment: seg.index,
          historyVersion: metrics.historyVersion,
          historyEpoch: metrics.historyEpoch,
        };
        this.frames.push(record);
        this.onFrame(record);
        delivered++;
        this.onProgress({ delivered, total: totalDelivered, segment: seg.index });
        await yieldToBrowser();
      }
      // Pin the rebuilt chain at each segment boundary using its real frame
      // identity and history version; no default checkpoint is synthesized.
      const lastRecord = this.frames.filter((x) => x.segment === seg.index).at(-1);
      if (lastRecord) {
        this.checkpoints.saveCheckpoint({
          frame: lastRecord.frame,
          epoch: lastRecord.historyEpoch,
          version: lastRecord.historyVersion,
          reason: `segment-${seg.index}-done`,
          plan: { segment: seg.index, start: seg.start, end: seg.end },
        });
      }
      this.onSegment({ type: 'done', segment: seg, frames: this.frames.filter((x) => x.segment === seg.index) });
    }

    return {
      cancelled: false,
      frames: this.frames,
      seams: this.seams,
      checkpoints: this.checkpoints.listCheckpoints(),
      plan,
    };
  }
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Build a comparison summary across a job: temporal stability (mean abs
// frame-to-frame luma change) for denoised vs independent vs noisy, plus
// history acceptance statistics and seam deltas.
export function summarizeRun(result, width, height) {
  const frames = result.frames;
  if (!frames.length) return null;
  const stability = (key) => {
    let acc = 0;
    let n = 0;
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1][key];
      const b = frames[k][key];
      for (let i = 0; i < a.length; i += 4) {
        const ya = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
        const yb = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
        acc += Math.abs(ya - yb);
        n++;
      }
    }
    return n ? acc / n / 255 : 0;
  };
  const accepted = frames.reduce((s, f) => s + f.metrics.accepted, 0);
  const pixels = frames.reduce((s, f) => s + f.metrics.pixels, 0);
  const reasons = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let clamped = 0;
  for (const f of frames) {
    for (const k of Object.keys(reasons)) reasons[k] += f.metrics.reasons[k] || 0;
    clamped += f.metrics.clamped;
  }
  return {
    frameCount: frames.length,
    stability: {
      denoised: stability('denoised'),
      independent: stability('independent'),
      noisy: stability('noisy'),
    },
    acceptedPct: pixels ? (accepted / pixels) * 100 : 0,
    clampedPct: pixels ? (clamped / pixels) * 100 : 0,
    reasons,
    seams: result.seams || [],
  };
}
