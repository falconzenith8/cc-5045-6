// Equivalence helpers for execution-order changes.
//
// The history-ownership refactor must not change the denoising algorithm. To
// make that claim testable, this module compares two executions of the same
// frame range and bounds their difference with per-frame RMSE plus the history
// adoption metrics already produced by the temporal pass.
//
// Two executions are considered equivalent when every shared frame is within
// an explicit pixel tolerance (RGBA8 buffers are 0..255) and the adoption /
// history-weight deltas are within explicit metric tolerances. Missing frames
// or mismatched frame identities fail loudly rather than being skipped.

/** Per-channel RMSE between two equally sized RGBA buffers, scaled to 0..1. */
export function frameRmse(a, b) {
  if (!a || !b || a.length !== b.length) {
    throw new Error('frameRmse 需要两个等长缓冲');
  }
  let acc = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) / 255;
    acc += d * d;
    n++;
  }
  return Math.sqrt(acc / n);
}

/** Luma-only mean absolute difference, matching summarizeRun's stability metric. */
export function frameLumaMad(a, b) {
  if (!a || !b || a.length !== b.length) {
    throw new Error('frameLumaMad 需要两个等长缓冲');
  }
  let acc = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ya = (0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) / 255;
    const yb = (0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]) / 255;
    acc += Math.abs(ya - yb);
    n++;
  }
  return acc / n;
}

function indexByFrame(records, key) {
  const map = new Map();
  for (const rec of records) {
    if (map.has(rec.frame)) throw new Error(`帧 ${rec.frame} 在同一执行中重复`);
    map.set(rec.frame, rec);
  }
  return map;
}

/**
 * Compare two executions frame by frame.
 *
 * @param {Array<{frame:number, denoised:Uint8Array, metrics:object}>} reference
 *        continuous / pre-refactor execution
 * @param {Array} candidate reordered / canceled-and-rerun execution
 * @param {{pixelRmse?:number, lumaMad?:number, acceptedPct?:number,
 *          meanWeight?:number}} tolerances
 */
export function compareExecutions(reference, candidate, tolerances = {}) {
  const tol = {
    pixelRmse: tolerances.pixelRmse ?? 0.02,
    lumaMad: tolerances.lumaMad ?? 0.02,
    acceptedPct: tolerances.acceptedPct ?? 1.0,
    meanWeight: tolerances.meanWeight ?? 0.02,
  };
  const refMap = indexByFrame(reference, 'reference');
  const candMap = indexByFrame(candidate, 'candidate');
  const problems = [];
  const perFrame = [];

  for (const frame of [...refMap.keys()].sort((a, b) => a - b)) {
    const a = refMap.get(frame);
    const b = candMap.get(frame);
    if (!b) {
      problems.push(`帧 ${frame} 在重排执行中缺失`);
      continue;
    }
    const entry = {
      frame,
      rmse: a.denoised && b.denoised ? frameRmse(a.denoised, b.denoised) : null,
      lumaMad: a.denoised && b.denoised ? frameLumaMad(a.denoised, b.denoised) : null,
      acceptedDelta: Math.abs((a.metrics?.acceptedPct ?? 0) - (b.metrics?.acceptedPct ?? 0)),
      weightDelta: Math.abs(
        (a.metrics?.meanHistoryWeight ?? 0) - (b.metrics?.meanHistoryWeight ?? 0)),
    };
    perFrame.push(entry);
    if (entry.rmse !== null && entry.rmse > tol.pixelRmse) {
      problems.push(`帧 ${frame} 像素 RMSE ${entry.rmse.toFixed(4)} 超过 ${tol.pixelRmse}`);
    }
    if (entry.lumaMad !== null && entry.lumaMad > tol.lumaMad) {
      problems.push(`帧 ${frame} 亮度差 ${entry.lumaMad.toFixed(4)} 超过 ${tol.lumaMad}`);
    }
    if (entry.acceptedDelta > tol.acceptedPct) {
      problems.push(`帧 ${frame} 采纳率差 ${entry.acceptedDelta.toFixed(2)} 个百分点超过 ${tol.acceptedPct}`);
    }
    if (entry.weightDelta > tol.meanWeight) {
      problems.push(`帧 ${frame} 历史权重差 ${entry.weightDelta.toFixed(4)} 超过 ${tol.meanWeight}`);
    }
  }

  for (const frame of candMap.keys()) {
    if (!refMap.has(frame)) problems.push(`帧 ${frame} 不在参考执行中（身份无法对应）`);
  }

  const worst = perFrame.reduce((w, e) => (!w || e.rmse > w.rmse ? e : w), null);
  return {
    equivalent: problems.length === 0,
    tolerances: tol,
    frameCount: perFrame.length,
    worstFrame: worst ? worst.frame : null,
    maxRmse: worst ? worst.rmse : null,
    maxLumaMad: perFrame.reduce((m, e) => Math.max(m, e.lumaMad ?? 0), 0),
    maxAcceptedDelta: perFrame.reduce((m, e) => Math.max(m, e.acceptedDelta), 0),
    maxWeightDelta: perFrame.reduce((m, e) => Math.max(m, e.weightDelta), 0),
    perFrame,
    problems,
  };
}
