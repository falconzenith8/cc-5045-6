import { test, expect } from '@playwright/test';

// Ownership refactor regression: frame identity, cancel-safe history and the
// explicit acquire/replay protocol. These run on the renderer harness so they
// can assert on history epochs/versions directly.
const LIBS = '/tmp/sysroot/usr/lib/aarch64-linux-gnu:/tmp/sysroot/lib/aarch64-linux-gnu';

test.use({
  launchOptions: {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS },
  },
});

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => window.__harnessReady === true);
});

test('out-of-order frame identity throws instead of silently reusing history', async ({ page }) => {
  const err = await page.evaluate(() => {
    const h = window.__harness;
    h.init('moving-camera', { samplesPerFrame: 1, maxHistory: 12 });
    h.renderRangeResetOnce(0, 5, true);
    // Strict renderer path (no allowRestart): frame 3 cannot follow frame 5.
    try {
      h.renderOne(3, { allowRestart: false });
      return null;
    } catch (e) {
      return { name: e.name, message: e.message, details: e.details };
    }
  });
  expect(err).not.toBeNull();
  expect(err.name).toBe('FrameIdentityError');
  expect(err.details.requested).toBe(3);
  expect(err.details.expected).toBe(6);
});

test('cancel keeps shared history and a replay rebuilds an equivalent chain', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { compareExecutions } = await import('/src/temporal/equivalence.js');
    const h = window.__harness;
    h.init('moving-camera', { samplesPerFrame: 1, maxHistory: 12 });
    const continuous = h.continuousRun(20, 30);
    const resumed = h.cancelResumeRun(20, 30, 12);
    const toRecords = (list) => list.map((f) => ({
      frame: f.frame,
      denoised: Uint8Array.from(f.denoised),
      metrics: f.metrics,
    }));
    const report = compareExecutions(toRecords(continuous.frames), toRecords(resumed.frames));
    return {
      report,
      retained: resumed.retained,
      replayRange: resumed.replayRange,
      resumedEpoch: resumed.frames[0].historyEpoch,
    };
  });
  // Cancel must leave the chain at the last delivered frame, not destroy it.
  expect(result.retained.valid).toBe(true);
  expect(result.retained.lastFrame).toBe(12);
  expect(result.replayRange).toEqual([9, 19]);
  expect(result.report.equivalent).toBe(true);
  expect(result.report.maxRmse).toBeLessThan(0.02);
  expect(result.report.maxAcceptedDelta).toBeLessThan(1.0);
});

test('cleared history opens a new epoch and the next frame uses reason-code 1', async ({ page }) => {
  const missing = await page.evaluate(() => {
    const h = window.__harness;
    h.init('moving-camera', { samplesPerFrame: 1, maxHistory: 12 });
    return h.missingHistoryProbe(8, 9);
  });
  expect(missing.afterClear.epoch).toBeGreaterThan(missing.before.epoch);
  expect(missing.afterClear.valid).toBe(false);
  expect(missing.nextAcceptedPct).toBeLessThan(2);
  expect(missing.nextReason1).toBeGreaterThan(0);
  expect(missing.storageSurvived).toBe(true);
});

test('checkpoint store pins epoch and version and rejects drift', async ({ page }) => {
  const verdict = await page.evaluate(async () => {
    const { CheckpointStore } = await import('/src/temporal/checkpointStore.js');
    const store = new CheckpointStore();
    const cp = store.saveCheckpoint({ frame: 10, epoch: 2, version: 11 });
    const good = store.verify(cp.id, { valid: true, lastFrame: 10, version: 11, epoch: 2 });
    const drifted = store.verify(cp.id, { valid: true, lastFrame: 10, version: 12, epoch: 2 });
    return { good: good.ok, driftedOk: drifted.ok, driftedProblems: drifted.problems };
  });
  expect(verdict.good).toBe(true);
  expect(verdict.driftedOk).toBe(false);
  expect(verdict.driftedProblems.length).toBeGreaterThan(0);
});
