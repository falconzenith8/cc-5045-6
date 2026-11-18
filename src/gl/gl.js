export function createShader(gl, type, source, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败 (${label}): ${log}`);
  }
  return sh;
}

export function createProgram(gl, vsSource, fsSource, label = 'program') {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource, `${label}.vert`);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource, `${label}.frag`);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || '';
    gl.deleteProgram(prog);
    throw new Error(`着色器链接失败 (${label}): ${log}`);
  }
  return prog;
}

export function getUniforms(gl, prog, names) {
  const out = {};
  for (const name of names) out[name] = gl.getUniformLocation(prog, name);
  return out;
}

export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export function createFullscreenVao(gl) {
  return gl.createVertexArray();
}

export function createTexture(gl, width, height, opts = {}) {
  const {
    internalFormat = gl.RGBA32F,
    format = gl.RGBA,
    type = gl.FLOAT,
    minFilter = gl.NEAREST,
    magFilter = gl.NEAREST,
    wrap = gl.CLAMP_TO_EDGE,
  } = opts;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (type) {
    // texStorage2D fixes the format; nothing else to allocate.
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export function createRenderTarget(gl, width, height, opts = {}) {
  const {
    attachments = 1,
    internalFormat = gl.RGBA32F,
    format = gl.RGBA,
    type = gl.FLOAT,
    minFilter = gl.NEAREST,
    magFilter = gl.NEAREST,
    depth = false,
  } = opts;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const textures = [];
  const drawBuffers = [];
  for (let i = 0; i < attachments; i++) {
    const tex = createTexture(gl, width, height, { internalFormat, format, type, minFilter, magFilter });
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    textures.push(tex);
    drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
  }
  if (depth) {
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }
  gl.drawBuffers(drawBuffers);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error(`帧缓冲不完整: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer: fb, textures, width, height, attachments };
}

export function bindRenderTarget(gl, rt) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.framebuffer : null);
  if (rt) {
    gl.viewport(0, 0, rt.width, rt.height);
    const buffers = [];
    for (let i = 0; i < rt.attachments; i++) buffers.push(gl.COLOR_ATTACHMENT0 + i);
    gl.drawBuffers(buffers);
  }
}

export function readFloatPixels(gl, rt, attachment = 0) {
  while (gl.getError() !== gl.NO_ERROR) { /* drain stale errors */ }
  bindRenderTarget(gl, rt);
  const out = new Float32Array(rt.width * rt.height * 4);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
  gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.FLOAT, out);
  const err = gl.getError();
  if (err !== gl.NO_ERROR) throw new Error(`读取浮点像素失败: 0x${err.toString(16)}`);
  return out;
}

export function readUint8Pixels(gl, rt) {
  bindRenderTarget(gl, rt);
  const out = new Uint8Array(rt.width * rt.height * 4);
  gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  const err = gl.getError();
  if (err !== gl.NO_ERROR) throw new Error(`读取像素失败: 0x${err.toString(16)}`);
  return out;
}

// WebGL rows are bottom-up; ImageData rows are top-down.
export function flipRowsToTopDown(src, width, height) {
  const out = new Uint8ClampedArray(src.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const srcOff = y * stride;
    const dstOff = (height - 1 - y) * stride;
    out.set(src.subarray(srcOff, srcOff + stride), dstOff);
  }
  return out;
}

export function destroyRenderTarget(gl, rt) {
  if (!rt) return;
  for (const t of rt.textures) gl.deleteTexture(t);
  gl.deleteFramebuffer(rt.framebuffer);
}
