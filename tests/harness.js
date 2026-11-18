import { DenoiseRenderer, DEFAULT_SETTINGS } from '../src/render/renderer.js';
import { SCENES } from '../src/scene/scene.js';

const canvas = document.getElementById('c');
let renderer = null;

window.__harness = {
  init(sceneId = 'moving-camera', settings = {}) {
    if (renderer) renderer.dispose();
    renderer = new DenoiseRenderer(canvas, SCENES[sceneId]);
    renderer.setSettings({ ...DEFAULT_SETTINGS, ...settings });
    return { width: canvas.width, height: canvas.height, frames: renderer.scene.frames };
  },
  renderFrames(start, end, opts = {}) {
    const out = [];
    for (let f = start; f <= end; f++) {
      // Legacy harness may replay arbitrary frame ranges; out-of-order frames
      // explicitly restart the chain (allowRestart) and report an anomaly
      // instead of silently attaching stale history.
      const m = renderer.renderFrame(f, { ...opts, allowRestart: opts.allowRestart ?? true });
      out.push({ frame: f, ...m });
    }
    return out;
  },
  renderOne(frame, opts = {}) {
    return renderer.renderFrame(frame, { ...opts, allowRestart: opts.allowRestart ?? true });
  },
  clearHistory() { renderer.clearHistory(); },
  beginReplay(reason) { return renderer.beginReplay(reason); },
  historyState() { return renderer.historyState(); },
  settings(patch) { renderer.setSettings(patch); },
  present(mode) { renderer.present({ mode }); },
  adoptionAt(x, y) { return renderer.sampleAdoption(x, y); },
  // Motion vector statistics: luminance-weighted verification that static
  // backgrounds report camera-induced motion while moving objects report their
  // own screen-space displacement.
  motionAt(x, y) {
    const px = renderer.captureFloatPixelsRaw
      ? renderer.captureFloatPixelsRaw(2)
      : null;
    return px;
  },
  capture(mode) {
    const d = renderer.captureRGBA8(mode);
    return { width: renderer.width, height: renderer.height, data: Array.from(d) };
  },
  stats(mode) {
    const d = renderer.captureRGBA8(mode);
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      sum += y; sum2 += y * y; n++;
    }
    const mean = sum / n;
    return { mean, variance: sum2 / n - mean * mean, n };
  },
  diffStats(modeA, modeB) {
    const a = renderer.captureRGBA8(modeA);
    const b = renderer.captureRGBA8(modeB);
    let acc = 0;
    for (let i = 0; i < a.length; i += 4) {
      const ya = (0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) / 255;
      const yb = (0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]) / 255;
      acc += (ya - yb) * (ya - yb);
    }
    return Math.sqrt(acc / (a.length / 4));
  },
  readMotionBuffer() {
    const rt = renderer.rtSample;
    const gl = renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + 2);
    const out = new Float32Array(rt.width * rt.height * 4);
    gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.FLOAT, out);
    return { width: rt.width, height: rt.height, data: Array.from(out) };
  },
  readDepthBuffer() {
    const rt = renderer.rtSample;
    const gl = renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + 1);
    const out = new Float32Array(rt.width * rt.height * 4);
    gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.FLOAT, out);
    return { width: rt.width, height: rt.height, data: Array.from(out) };
  },
  readAuxBuffer() {
    const rt = renderer.rtSample;
    const gl = renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + 3);
    const out = new Float32Array(rt.width * rt.height * 4);
    gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.FLOAT, out);
    return { width: rt.width, height: rt.height, data: Array.from(out) };
  },
  readPrevDepthBuffer() {
    const rt = renderer.rtPathPrevDepth;
    const gl = renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const out = new Float32Array(rt.width * rt.height * 4);
    gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.FLOAT, out);
    return { width: rt.width, height: rt.height, data: Array.from(out) };
  },
  floatHistory() {
    return { data: Array.from(renderer.captureFloatHistory()) };
  },
  glError() { return renderer.gl.getError(); },
};

window.__harness.debugCompose = function() {
  const gl = renderer.gl;
  const vs = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
  const fs = `#version 300 es
precision highp float;
uniform sampler2D uMotion, uPrev, uCur;
uniform vec2 uResolution;
in vec2 vUv; out vec4 outColor;
void main(){
  vec4 mv = texture(uMotion, vUv);
  vec2 prevUv = (gl_FragCoord.xy + mv.xy) / uResolution;
  vec4 pv = texture(uPrev, prevUv);
  vec4 cv = texture(uCur, vUv);
  outColor = vec4(mv.z, pv.z, cv.z, mv.w);
}`;
  const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
  const prog = gl.createProgram();
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: '+gl.getProgramInfoLog(prog));
  gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.rtSpatial[0].framebuffer);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.viewport(0,0,renderer.width,renderer.height);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, renderer.rtSample.textures[2]); gl.uniform1i(gl.getUniformLocation(prog,'uMotion'),0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, renderer.rtPathPrevDepth.textures[0]); gl.uniform1i(gl.getUniformLocation(prog,'uPrev'),1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, renderer.rtSample.textures[1]); gl.uniform1i(gl.getUniformLocation(prog,'uCur'),2);
  gl.uniform2f(gl.getUniformLocation(prog,'uResolution'), renderer.width, renderer.height);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  const out = new Float32Array(renderer.width*renderer.height*4);
  gl.readPixels(0,0,renderer.width,renderer.height,gl.RGBA,gl.FLOAT,out);
  return { width: renderer.width, height: renderer.height, data: Array.from(out) };
};

window.__harness.probeSampler = function(attachment, unitCount) {
  const gl = renderer.gl;
  const vs = `#version 300 es
precision highp float; out vec2 vUv;
void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
  let fs;
  if (unitCount === 1) {
    fs = `#version 300 es
precision highp float; uniform sampler2D uT; uniform vec2 uResolution; in vec2 vUv; out vec4 outColor;
void main(){ outColor = texture(uT, vUv); }`;
  } else {
    fs = `#version 300 es
precision highp float; uniform sampler2D uA; uniform sampler2D uB; uniform vec2 uResolution; in vec2 vUv; out vec4 outColor;
void main(){ outColor = texture(uA, vUv) + texture(uB, vUv) * 0.0; }`;
  }
  const mk=(t,s)=>{const sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(sh));return sh;};
  const prog=gl.createProgram(); gl.attachShader(prog,mk(gl.VERTEX_SHADER,vs)); gl.attachShader(prog,mk(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error('link '+gl.getProgramInfoLog(prog));
  gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.rtSpatial[0].framebuffer);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]); gl.viewport(0,0,renderer.width,renderer.height);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, renderer.rtSample.textures[attachment]); gl.uniform1i(gl.getUniformLocation(prog,'uT')||gl.getUniformLocation(prog,'uA'),0);
  if (unitCount>1) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, renderer.rtSample.textures[0]); gl.uniform1i(gl.getUniformLocation(prog,'uB'),5); }
  gl.uniform2f(gl.getUniformLocation(prog,'uResolution'), renderer.width, renderer.height);
  const vao=gl.createVertexArray(); gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES,0,3); gl.bindVertexArray(null);
  const out=new Float32Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,out);
  return { out: Array.from(out), err: gl.getError(), loc: [gl.getUniformLocation(prog,'uT'), gl.getUniformLocation(prog,'uA'), gl.getUniformLocation(prog,'uB')] };
};

window.__harness.historyAt = function(x, y) {
  const rt = renderer.rtHistory[renderer.historyIndex];
  const gl = renderer.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  const px = new Float32Array(4);
  gl.readPixels(x, renderer.height - 1 - y, 1, 1, gl.RGBA, gl.FLOAT, px);
  return Array.from(px);
};
window.__harness.rtAlphaAt = function(rtName, att, x, y) {
  const rt = renderer[rtName];
  const gl = renderer.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + (att||0));
  const px = new Float32Array(4);
  gl.readPixels(x, renderer.height - 1 - y, 1, 1, gl.RGBA, gl.FLOAT, px);
  return Array.from(px);
};
window.__harness.motionHistogram = function() {
  const rt = renderer.rtSample;
  const gl = renderer.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + 2);
  const out = new Float32Array(rt.width*rt.height*4);
  gl.readPixels(0,0,rt.width,rt.height,gl.RGBA,gl.FLOAT,out);
  const W=rt.width,H=rt.height;
  const buckets = {invalid:0, offscreen:0, ok:0, far:0};
  const edge = {left:0,right:0,top:0,bottom:0};
  let maxMv = 0;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const i=(y*W+x)*4;
    // Sky pixels have no hit; emitters are hit surfaces. Check aux id == 0.
    if (out[i+3] < 0.5) {
      buckets.invalid++;
      const px = x + out[i], py = y + out[i+1];
      if (px < 0) edge.left++; else if (px > W) edge.right++; else if (py < 0) edge.bottom++; else if (py > H) edge.top++;
      continue;
    }
    maxMv = Math.max(maxMv, Math.hypot(out[i], out[i+1]));
    if (out[i+2] > 30) buckets.far++; else buckets.ok++;
  }
  return {buckets, edge, maxMv};
};
window.__harness.temporalStability = function(frames, mode) {
  // Returns mean absolute per-pixel frame-to-frame change over a list of
  // frames. Lower is more stable. Uses RGBA8 display output for the mode.
  const W = renderer.width, H = renderer.height;
  const captured = frames.map((f) => {
    renderer.renderFrame(f, { resetHistory: f === frames[0] && mode === 'independent' });
    return renderer.captureRGBA8(mode);
  });
  let acc = 0, n = 0;
  for (let k = 1; k < captured.length; k++) {
    const a = captured[k-1], b = captured[k];
    for (let i = 0; i < a.length; i += 4) {
      const ya = (0.2126*a[i] + 0.7152*a[i+1] + 0.0722*a[i+2]) / 255;
      const yb = (0.2126*b[i] + 0.7152*b[i+1] + 0.0722*b[i+2]) / 255;
      acc += Math.abs(ya - yb); n++;
    }
  }
  return acc / n;
};
window.__harness.resetForSeries = function(reset) { renderer.clearHistory(); };
// Cancel/reorder probe for the history-ownership refactor.
//
// Renders the prefix [0..cancelAt], then simulates a cancel: the task stops
// without invalidating history. The rerun opens an explicit replay window and
// rebuilds the predecessor chain before delivering [resumeFrom..end]. Returns
// per-frame RGBA8 captures plus the history version/epoch stamped on each
// frame, so the host side can diff against a continuous run.
window.__harness.cancelResumeRun = function(resumeFrom, end, cancelAt) {
  renderer.clearHistory();
  for (let f = 0; f <= cancelAt; f++) renderer.renderFrame(f);
  const retained = renderer.historyState();
  // Cancel must not destroy shared state; rerun rebuilds by frame identity.
  renderer.beginReplay('cancel-resume-replay');
  const replayStart = Math.max(0, resumeFrom - 11);
  for (let f = replayStart; f < resumeFrom; f++) renderer.renderFrame(f);
  const frames = [];
  for (let f = resumeFrom; f <= end; f++) {
    const metrics = renderer.renderFrame(f);
    frames.push({
      frame: f,
      denoised: Array.from(renderer.captureRGBA8('denoised')),
      metrics: {
        acceptedPct: metrics.acceptedPct,
        meanHistoryWeight: metrics.meanHistoryWeight,
      },
      historyVersion: metrics.historyVersion,
      historyEpoch: metrics.historyEpoch,
    });
  }
  return { retained, frames, replayRange: [replayStart, resumeFrom - 1] };
};
// Continuous reference for the same delivered range, with full history.
window.__harness.continuousRun = function(start, end) {
  renderer.clearHistory();
  for (let f = 0; f < start; f++) renderer.renderFrame(f);
  const frames = [];
  for (let f = start; f <= end; f++) {
    const metrics = renderer.renderFrame(f);
    frames.push({
      frame: f,
      denoised: Array.from(renderer.captureRGBA8('denoised')),
      metrics: {
        acceptedPct: metrics.acceptedPct,
        meanHistoryWeight: metrics.meanHistoryWeight,
      },
      historyVersion: metrics.historyVersion,
      historyEpoch: metrics.historyEpoch,
    });
  }
  return { frames };
};
// Missing-history probe: clear mid-chain, then the next frame must report the
// reason-1 fallback (0% acceptance) and a new epoch while storage survives.
window.__harness.missingHistoryProbe = function(framesBefore, nextFrame) {
  renderer.clearHistory();
  for (let f = 0; f < framesBefore; f++) renderer.renderFrame(f);
  const before = renderer.historyState();
  renderer.clearHistory();
  const afterClear = renderer.historyState();
  const metrics = renderer.renderFrame(nextFrame);
  const after = renderer.historyState();
  return {
    before,
    afterClear,
    after,
    nextAcceptedPct: metrics.acceptedPct,
    nextReason1: metrics.reasons[1],
    storageSurvived: renderer.rtHistory.length === 2 && !!renderer.rtPathPrevDepth,
  };
};
window.__harness.staticRegionStability = function(frames, mode) {
  // Stability over pixels whose surface is static in the current run.
  const cap = [];
  for (const f of frames) {
    renderer.renderFrame(f, { resetHistory: f === frames[0] && mode === 'independent' });
    cap.push({ img: renderer.captureRGBA8(mode), aux: window.__harness.readAuxBuffer() });
  }
  let acc = 0, n = 0;
  for (let k = 1; k < cap.length; k++) {
    const a = cap[k-1].img, b = cap[k].img;
    const auxA = cap[k-1].aux.data, auxB = cap[k].aux.data;
    for (let p = 0, i = 0; i < a.length; i += 4, p += 4) {
      // Static object ids: wall=101, ground=102, static spheres/boxes.
      const staticIds = new Set([101,102,4,5,103,105,106]);
      if (!staticIds.has(Math.round(auxA[p])) || Math.round(auxA[p]) !== Math.round(auxB[p])) continue;
      const ya = (0.2126*a[i] + 0.7152*a[i+1] + 0.0722*a[i+2]) / 255;
      const yb = (0.2126*b[i] + 0.7152*b[i+1] + 0.0722*b[i+2]) / 255;
      acc += Math.abs(ya - yb); n++;
    }
  }
  return n ? acc / n : 0;
};
window.__harness.renderRangeResetOnce = function(start, end, resetAtStart) {
  const out = [];
  if (resetAtStart) renderer.clearHistory();
  // Legacy entry: a false resetAtStart still may replay an older range (warm-up
  // after a prior run). Open an explicit replay window when the first frame is
  // not the stored successor, so frame identity is named rather than violated.
  const state = renderer.historyState();
  if (!resetAtStart && state.valid && start !== state.lastFrame + 1) {
    renderer.beginReplay(`legacy-renderRange@${start}`);
  }
  for (let f = start; f <= end; f++) out.push({ frame: f, ...renderer.renderFrame(f) });
  return out;
};
// Residual noise estimate: mean local high-frequency energy after a 5x5 box
// blur subtraction. Averaged over the denominator so flat regions do not
// dominate. Returns one number per output mode for the current frame.
window.__harness.noiseStats = function(_frame) {
  const W = renderer.width, H = renderer.height;
  function measure(mode) {
    const img = renderer.captureRGBA8(mode);
    const lum = new Float32Array(W * H);
    for (let i = 0; i < lum.length; i++) {
      lum[i] = (0.2126 * img[i*4] + 0.7152 * img[i*4+1] + 0.0722 * img[i*4+2]) / 255;
    }
    let acc = 0, n = 0;
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        let mean = 0;
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) mean += lum[(y+j)*W + (x+i)];
        mean /= 25;
        const d = lum[y*W + x] - mean;
        acc += d * d; n++;
      }
    }
    return acc / n;
  }
  return { temporal: measure('denoised'), independent: measure('independent'), noisy: measure('noisy') };
};
window.__harness.dumpPngBase64 = function(mode) {
  const d = renderer.captureRGBA8(mode);
  const c = document.createElement('canvas'); c.width = renderer.width; c.height = renderer.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(d), c.width, c.height), 0, 0);
  return c.toDataURL('image/png').split(',')[1];
};
// Ghosting probe: renders high-sample reference frames from a completely
// fresh history (independent of the temporal run) and compares the temporal
// result to the reference at the same frame versus the previous frame.
// If history smearing were occurring, the temporal result would correlate
// better with the previous reference frame.
window.__harness.ghostProbe = function(sceneId, frame, refSpp = 24) {
  const ref = new DenoiseRenderer(document.createElement('canvas'), SCENES[sceneId]);
  ref.setSettings({ samplesPerFrame: refSpp, maxHistory: 1, temporalEnabled: false, spatialPasses: 1 });
  function refAt(f) {
    ref.clearHistory();
    ref.renderFrame(f, { resetHistory: true });
    return ref.captureRGBA8('independent');
  }
  const refPrev = refAt(Math.max(0, frame - 1));
  const refCur = refAt(frame);
  ref.dispose();

  const cur = renderer.captureRGBA8('denoised');
  const ind = renderer.captureRGBA8('independent');
  const noisy = renderer.captureRGBA8('noisy');
  const W = renderer.width, H = renderer.height;

  function rmse(a, b) {
    let acc = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const d = (a[i+k] - b[i+k]) / 255;
        acc += d * d; n++;
      }
    }
    return Math.sqrt(acc / n);
  }
  // Motion-discriminative error: only pixels where the reference changed
  // noticeably between frames. A stale-history smear would show up here.
  function maskedRmse(a, refCur, refPrev) {
    let acc = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const dc = Math.abs(refCur[i] - refPrev[i]) + Math.abs(refCur[i+1] - refPrev[i+1]) + Math.abs(refCur[i+2] - refPrev[i+2]);
      if (dc < 36) continue;
      for (let k = 0; k < 3; k++) {
        const d = (a[i+k] - refCur[i+k]) / 255;
        acc += d * d; n++;
      }
    }
    return n ? { rmse: Math.sqrt(acc / n), pixels: n } : { rmse: 0, pixels: 0 };
  }
  const maskedCur = maskedRmse(cur, refCur, refPrev);
  const maskedInd = maskedRmse(ind, refCur, refPrev);
  let changedPixels = 0;
  for (let i = 0; i < refCur.length; i += 4) {
    const dc = Math.abs(refCur[i] - refPrev[i]) + Math.abs(refCur[i+1] - refPrev[i+1]) + Math.abs(refCur[i+2] - refPrev[i+2]);
    if (dc >= 36) changedPixels++;
  }
  return {
    temporalVsCur: rmse(cur, refCur),
    temporalVsPrev: rmse(cur, refPrev),
    independentVsCur: rmse(ind, refCur),
    noisyVsCur: rmse(noisy, refCur),
    maskedTemporal: maskedCur.rmse,
    maskedIndependent: maskedInd.rmse,
    changedPixels,
  };
};
window.__harnessReady = true;
