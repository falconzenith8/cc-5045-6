import { zipSync } from 'fflate';

export function framesToCanvas(frames, key, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  return { canvas, ctx };
}

// Encode an array of RGBA8 frame buffers to WebM (VP9) via MediaRecorder.
// Real-time pacing is required for MediaRecorder to timestamp frames; the
// sequence is written at `fps`.
export async function encodeWebM(records, key, fps, width, height, onProgress = () => {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mimeCandidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const mimeType = mimeCandidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || 'video/webm';
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { recorder.onstop = resolve; });

  recorder.start();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const img = new ImageData(new Uint8ClampedArray(rec[key].buffer.slice(0)), width, height);
    ctx.putImageData(img, 0, 0);
    if (track.requestFrame) track.requestFrame();
    else stream.getVideoTracks()[0].requestFrame?.();
    onProgress({ encoded: i + 1, total: records.length });
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  // Give the last frame time to be captured.
  await new Promise((r) => setTimeout(r, 250));
  recorder.stop();
  await done;
  for (const t of stream.getTracks()) t.stop();
  return new Blob(chunks, { type: mimeType });
}

// Build a review archive: every raw noisy frame as PNG plus a manifest of
// per-frame denoising metrics. This lets a reviewer confirm that the denoised
// sequence was derived from these exact noisy frames.
export async function buildReviewZip(records, meta, width, height) {
  const files = {};
  const manifest = {
    ...meta,
    width,
    height,
    note: 'noisy/ 下为未经时序降噪的逐帧原始噪声帧（RGBA8, 已应用仅曝光与色调映射）；metrics 为实际降噪运算记录。',
    frames: [],
  };
  for (const rec of records) {
    const name = `noisy/frame_${String(rec.frame).padStart(4, '0')}.png`;
    files[name] = await rgbaToPng(rec.noisy, width, height);
    manifest.frames.push({
      frame: rec.frame,
      segment: rec.segment,
      acceptedPct: +rec.metrics.acceptedPct.toFixed(2),
      rejectedPct: +rec.metrics.rejectedPct.toFixed(2),
      meanHistoryWeight: +rec.metrics.meanHistoryWeight.toFixed(4),
      reasons: rec.metrics.reasons,
      clampedPct: +rec.metrics.clampedPct.toFixed(2),
    });
  }
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
}

export async function rgbaToPng(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(rgba), width, height);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
