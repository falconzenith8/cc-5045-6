// Ownership of GPU history artifacts for the temporal denoiser.
//
// Before this module existed the DenoiseRenderer mixed three responsibilities in
// one class: frame scheduling decisions, the denoising passes, and ownership of
// the double-buffered history textures plus the previous-frame depth target.
// HistoryStore takes the third responsibility behind an explicit acquire /
// commit / release protocol so that callers can see exactly when history is
// borrowed and when it is safe to reuse.
//
// Ownership rules:
//
//   * The store owns the render targets. Renderers borrow them through
//     acquire() and must hand them back with release(); canceling a task never
//     calls dispose(), so shared history state survives a canceled run.
//   * Every borrow names the frame it intends to render. A rerun after a cancel
//     or a segment boundary must present the matching predecessor frame
//     (frame - 1); a mismatch raises FrameIdentityError instead of silently
//     attaching stale history to an unrelated frame.
//   * Each committed frame gets a monotonic history version. Invalidation
//     (clearHistory / scene change / failed run) opens a new epoch so that an
//     old checkpoint can never be confused with a freshly rebuilt chain.
//   * No default values are invented: asking for history while the chain is
//     invalid returns a lease marked `valid: false` and the renderer falls back
//     to its own current-frame G-buffer using the shader's reason-code-1 path.
//
// The denoising algorithm and its parameters live in the shaders and are not
// changed here; this module only decides which texture is presented when.

import { createRenderTarget, destroyRenderTarget } from '../gl/gl.js';

export class FrameIdentityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'FrameIdentityError';
    this.details = details;
  }
}

export class HistoryLeaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryLeaseError';
  }
}

export class HistoryStore {
  constructor(gl, width, height) {
    if (!gl) throw new Error('HistoryStore 需要 WebGL2 上下文');
    this.gl = gl;
    this.width = width;
    this.height = height;
    // Double-buffered accumulated color (rgb) + history weight (alpha).
    this.colorTargets = [
      createRenderTarget(gl, width, height, { attachments: 1 }),
      createRenderTarget(gl, width, height, { attachments: 1 }),
    ];
    // Previous frame's normal/depth attachment, used for the disocclusion test.
    this.prevDepthTarget = createRenderTarget(gl, width, height, { attachments: 1 });
    this._clearTarget(this.prevDepthTarget);
    this._index = 0;
    this._valid = false;
    this._lastFrame = null;
    this._version = 0;
    this._epoch = 1;
    this._lease = null;
  }

  _clearTarget(rt) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get valid() {
    return this._valid;
  }

  /** Index of the render target holding the latest committed history. */
  get index() {
    return this._index;
  }

  /** Monotonic version of the history currently available for reading. */
  get version() {
    return this._version;
  }

  /** Bumped whenever the chain is invalidated; checkpoints pin their epoch. */
  get epoch() {
    return this._epoch;
  }

  get lastFrame() {
    return this._lastFrame;
  }

  get leased() {
    return this._lease !== null;
  }

  /** The currently borrowed lease, or null when the store is free. */
  get activeLease() {
    return this._lease;
  }

  /**
   * Borrow the history artifacts needed to render `frame`.
   *
   * Returns a lease object. When the chain is valid it names the exact
   * predecessor frame; otherwise `valid` is false and the caller must use the
   * no-history fallback. Throws FrameIdentityError when the requested frame
   * does not follow the stored predecessor, and HistoryLeaseError when a
   * previous lease was never released.
   */
  acquire(frame) {
    if (!Number.isInteger(frame) || frame < 0) {
      throw new FrameIdentityError(`帧号非法: ${frame}`, { frame });
    }
    if (this._lease) {
      throw new HistoryLeaseError(
        `历史已被帧 ${this._lease.frame} 借用，必须先 release 再取得`);
    }
    if (this._valid) {
      const expected = this._lastFrame + 1;
      if (frame !== expected) {
        throw new FrameIdentityError(
          `帧身份不匹配：历史属于帧 ${this._lastFrame}，下一帧必须是 ${expected}，请求却是 ${frame}；` +
          '重跑需先按对应帧身份重建历史（预热重放或 clearHistory）',
          { requested: frame, expected, lastFrame: this._lastFrame, epoch: this._epoch });
      }
    }
    const readIndex = this._index;
    const writeIndex = 1 - readIndex;
    const lease = {
      frame,
      valid: this._valid,
      predecessor: this._valid ? this._lastFrame : null,
      epoch: this._epoch,
      readVersion: this._version,
      readColor: this.colorTargets[readIndex],
      writeColor: this.colorTargets[writeIndex],
      prevDepth: this.prevDepthTarget,
      // The temporal shader samples a depth texture even in the no-history
      // case. Falling back to the current G-buffer reproduces reason code 1
      // exactly; the zero-alpha history texture forces the rejection itself.
      released: false,
    };
    this._lease = lease;
    return lease;
  }

  /**
   * Finish a borrowed frame: swap the double buffer, stamp the frame identity
   * and advance the history version.
   */
  commit(lease) {
    this._assertLease(lease);
    this._index = 1 - this._index;
    this._lastFrame = lease.frame;
    this._valid = true;
    this._version += 1;
    lease.released = true;
    this._lease = null;
    return { frame: lease.frame, version: this._version, epoch: this._epoch };
  }

  /** Return a borrowed frame without mutating the chain (cancel mid-frame). */
  release(lease) {
    this._assertLease(lease);
    lease.released = true;
    this._lease = null;
  }

  _assertLease(lease) {
    if (!this._lease || this._lease !== lease) {
      throw new HistoryLeaseError('release/commit 的租约不存在或已归还');
    }
  }

  /** Invalidate the chain without destroying storage (cancel-safe). */
  invalidate(reason = 'clear') {
    if (this._lease) {
      throw new HistoryLeaseError('历史处于借用状态时不得失效；请先 release/commit');
    }
    for (const rt of this.colorTargets) this._clearTarget(rt);
    this._clearTarget(this.prevDepthTarget);
    this._valid = false;
    this._lastFrame = null;
    this._index = 0;
    this._version = 0;
    this._epoch += 1;
    return { epoch: this._epoch, reason };
  }

  /** Snapshot the identity of the current chain for checkpoint metadata. */
  describe() {
    return {
      valid: this._valid,
      lastFrame: this._lastFrame,
      version: this._version,
      epoch: this._epoch,
      width: this.width,
      height: this.height,
    };
  }

  dispose() {
    if (this._lease) {
      // Disposal is a teardown-only path (renderer dispose / scene swap);
      // normal cancellation must call release() instead.
      this._lease = null;
    }
    for (const rt of this.colorTargets) destroyRenderTarget(this.gl, rt);
    destroyRenderTarget(this.gl, this.prevDepthTarget);
    this.colorTargets = [];
    this.prevDepthTarget = null;
    this._valid = false;
    this._lastFrame = null;
  }
}
