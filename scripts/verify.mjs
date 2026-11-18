#!/usr/bin/env node
// Reproducible quantitative verification of the temporal denoiser.
//
// Prints three checks that are easy to fake by accident:
//   1. static-region temporal stability vs per-frame independent denoising
//   2. motion-masked error against a high-sample reference (ghosting)
//   3. seam behaviour with and without warm-up replay
//
// All measurements drive the real WebGL2 pipeline through the test harness.

import { launch, openHarness } from './browser.mjs';

const out = [];
const log = (s) => { out.push(s); console.log(s); };

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
await openHarness(page);

// 1. Stability on static surfaces.
const stabilityFrames = [56, 57, 58, 59, 60, 61];
log('== 1. 静止区域时间稳定性（相邻帧亮度平均绝对变化，越低越稳） ==');
for (const scene of ['moving-camera', 'background-reveal', 'fast-occlusion']) {
  await page.evaluate((s) => window.__harness.init(s, { samplesPerFrame: 1 }), scene);
  const temporal = await page.evaluate((fr) => window.__harness.staticRegionStability(fr, 'denoised'), stabilityFrames);
  await page.evaluate((s) => window.__harness.init(s, { samplesPerFrame: 1, temporalEnabled: false }), scene);
  const independent = await page.evaluate((fr) => window.__harness.staticRegionStability(fr, 'independent'), stabilityFrames);
  log(`  ${scene.padEnd(18)} 时序 ${temporal.toFixed(5)}  独立 ${independent.toFixed(5)}  ` +
    `改善 ${(independent / Math.max(temporal, 1e-9)).toFixed(2)}x`);
}

// 2. Ghosting: motion-masked error vs a 24spp reference, using the SAME
//    per-frame sample count for the compared runs.
log('');
log('== 2. 运动像素误差（对比 24spp 参考，同一每帧采样数；时序不应高于独立） ==');
for (const [scene, frames] of [
  ['moving-camera', [20, 40, 60]],
  ['background-reveal', [32, 40, 48]],
  ['fast-occlusion', [34, 38, 44]],
]) {
  await page.evaluate((s) => window.__harness.init(s, { samplesPerFrame: 1 }), scene);
  for (const f of frames) {
    await page.evaluate((x) => {
      window.__harness.clearHistory();
      window.__harness.renderRangeResetOnce(0, x, false);
    }, f);
    const r = await page.evaluate(([s, x]) => window.__harness.ghostProbe(s, x, 24), [scene, f]);
    const ratio = r.maskedTemporal / Math.max(r.maskedIndependent, 1e-9);
    log(`  ${scene.padEnd(18)} f${String(f).padEnd(3)} 运动像素 ${String(r.changedPixels).padStart(5)}  ` +
      `时序 ${r.maskedTemporal.toFixed(4)}  独立 ${r.maskedIndependent.toFixed(4)}  ` +
      `比值 ${ratio.toFixed(3)} ${ratio <= 1.02 ? 'OK' : '可疑拖影'}`);
  }
}

// 3. Seam with / without warm-up.
log('');
log('== 3. 分段接缝（无预热 vs 预热 11 帧 vs 连续运行） ==');
const run = await page.evaluate(() => {
  const h = window.__harness;
  h.init('moving-camera', { samplesPerFrame: 1, maxHistory: 12 });
  const cont = h.renderRangeResetOnce(0, 24, false);
  h.init('moving-camera', { samplesPerFrame: 1, maxHistory: 12 });
  h.renderRangeResetOnce(0, 19, false);
  h.clearHistory();
  const naive = h.renderRangeResetOnce(20, 24, false);
  h.init('moving-camera', { samplesPerFrame: 1, maxHistory: 12 });
  h.renderRangeResetOnce(0, 19, false);
  h.renderRangeResetOnce(9, 19, false);
  const warm = h.renderRangeResetOnce(20, 24, false);
  const w = (arr) => arr.map((f) => f.meanHistoryWeight.toFixed(2)).join(' ');
  return {
    cont: w(cont.slice(20)),
    naive: w(naive),
    warm: w(warm),
    naiveAccepted: naive[0].acceptedPct,
    warmAccepted: warm[0].acceptedPct,
    contAccepted: cont[20].acceptedPct,
  };
});
log(`  连续运行 f20..24 权重: ${run.cont}`);
log(`  无预热  f20..24 权重: ${run.naive}  （首帧采纳 ${run.naiveAccepted.toFixed(1)}%）`);
log(`  有预热  f20..24 权重: ${run.warm}  （首帧采纳 ${run.warmAccepted.toFixed(1)}%）`);
log(`  连续运行首帧采纳 ${run.contAccepted.toFixed(1)}%`);
const seamOk = Math.abs(run.warmAccepted - run.contAccepted) < 2 && run.naiveAccepted < 5;
log(`  结论：${seamOk ? '预热抹平接缝；无预热首帧历史归零' : '未达预期'}`);

await browser.close();
if (!seamOk) process.exit(3);
