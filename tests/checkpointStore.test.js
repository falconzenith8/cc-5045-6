import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointStore, CheckpointError } from '../src/temporal/checkpointStore.js';
import { frameRmse, frameLumaMad, compareExecutions } from '../src/temporal/equivalence.js';

function state(over = {}) {
  return { valid: true, lastFrame: 10, version: 11, epoch: 2, width: 4, height: 4, ...over };
}

test('checkpoint pins frame identity, epoch and history version', () => {
  const store = new CheckpointStore();
  const cp = store.saveCheckpoint({ frame: 10, epoch: 2, version: 11, reason: 'segment-1-done' });
  assert.equal(cp.frame, 10);
  assert.equal(cp.epoch, 2);
  assert.equal(cp.historyVersion, 11);
  assert.equal(store.size, 1);
});

test('an invalid chain cannot produce a checkpoint (no default masking)', () => {
  const store = new CheckpointStore();
  assert.throws(
    () => store.saveCheckpoint({ frame: 3, epoch: 1, version: 0, valid: false }),
    CheckpointError);
  assert.throws(() => store.saveCheckpoint({ frame: -1, epoch: 1, version: 1 }), CheckpointError);
});

test('verify accepts a matching live chain and rejects epoch/version/frame drift', () => {
  const store = new CheckpointStore();
  const cp = store.saveCheckpoint({ frame: 10, epoch: 2, version: 11 });
  assert.equal(store.verify(cp.id, state()).ok, true);
  assert.equal(store.verify(cp.id, state({ epoch: 3 })).ok, false);
  assert.equal(store.verify(cp.id, state({ version: 12 })).ok, false);
  assert.equal(store.verify(cp.id, state({ lastFrame: 9 })).ok, false);
  const invalid = store.verify(cp.id, state({ valid: false }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.problems.some((p) => p.includes('无效')));
});

test('frame-error evidence is attached and read back', () => {
  const store = new CheckpointStore();
  const cp = store.saveCheckpoint({ frame: 10, epoch: 2, version: 11 });
  store.attachEvidence(cp.id, { rmse: 0.0031, acceptedDelta: 0.2, weightDelta: 0.001 });
  const ev = store.getEvidence(cp.id);
  assert.equal(ev.rmse, 0.0031);
  assert.throws(() => store.attachEvidence('missing', {}), CheckpointError);
});

test('frameRmse and lumaMad quantify identical vs changed buffers', () => {
  const a = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  assert.equal(frameRmse(a, a), 0);
  assert.equal(frameLumaMad(a, a), 0);
  const b = new Uint8Array([20, 20, 30, 255, 40, 60, 60, 255]);
  assert.ok(frameRmse(a, b) > 0);
  assert.ok(frameLumaMad(a, b) > 0);
  assert.throws(() => frameRmse(a, new Uint8Array([1])), /等长/);
});

function rec(frame, seed) {
  const denoised = new Uint8Array(4 * 4).fill(100 + seed);
  const metrics = { acceptedPct: 95 + seed * 0.1, meanHistoryWeight: 0.8 };
  return { frame, denoised, metrics };
}

test('compareExecutions accepts equivalent runs and flags missing frames', () => {
  const ref = [rec(0, 0), rec(1, 0), rec(2, 0)];
  const same = [rec(0, 0), rec(1, 0), rec(2, 0)];
  const ok = compareExecutions(ref, same);
  assert.equal(ok.equivalent, true);
  assert.equal(ok.frameCount, 3);
  assert.equal(ok.maxRmse, 0);

  const missing = [rec(0, 0), rec(2, 0)];
  const missingReport = compareExecutions(ref, missing);
  assert.equal(missingReport.equivalent, false);
  assert.ok(missingReport.problems.some((p) => p.includes('帧 1') && p.includes('缺失')));
});

test('compareExecutions bounds pixel and adoption deltas with explicit tolerances', () => {
  const ref = [rec(0, 0)];
  const drifted = [{
    frame: 0,
    denoised: new Uint8Array(16).fill(200),
    metrics: { acceptedPct: 80, meanHistoryWeight: 0.5 },
  }];
  const report = compareExecutions(ref, drifted);
  assert.equal(report.equivalent, false);
  assert.ok(report.problems.some((p) => p.includes('RMSE')));
  assert.ok(report.problems.some((p) => p.includes('采纳率')));
  assert.ok(report.problems.some((p) => p.includes('权重')));
});
