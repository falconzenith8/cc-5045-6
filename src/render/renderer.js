import {
  createProgram, getUniforms, FULLSCREEN_VS, createFullscreenVao,
  createRenderTarget, bindRenderTarget, readFloatPixels, readUint8Pixels,
  flipRowsToTopDown, destroyRenderTarget,
} from '../gl/gl.js';
import {
  PATHTRACE_FS, TEMPORAL_FS, SPATIAL_FS, ACCUMULATE_FS,
  DISPLAY_FS, ADOPTION_FS, COMPOSITE_FS,
} from './shaders.js';
import { perspective, lookAt, multiply, invert } from '../math/mat4.js';
import { packScene, jitterForFrame, cameraForFrame } from '../scene/scene.js';

const SCENE_UNIFORMS = [
  'uSphereCount', 'uBoxCount',
  'uSphBase', 'uSphMotionA', 'uSphMotionB', 'uSphAlbedo', 'uSphEmission',
  'uBoxBase', 'uBoxHalf', 'uBoxMotionA', 'uBoxMotionB', 'uBoxAlbedo', 'uBoxEmission',
  'uLightIndex', 'uTime', 'uPrevTime', 'uLightEmissionScale',
];
const PT_UNIFORMS = [...SCENE_UNIFORMS,
  'uResolution', 'uFrame', 'uSampleIndex', 'uJitter',
  'uCamPos', 'uCamForward', 'uCamRight', 'uCamUp', 'uTanHalfFov', 'uAspect',
  'uPrevCamPos', 'uPrevCamForward', 'uPrevCamRight', 'uPrevCamUp', 'uPrevTanHalfFov',
  'uPrevViewProj', 'uMotionScale',
];
const TEMP_UNIFORMS = [...SCENE_UNIFORMS,
  'uResolution', 'uCurrent', 'uNormalDepth', 'uMotion', 'uAux',
  'uPrevNormalDepth', 'uHistory', 'uMaxHistory', 'uDepthTolerance',
  'uNormalTolerance', 'uClampGamma', 'uTemporalEnabled', 'uHistoryBlend',
];
const SPATIAL_UNIFORMS = [...SCENE_UNIFORMS,
  'uResolution', 'uInput', 'uNormalDepth', 'uDepthSigma', 'uNormalPower', 'uStep', 'uPassIndex',
];
const ACC_UNIFORMS = [...SCENE_UNIFORMS, 'uResolution', 'uSample', 'uAccum', 'uSampleCount', 'uReset'];
const DISPLAY_UNIFORMS = ['uInput', 'uResolution', 'uExposure', 'uMode', 'uGain'];
const ADOPTION_UNIFORMS = ['uAdoption', 'uResolution'];
const COMPOSITE_UNIFORMS = ['uA', 'uB', 'uResolution', 'uMode', 'uSplit'];

export const DEFAULT_SETTINGS = {
  samplesPerFrame: 1,
  maxHistory: 12,
  depthTolerance: 0.035,
  normalTolerance: 0.85,
  clampGamma: 3.2,
  historyBlend: 1.0,
  temporalEnabled: true,
  spatialPasses: 1,
  spatialRadius: 1.0,
  exposure: 1.15,
};

export class DenoiseRenderer {
  constructor(canvas, scene) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WebGL2 不可用');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('缺少 EXT_color_buffer_float，无法创建浮点渲染目标');
    }
    this.gl = gl;
    this.canvas = canvas;
    this.scene = scene;
    this.width = scene.width;
    this.height = scene.height;
    this.settings = { ...DEFAULT_SETTINGS };
    canvas.width = this.width;
    canvas.height = this.height;

    this.vao = createFullscreenVao(gl);
    this.programs = {
      pathtrace: createProgram(gl, FULLSCREEN_VS, PATHTRACE_FS, 'pathtrace'),
      temporal: createProgram(gl, FULLSCREEN_VS, TEMPORAL_FS, 'temporal'),
      spatial: createProgram(gl, FULLSCREEN_VS, SPATIAL_FS, 'spatial'),
      accumulate: createProgram(gl, FULLSCREEN_VS, ACCUMULATE_FS, 'accumulate'),
      display: createProgram(gl, FULLSCREEN_VS, DISPLAY_FS, 'display'),
      adoption: createProgram(gl, FULLSCREEN_VS, ADOPTION_FS, 'adoption'),
      composite: createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite'),
    };
    this.u = {
      pathtrace: getUniforms(gl, this.programs.pathtrace, PT_UNIFORMS),
      temporal: getUniforms(gl, this.programs.temporal, TEMP_UNIFORMS),
      spatial: getUniforms(gl, this.programs.spatial, SPATIAL_UNIFORMS),
      accumulate: getUniforms(gl, this.programs.accumulate, ACC_UNIFORMS),
      display: getUniforms(gl, this.programs.display, DISPLAY_UNIFORMS),
      adoption: getUniforms(gl, this.programs.adoption, ADOPTION_UNIFORMS),
      composite: getUniforms(gl, this.programs.composite, COMPOSITE_UNIFORMS),
    };
    this.packed = packScene(scene);
    this.rtPathPrevDepth = null;
    this._initTargets();
    this._initCameras();
  }

  _initTargets() {
    const gl = this.gl;
    const { width, height } = this;
    this.rtSample = createRenderTarget(gl, width, height, { attachments: 4 });
    this.rtAccumColor = createRenderTarget(gl, width, height, { attachments: 1 });
    this.rtTemporal = createRenderTarget(gl, width, height, { attachments: 2 });
    this.rtHistory = [
      createRenderTarget(gl, width, height, { attachments: 1 }),
      createRenderTarget(gl, width, height, { attachments: 1 }),
    ];
    this.historyIndex = 0;
    this.historyValid = false;
    this.rtSpatial = [
      createRenderTarget(gl, width, height, { attachments: 1 }),
      createRenderTarget(gl, width, height, { attachments: 1 }),
    ];
    this.rtIndependent = createRenderTarget(gl, width, height, { attachments: 1 });
    this.rtDisplay = createRenderTarget(gl, width, height, {
      internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
    });
    this.rtDisplayB = createRenderTarget(gl, width, height, {
      internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
    });
    this.rtDisplayC = createRenderTarget(gl, width, height, {
      internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
    });
  }

  _initCameras() {
    this.cameras = [];
    const aspect = this.width / this.height;
    for (let f = 0; f < this.scene.frames; f++) {
      const c = cameraForFrame(this.scene, f);
      const proj = perspective(this.scene.fovY, aspect, this.scene.near, this.scene.far);
      const view = lookAt(c.eye, c.target, c.up);
      const viewProj = multiply(proj, view);
      const basis = cameraBasis(c);
      this.cameras.push({ ...c, ...basis, proj, view, viewProj });
    }
  }

  setScene(scene) {
    this.scene = scene;
    this.width = scene.width;
    this.height = scene.height;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.packed = packScene(scene);
    this._disposeTargets();
    this._initTargets();
    this._initCameras();
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
  }

  clearHistory() {
    this._clearAllHistory();
  }

  _drawFullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _setSceneUniforms(u, cam, prevCam) {
    const gl = this.gl;
    const p = this.packed;
    if (!u.uSphereCount) return;
    gl.uniform1i(u.uSphereCount, p.sphereCount);
    gl.uniform1i(u.uBoxCount, p.boxCount);
    gl.uniform4fv(u.uSphBase, p.sphBase);
    gl.uniform4fv(u.uSphMotionA, p.sphMotionA);
    gl.uniform4fv(u.uSphMotionB, p.sphMotionB);
    gl.uniform4fv(u.uSphAlbedo, p.sphAlbedo);
    gl.uniform4fv(u.uSphEmission, p.sphEmission);
    gl.uniform4fv(u.uBoxBase, p.boxBase);
    gl.uniform4fv(u.uBoxHalf, p.boxHalf);
    gl.uniform4fv(u.uBoxMotionA, p.boxMotionA);
    gl.uniform4fv(u.uBoxMotionB, p.boxMotionB);
    gl.uniform4fv(u.uBoxAlbedo, p.boxAlbedo);
    gl.uniform4fv(u.uBoxEmission, p.boxEmission);
    gl.uniform1i(u.uLightIndex, p.lightIndex);
    gl.uniform1f(u.uTime, cam.t);
    gl.uniform1f(u.uPrevTime, prevCam ? prevCam.t : cam.t);
    gl.uniform1f(u.uLightEmissionScale, 1.0);
  }

  _bindTex(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  _renderPathTrace(frame, sampleIndex, target) {
    const gl = this.gl;
    const cam = this.cameras[frame];
    const prevCam = this.cameras[Math.max(0, frame - 1)];
    const prog = this.programs.pathtrace;
    const u = this.u.pathtrace;

    bindRenderTarget(gl, target);
    gl.useProgram(prog);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this._setSceneUniforms(u, cam, prevCam);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1i(u.uFrame, frame);
    gl.uniform1i(u.uSampleIndex, sampleIndex);
    const jitter = jitterForFrame(frame * 7 + sampleIndex);
    gl.uniform2f(u.uJitter, jitter[0], jitter[1]);
    gl.uniform3fv(u.uCamPos, cam.eye);
    gl.uniform3fv(u.uCamForward, cam.forward);
    gl.uniform3fv(u.uCamRight, cam.right);
    gl.uniform3fv(u.uCamUp, cam.up);
    gl.uniform1f(u.uTanHalfFov, Math.tan(this.scene.fovY / 2));
    gl.uniform1f(u.uAspect, this.width / this.height);
    gl.uniform3fv(u.uPrevCamPos, prevCam.eye);
    gl.uniform3fv(u.uPrevCamForward, prevCam.forward);
    gl.uniform3fv(u.uPrevCamRight, prevCam.right);
    gl.uniform3fv(u.uPrevCamUp, prevCam.up);
    gl.uniform1f(u.uPrevTanHalfFov, Math.tan(this.scene.fovY / 2));
    gl.uniformMatrix4fv(u.uPrevViewProj, false, prevCam.viewProj);
    gl.uniform1f(u.uMotionScale, 1.0);
    this._drawFullscreen();
  }

  // Copy all four attachments of one 4-attachment target into another target
  // with the same attachment layout (used to snapshot G-buffers).
  _copyTarget(src, dst) {
    const gl = this.gl;
    for (let i = 0; i < Math.min(src.attachments, dst.attachments); i++) {
      bindRenderTarget(gl, dst);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0 + i]);
      gl.viewport(0, 0, dst.width, dst.height);
      gl.useProgram(this.programs.composite);
      const u = this.u.composite;
      this._bindTex(0, src.textures[i], u.uA);
      this._bindTex(1, src.textures[i], u.uB);
      gl.uniform2f(u.uResolution, this.width, this.height);
      gl.uniform1i(u.uMode, 1);
      this._drawFullscreen();
    }
    bindRenderTarget(gl, null);
  }

  // Copy one attachment (RGBA float) into attachment 0 of a 1-attachment
  // target, preserving alpha (needed for history weights).
  _copyInto(src, srcAttachment, dst) {
    const gl = this.gl;
    bindRenderTarget(gl, dst);
    gl.useProgram(this.programs.composite);
    const u = this.u.composite;
    this._bindTex(0, src.textures[srcAttachment], u.uA);
    this._bindTex(1, src.textures[srcAttachment], u.uB);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1i(u.uMode, 1);
    this._drawFullscreen();
  }

  // Write color (attachment 0 of colorSrc) into attachment 0 of a target that
  // has extra G-buffer attachments, leaving those attachments untouched.
  _copyColorInto(colorSrc, dst) {
    const gl = this.gl;
    bindRenderTarget(gl, dst);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.useProgram(this.programs.composite);
    const u = this.u.composite;
    this._bindTex(0, colorSrc.textures[0], u.uA);
    this._bindTex(1, colorSrc.textures[0], u.uB);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1i(u.uMode, 1);
    this._drawFullscreen();
    bindRenderTarget(gl, null);
  }

  _accumulate(sampleRt, accumSrcRt, outRt, sampleCount, reset) {
    const gl = this.gl;
    const prog = this.programs.accumulate;
    const u = this.u.accumulate;
    bindRenderTarget(gl, outRt);
    gl.useProgram(prog);
    this._bindTex(0, sampleRt.textures[0], u.uSample);
    this._bindTex(1, accumSrcRt.textures[0], u.uAccum);
    this._setSceneUniforms(u, this.cameras[0], null);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1f(u.uSampleCount, sampleCount);
    gl.uniform1f(u.uReset, reset ? 1 : 0);
    this._drawFullscreen();
  }

  _temporal(gbufferRt, prevHistoryRt, outRt, prevDepthTexn) {
    const gl = this.gl;
    const prog = this.programs.temporal;
    const u = this.u.temporal;
    const s = this.settings;
    const cam = this.cameras[0];
    bindRenderTarget(gl, outRt);
    gl.useProgram(prog);
    this._setSceneUniforms(u, cam, null);
    this._bindTex(0, gbufferRt.textures[0], u.uCurrent);
    this._bindTex(1, gbufferRt.textures[1], u.uNormalDepth);
    this._bindTex(2, gbufferRt.textures[2], u.uMotion);
    this._bindTex(3, gbufferRt.textures[3], u.uAux);
    this._bindTex(4, prevDepthTexn, u.uPrevNormalDepth);
    this._bindTex(5, prevHistoryRt.textures[0], u.uHistory);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1f(u.uMaxHistory, s.maxHistory);
    gl.uniform1f(u.uDepthTolerance, s.depthTolerance);
    gl.uniform1f(u.uNormalTolerance, s.normalTolerance);
    gl.uniform1f(u.uClampGamma, s.clampGamma);
    gl.uniform1f(u.uHistoryBlend, s.historyBlend);
    gl.uniform1i(u.uTemporalEnabled, s.temporalEnabled ? 1 : 0);
    this._drawFullscreen();
  }

  _spatial(inputRt, outRt) {
    const gl = this.gl;
    const prog = this.programs.spatial;
    const u = this.u.spatial;
    const s = this.settings;
    bindRenderTarget(gl, outRt);
    gl.useProgram(prog);
    this._setSceneUniforms(u, this.cameras[0], null);
    this._bindTex(0, inputRt.textures[0], u.uInput);
    this._bindTex(1, this.rtSample.textures[1], u.uNormalDepth);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1f(u.uDepthSigma, Math.max(0.01, s.depthTolerance * 2.0));
    gl.uniform1f(u.uNormalPower, 16.0);
    gl.uniform1f(u.uStep, s.spatialRadius);
    gl.uniform1i(u.uPassIndex, 0);
    this._drawFullscreen();
  }

  _clearAllHistory() {
    const gl = this.gl;
    for (const rt of this.rtHistory) {
      bindRenderTarget(gl, rt);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.historyValid = false;
    this.historyIndex = 0;
  }

  // Renders frame f with temporal accumulation. Caller is responsible for
  // calling frames in order or resetting history explicitly.
  renderFrame(frame, opts = {}) {
    const gl = this.gl;
    const s = this.settings;
    if (!this.rtPathPrevDepth) {
      this.rtPathPrevDepth = createRenderTarget(gl, this.width, this.height, { attachments: 1 });
      bindRenderTarget(gl, this.rtPathPrevDepth);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const reset = opts.resetHistory === true || !this.historyValid;
    if (opts.resetHistory === true) {
      this._clearAllHistory();
    }

    // --- 1. Path trace (real stochastic samples + subpixel jitter).
    const spp = Math.max(1, Math.round(s.samplesPerFrame));
    this._renderPathTrace(frame, 0, this.rtSample);
    if (spp > 1) {
      this._copyInto(this.rtSample, 0, this.rtAccumColor);
      for (let i = 1; i < spp; i++) {
        this._renderPathTrace(frame, i, this.rtSample);
        this._accumulate(this.rtSample, this.rtAccumColor, this.rtSpatial[0], i, false);
        this._copyInto(this.rtSpatial[0], 0, this.rtAccumColor);
      }
      this._copyColorInto(this.rtAccumColor, this.rtSample);
    }

    // --- 2. Temporal integration against reprojected history.
    const readIdx = this.historyIndex;
    const writeIdx = 1 - readIdx;
    // rtPathPrevDepth stores the previous frame's normal/depth attachment in
    // its (single) color attachment 0.
    const prevDepthTex = this.historyValid
      ? this.rtPathPrevDepth.textures[0]
      : this.rtSample.textures[1];
    this._temporal(this.rtSample, this.rtHistory[readIdx], this.rtTemporal, prevDepthTex);

    // --- 3. Current-frame only spatial result (independent comparison).
    this._spatial(this.rtSample, this.rtIndependent);

    // --- 4. Edge-aware spatial cleanup of the temporal result.
    this._copyInto(this.rtTemporal, 0, this.rtSpatial[0]);
    const passes = Math.max(1, s.spatialPasses);
    for (let p = 0; p < passes; p++) {
      this._spatial(this.rtSpatial[p % 2], this.rtSpatial[(p + 1) % 2]);
    }
    this._copyInto(this.rtSpatial[passes % 2], 0, this.rtHistory[writeIdx]);

    // --- 5. Keep G-buffer depth for next frame's disocclusion test.
    this._copyInto(this.rtSample, 1, this.rtPathPrevDepth);

    this.historyIndex = writeIdx;
    this.historyValid = true;

    return this._readAdoptionMetrics();
  }

  _readAdoptionMetrics() {
    const gl = this.gl;
    const { width, height } = this;
    const adoption = readFloatPixels(gl, this.rtTemporal, 1);
    let accepted = 0;
    let rejected = 0;
    const reasons = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let clamped = 0;
    let alphaSum = 0;
    const total = width * height;
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      alphaSum += adoption[o];
      const code = Math.round(adoption[o + 1] * 255);
      if (code === 6) accepted++;
      else if (reasons[code] !== undefined) reasons[code]++;
      if (adoption[o + 2] > 0.5) clamped++;
    }
    rejected = reasons[1] + reasons[2] + reasons[3] + reasons[4] + reasons[5];
    return {
      pixels: total,
      accepted,
      rejected,
      acceptedPct: total ? (accepted / total) * 100 : 0,
      rejectedPct: total ? (rejected / total) * 100 : 0,
      meanHistoryWeight: total ? alphaSum / total : 0,
      clamped,
      clampedPct: total ? (clamped / total) * 100 : 0,
      reasons,
    };
  }

  // Reason breakdown at a single pixel, using top-left pixel coordinates.
  sampleAdoption(x, y) {
    const gl = this.gl;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    bindRenderTarget(gl, this.rtTemporal);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + 1);
    const px = new Float32Array(4);
    gl.readPixels(x, this.height - 1 - y, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const code = Math.round(px[1] * 255);
    return {
      code,
      accepted: code === 6,
      clamped: px[2] > 0.5,
      alpha: px[0],
      weightBefore: px[3] * 32,
    };
  }

  _displayPass(srcRt, mode = 0, gain = 1, target = this.rtDisplay) {
    const gl = this.gl;
    bindRenderTarget(gl, target);
    gl.useProgram(this.programs.display);
    const u = this.u.display;
    this._bindTex(0, srcRt.textures[0], u.uInput);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1f(u.uExposure, this.settings.exposure);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1f(u.uGain, gain);
    this._drawFullscreen();
    return target;
  }

  _adoptionPass() {
    const gl = this.gl;
    bindRenderTarget(gl, this.rtDisplayB);
    gl.useProgram(this.programs.adoption);
    const u = this.u.adoption;
    this._bindTex(0, this.rtTemporal.textures[1], u.uAdoption);
    gl.uniform2f(u.uResolution, this.width, this.height);
    this._drawFullscreen();
    return this.rtDisplayB;
  }

  _motionPass() {
    if (!this._motionProgram) {
      const src = `#version 300 es
precision highp float;
uniform sampler2D uMotion;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 m = texture(uMotion, vUv);
  vec2 v = m.xy / 12.0;
  float depth = clamp(m.z / 18.0, 0.0, 1.0);
  float valid = m.w;
  vec3 c = vec3(clamp(0.5 + v.x * 0.5, 0.0, 1.0), clamp(0.5 + v.y * 0.5, 0.0, 1.0), depth);
  if (valid < 0.5) c *= 0.3;
  outColor = vec4(c, 1.0);
}`;
      this._motionProgram = createProgram(this.gl, FULLSCREEN_VS, src, 'motionviz');
      this._motionU = getUniforms(this.gl, this._motionProgram, ['uMotion', 'uResolution']);
    }
    const gl = this.gl;
    bindRenderTarget(gl, this.rtDisplayC);
    gl.useProgram(this._motionProgram);
    this._bindTex(0, this.rtSample.textures[2], this._motionU.uMotion);
    gl.uniform2f(this._motionU.uResolution, this.width, this.height);
    this._drawFullscreen();
    return this.rtDisplayC;
  }

  _diffPass() {
    if (!this._diffProgram) {
      const src = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 a = texture(uA, vUv).rgb;
  vec3 b = texture(uB, vUv).rgb;
  vec3 d = clamp(abs(a - b) * 6.0, 0.0, 1.0);
  outColor = vec4(pow(d, vec3(1.0 / 2.2)), 1.0);
}`;
      this._diffProgram = createProgram(this.gl, FULLSCREEN_VS, src, 'diffviz');
      this._diffU = getUniforms(this.gl, this._diffProgram, ['uA', 'uB', 'uResolution']);
    }
    const gl = this.gl;
    bindRenderTarget(gl, this.rtDisplayC);
    gl.useProgram(this._diffProgram);
    this._bindTex(0, this.rtHistory[this.historyIndex].textures[0], this._diffU.uA);
    this._bindTex(1, this.rtIndependent.textures[0], this._diffU.uB);
    gl.uniform2f(this._diffU.uResolution, this.width, this.height);
    this._drawFullscreen();
    return this.rtDisplayC;
  }

  _compositePass(a, b, mode, split, out) {
    const gl = this.gl;
    bindRenderTarget(gl, out);
    gl.useProgram(this.programs.composite);
    const u = this.u.composite;
    this._bindTex(0, a.textures[0], u.uA);
    this._bindTex(1, b.textures[0], u.uB);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1f(u.uSplit, split);
    this._drawFullscreen();
  }

  present(present = {}) {
    const gl = this.gl;
    const mode = present.mode || 'denoised';
    let src = null;

    if (mode === 'denoised') src = this._displayPass(this.rtHistory[this.historyIndex], 0, 1, this.rtDisplay);
    else if (mode === 'noisy') src = this._displayPass(this.rtSample, 0, 1, this.rtDisplay);
    else if (mode === 'independent') src = this._displayPass(this.rtIndependent, 0, 1, this.rtDisplay);
    else if (mode === 'adoption') src = this._adoptionPass();
    else if (mode === 'motion') src = this._motionPass();
    else if (mode === 'diff') src = this._diffPass();
    else if (mode === 'split') {
      this._displayPass(this.rtIndependent, 0, 1, this.rtDisplay);
      this._displayPass(this.rtHistory[this.historyIndex], 0, 1, this.rtDisplayC);
      this._compositePass(this.rtDisplay, this.rtDisplayC, 4, present.split ?? 0.5, this.rtDisplayB);
      src = this.rtDisplayB;
    } else if (mode === 'reference') {
      src = this._displayPass(this.rtReference || this.rtHistory[this.historyIndex], 0, 1, this.rtDisplay);
    } else {
      src = this._displayPass(this.rtSample, 0, 1, this.rtDisplay);
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, src.width, src.height, 0, 0, this.width, this.height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return src;
  }

  captureRGBA8(mode = 'denoised') {
    const gl = this.gl;
    let rt;
    if (mode === 'noisy') rt = this._displayPass(this.rtSample, 0, 1, this.rtDisplay);
    else if (mode === 'independent') rt = this._displayPass(this.rtIndependent, 0, 1, this.rtDisplay);
    else if (mode === 'adoption') rt = this._adoptionPass();
    else rt = this._displayPass(this.rtHistory[this.historyIndex], 0, 1, this.rtDisplay);
    const px = readUint8Pixels(gl, rt);
    return flipRowsToTopDown(px, this.width, this.height);
  }

  captureFloatHistory() {
    const gl = this.gl;
    return readFloatPixels(gl, this.rtHistory[this.historyIndex], 0);
  }

  captureFloatCurrent() {
    const gl = this.gl;
    return readFloatPixels(gl, this.rtSample, 0);
  }

  captureFloatIndependent() {
    const gl = this.gl;
    return readFloatPixels(gl, this.rtIndependent, 0);
  }

  _disposeTargets() {
    const gl = this.gl;
    for (const rt of [this.rtSample, this.rtAccumColor, this.rtTemporal, this.rtHistory[0],
      this.rtHistory[1], this.rtSpatial[0], this.rtSpatial[1], this.rtIndependent,
      this.rtDisplay, this.rtDisplayB, this.rtDisplayC]) {
      destroyRenderTarget(gl, rt);
    }
    if (this.rtPathPrevDepth) {
      destroyRenderTarget(gl, this.rtPathPrevDepth);
      this.rtPathPrevDepth = null;
    }
  }

  dispose() {
    this._disposeTargets();
  }
}

export function cameraBasis(cam) {
  const f = [cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2]];
  const fl = Math.hypot(...f);
  const forward = [f[0] / fl, f[1] / fl, f[2] / fl];
  const r = [
    forward[1] * cam.up[2] - forward[2] * cam.up[1],
    forward[2] * cam.up[0] - forward[0] * cam.up[2],
    forward[0] * cam.up[1] - forward[1] * cam.up[0],
  ];
  const rl = Math.hypot(...r);
  const right = [r[0] / rl, r[1] / rl, r[2] / rl];
  const upv = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { forward, right, up: upv };
}
