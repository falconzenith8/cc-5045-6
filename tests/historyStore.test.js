import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore, FrameIdentityError, HistoryLeaseError } from '../src/temporal/historyStore.js';

// Minimal GL stub: HistoryStore only needs framebuffer/texture handles and the
// clear calls it issues itself. The real GL binding paths are covered by the
// Playwright E2E suite against the actual WebGL2 pipeline.
function createFakeGl() {
  let fbSeq = 0;
  let texSeq = 0;
  return {
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_BUFFER_BIT: 0x4000,
    createFramebuffer: () => ({ id: ++fbSeq }),
    createTexture: () => ({ id: ++texSeq }),
    bindFramebuffer() {},
    framebufferTexture2D() {},
    drawBuffers() {},
    checkFramebufferStatus() { return 0x8cd5; }, // FRAMEBUFFER_COMPLETE
    texStorage2D() {},
    texParameteri() {},
    bindTexture() {},
    clearColor() {},
    clear() {},
    deleteTexture(t) { t.deleted = true; },
    deleteFramebuffer(fb) { fb.deleted = true; },
  };
}

test('first acquire reports an invalid chain and the shader no-history fallback', () => {
  const store = new HistoryStore(createFakeGl(), 4, 4);
  const lease = store.acquire(0);
  assert.equal(lease.valid, false);
  assert.equal(lease.predecessor, null);
  assert.equal(lease.readColor, store.colorTargets[0]);
  assert.equal(lease.writeColor, store.colorTargets[1]);
  store.commit(lease);
  assert.equal(store.valid, true);
  assert.equal(store.lastFrame, 0);
  assert.equal(store.version, 1);
});

test('acquire enforces the frame identity: only lastFrame + 1 is accepted', () => {
  const store = new HistoryStore(createFakeGl(), 4, 4);
  store.commit(store.acquire(5));
  assert.throws(() => store.acquire(5), FrameIdentityError);
  assert.throws(() => store.acquire(7), FrameIdentityError);
  const lease = store.acquire(6);
  assert.equal(lease.valid, true);
  assert.equal(lease.predecessor, 5);
  store.commit(lease);
  assert.equal(store.lastFrame, 6);
});

test('a canceled frame releases the lease without destroying shared state', () => {
  const store = new HistoryStore(createFakeGl(), 4, 4);
  const first = store.acquire(3);
  store.commit(first);
  const borrowed = store.acquire(4);
  store.release(borrowed);
  assert.equal(store.leased, false);
  assert.equal(store.valid, true);
  assert.equal(store.lastFrame, 3, '取消不得提前销毁共享历史');
  // The chain is still usable with the matching next frame.
  const retry = store.acquire(4);
  store.commit(retry);
  assert.equal(store.lastFrame, 4);
});

test('double acquire is rejected until the lease is returned', () => {
  const store = new HistoryStore(createFakeGl(), 4, 4);
  store.acquire(0);
  assert.throws(() => store.acquire(1), HistoryLeaseError);
});

test('invalidate keeps storage allocated but opens a new epoch', () => {
  const gl = createFakeGl();
  const store = new HistoryStore(gl, 4, 4);
  store.commit(store.acquire(0));
  const epochBefore = store.epoch;
  const state = store.invalidate('test');
  assert.equal(state.epoch, epochBefore + 1);
  assert.equal(store.valid, false);
  assert.equal(store.version, 0);
  assert.equal(store.lastFrame, null);
  assert.equal(store.colorTargets.length, 2, '失效不销毁渲染目标');
  // After invalidation a rerun may start from any frame.
  const lease = store.acquire(20);
  assert.equal(lease.valid, false);
  store.commit(lease);
  assert.equal(store.lastFrame, 20);
});

test('commit stamps a monotonic history version per frame', () => {
  const store = new HistoryStore(createFakeGl(), 4, 4);
  for (const f of [0, 1, 2]) {
    const info = store.commit(store.acquire(f));
    assert.equal(info.frame, f);
    assert.equal(info.version, f + 1);
  }
  assert.deepEqual(store.describe(), {
    valid: true, lastFrame: 2, version: 3, epoch: 1, width: 4, height: 4,
  });
});

test('dispose frees every owned render target exactly once', () => {
  const gl = createFakeGl();
  const store = new HistoryStore(gl, 4, 4);
  const targets = [...store.colorTargets, store.prevDepthTarget];
  store.dispose();
  for (const rt of targets) {
    for (const tex of rt.textures) assert.equal(tex.deleted, true);
    assert.equal(rt.framebuffer.deleted, true);
  }
});

test('release/commit of an unknown lease is an error', () => {
  const store = new HistoryStore(createFakeGl(), 4, 4);
  assert.throws(() => store.release({}), HistoryLeaseError);
  assert.throws(() => store.commit({}), HistoryLeaseError);
});
