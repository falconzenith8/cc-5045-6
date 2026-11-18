// Temporal task scheduler.
//
// The unit of work is one rendered frame. A frame's temporal result depends on
// artifacts produced by the PREVIOUS frame in the same continuous run:
//
//   * historyColor  (rgba float, rgb = accumulated radiance, a = history weight)
//   * historyDepth  (rgba float, xyz = world normal, w = camera-forward depth)
//   * currentGbuffer (color, normal/depth, pixel motion vectors, object id)
//
// If a job is split into segments that are executed independently (different
// workers, different renderer instances, or resuming after a cancel), the first
// frame of a segment does NOT have those artifacts. Rendering it as an
// unrelated still image causes a visible periodic quality jump at every seam:
// the temporal weight restarts, so noise returns for several frames.
//
// The scheduler therefore requires every segment after the first to replay
// `warmup` frames immediately before its range. Warm-up frames are rendered
// through the exact same temporal path but are not emitted, which restores the
// history weight before the first delivered frame. `warmup` defaults to
// maxHistory - 1 so the weight reaches its cap.

export const HISTORY_ARTIFACTS = ['historyColor', 'historyDepth', 'gbuffer'];

function clampFrame(frame, scene) {
  return Math.max(0, Math.min(scene.frames - 1, frame));
}

/**
 * Build an execution plan.
 * @param {{frames:number}} scene
 * @param {{start?:number,end?:number,segmentSize?:number,warmup?:number,maxHistory?:number}} options
 */
export function planExecution(scene, options = {}) {
  const start = clampFrame(options.start ?? 0, scene);
  const end = clampFrame(options.end ?? scene.frames - 1, scene);
  if (end < start) throw new Error(`帧范围无效: start=${start} end=${end}`);
  const maxHistory = Math.max(1, options.maxHistory ?? 12);
  const segmentSize = Math.max(1, options.segmentSize ?? Math.ceil((end - start + 1) / 2));
  const warmup = options.warmup ?? Math.max(0, maxHistory - 1);

  const segments = [];
  let cursor = start;
  let index = 0;
  while (cursor <= end) {
    const segStart = cursor;
    const segEnd = Math.min(end, cursor + segmentSize - 1);
    const emitted = segEnd - segStart + 1;
    const isFirst = index === 0;
    // Warm-up frames are replayed from the preceding timeline, which may begin
    // before `start` because the scene itself exists there. Clamping warm-up
    // to the job start would shorten it and reintroduce a seam. The first
    // segment needs none because it begins with no history by construction.
    const warmupEnd = segStart - 1;
    const warmupStart = isFirst ? segStart : Math.max(0, segStart - warmup);
    segments.push({
      index,
      start: segStart,
      end: segEnd,
      emitted,
      warmup: isFirst ? 0 : Math.max(0, warmupEnd - warmupStart + 1),
      warmupStart: isFirst ? null : warmupStart,
      warmupEnd: isFirst ? null : warmupEnd,
      dependsOn: isFirst ? [] : [{ kind: 'segment', index: index - 1, reason: 'history 连续性（预热重放）' }],
      outputs: ['denoised', 'noisy', 'independent', 'adoption', 'metrics', 'historyColor', 'historyDepth'],
    });
    cursor = segEnd + 1;
    index++;
  }

  return {
    start,
    end,
    totalFrames: end - start + 1,
    segmentSize,
    warmup,
    maxHistory,
    segments,
    // Explicit dependency manifest for the panel and the CLI summary.
    artifacts: [
      {
        id: 'historyColor',
        format: 'RGBA32F',
        description: '上一帧累积辐射与历史权重（alpha）；本帧 alpha 混合使用',
        producer: 'temporal pass @ frame-1',
        consumers: ['temporal pass @ frame'],
      },
      {
        id: 'historyDepth',
        format: 'RGBA32F',
        description: '上一帧世界法线与视空间深度，用于重投影命中校验',
        producer: 'path trace pass @ frame-1, attachment 1',
        consumers: ['temporal pass @ frame', 'spatial pass @ frame'],
      },
      {
        id: 'gbuffer',
        format: 'RGBA32F x4',
        description: '本帧颜色 / 法线-深度 / 像素运动矢量 / 物体 id',
        producer: 'path trace pass @ frame',
        consumers: ['temporal pass @ frame', 'spatial pass @ frame', 'adoption viz'],
      },
      {
        id: 'pixelMotion',
        format: 'RGBA32F',
        description: '像素单位运动矢量（prevPixel - curPixel），遮挡解除时 history depth 校验失败',
        producer: 'path trace pass @ frame, attachment 2',
        consumers: ['temporal pass @ frame'],
      },
    ],
  };
}

/** Dependency list for a single frame inside a plan. */
export function dependsOnFrame(frame) {
  return {
    frame,
    needs: frame === 0 ? [] : ['historyColor@' + (frame - 1), 'historyDepth@' + (frame - 1)],
    produces: ['historyColor@' + frame, 'historyDepth@' + frame],
  };
}

/** Validate that a plan will not treat any segment start as a still image. */
export function validatePlan(plan, scene) {
  const problems = [];
  if (!plan.segments.length) problems.push('任务段为空');
  for (const seg of plan.segments) {
    if (seg.index > 0 && seg.warmup <= 0) {
      problems.push(`段 ${seg.index} 首帧缺少预热，会从零历史开始`);
    }
    if (seg.index > 0 && seg.warmupStart === null) {
      problems.push(`段 ${seg.index} 未声明预热来源`);
    }
    if (seg.end < seg.start) problems.push(`段 ${seg.index} 范围反转`);
    if (seg.end >= scene.frames) problems.push(`段 ${seg.index} 超出帧数`);
  }
  return { ok: problems.length === 0, problems };
}
