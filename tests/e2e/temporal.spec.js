import { test, expect } from '@playwright/test';

const LIBS = '/tmp/sysroot/usr/lib/aarch64-linux-gnu:/tmp/sysroot/lib/aarch64-linux-gnu';

test.use({
  launchOptions: {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS },
  },
});

// These assertions run against the renderer harness, not the panel, so they
// can quantify the seam the scheduler is designed to remove.
test('warm-up removes the segment seam that a naive restart leaves behind', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => window.__harnessReady === true);

  const result = await page.evaluate(() => {
    const h = window.__harness;
    const run = (warmupFrames) => {
      h.init('moving-camera', { samplesPerFrame: 1, maxHistory: 12 });
      h.renderRangeResetOnce(0, 19, false);
      if (warmupFrames > 0) h.renderRangeResetOnce(20 - warmupFrames, 19, false);
      else h.clearHistory();
      return h.renderRangeResetOnce(20, 24, false);
    };
    return { naive: run(0), warm: run(11) };
  });

  const naiveFirst = result.naive[0];
  const warmFirst = result.warm[0];
  expect(naiveFirst.acceptedPct).toBeLessThan(2);
  expect(naiveFirst.meanHistoryWeight).toBeLessThan(0.02);
  expect(warmFirst.acceptedPct).toBeGreaterThan(90);
  expect(warmFirst.meanHistoryWeight).toBeGreaterThan(0.7);

  // The naive run needs several frames to climb back; the warm run is stable
  // from the first delivered frame onward.
  const naiveWeights = result.naive.map((f) => f.meanHistoryWeight);
  expect(naiveWeights[0]).toBeLessThan(0.02);
  expect(naiveWeights[4]).toBeGreaterThan(0.15);
  for (const f of result.warm) expect(f.meanHistoryWeight).toBeGreaterThan(0.7);
});

test('temporal accumulation reduces per-frame noise versus independent denoising', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => window.__harnessReady === true);

  const res = await page.evaluate(() => {
    const h = window.__harness;
    h.init('background-reveal', { samplesPerFrame: 1 });
    const frames = h.renderRangeResetOnce(0, 30, false);
    // Residual noise estimate on the frame after the reveal settles.
    const stats = h.noiseStats(30);
    return { frames, stats };
  });
  expect(res.frames.at(-1).acceptedPct).toBeGreaterThan(90);
  // Noise measured as high-frequency local variance is lower with history.
  expect(res.stats.temporal).toBeLessThan(res.stats.independent);
  expect(res.stats.temporal).toBeLessThan(res.stats.noisy);
});

test('history rejection is attributed to explicit reasons', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => window.__harnessReady === true);

  const res = await page.evaluate(() => {
    const h = window.__harness;
    h.init('background-reveal', { samplesPerFrame: 1 });
    const frames = h.renderRangeResetOnce(0, 44, false);
    return frames;
  });
  // The reveal produces disocclusions, which must be reported as depth
  // mismatches rather than silently averaged across frames.
  const reveal = res.find((f) => f.frame === 40);
  expect(reveal.reasons[3]).toBeGreaterThan(0);
  // The first frame must be reported as "no history".
  expect(res[0].reasons[1]).toBeGreaterThan(0);
});
