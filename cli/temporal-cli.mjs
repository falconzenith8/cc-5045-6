#!/usr/bin/env node
// Auxiliary command-line helper for the temporal denoiser.
//
// The graphical entry point (npm run dev) is the primary interface; this CLI
// drives the same renderer headlessly for automation and CI. It prints the
// execution plan, per-frame metrics, the seam report, and can export the
// review archive. It does NOT reimplement denoising: it drives the same
// WebGL2 pipeline through a headless browser.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CHROME_LIBS = '/tmp/sysroot/usr/lib/aarch64-linux-gnu:/tmp/sysroot/lib/aarch64-linux-gnu';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(`时序降噪 CLI（辅助工具；图形入口见 README）

用法:
  node cli/temporal-cli.mjs plan   [--scene moving-camera] [--segments 2] [--warmup 11]
  node cli/temporal-cli.mjs run    [--scene ...] [--start 0] [--end 71] [--segments 2]
                                   [--spp 1] [--max-history 12] [--out ./out]
  node cli/temporal-cli.mjs export [--scene ...] [--out ./out]

说明:
  * run 会真实执行路径追踪 + 时序降噪，打印每帧历史采纳率与回退原因。
  * 未预热的分段会在接缝帧报告历史权重跌落，CLI 以非零退出码标记该问题。
  * 图形面板提供拖动序列、清除历史、结果区查看降噪帧与历史采用。
`);
}

async function launchBrowser() {
  const env = { ...process.env };
  if (!env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = DEFAULT_CHROME_LIBS;
  return chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'],
    env,
  });
}

async function openHarness(page) {
  const base = process.env.DENOISE_BASE_URL || 'http://127.0.0.1:5173';
  await page.goto(`${base}/tests/harness.html`);
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30000 });
}

const SCENES = ['moving-camera', 'background-reveal', 'fast-occlusion'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'plan';
  if (args.help || args.h) { usage(); return 0; }
  const sceneId = args.scene || 'moving-camera';
  if (!SCENES.includes(sceneId)) {
    console.error(`未知场景 ${sceneId}；可用：${SCENES.join(', ')}`);
    return 2;
  }
  const sceneFrames = { 'moving-camera': 84, 'background-reveal': 72, 'fast-occlusion': 72 }[sceneId];
  const segments = Number(args.segments ?? 1);
  const maxHistory = Number(args['max-history'] ?? 12);
  const warmup = args.warmup !== undefined ? Number(args.warmup) : Math.max(0, maxHistory - 1);
  const start = Number(args.start ?? 0);
  const end = Number(args.end ?? sceneFrames - 1);
  const segSize = Math.ceil((end - start + 1) / segments);

  if (cmd === 'plan') {
    const { planExecution, validatePlan } = await import('../src/temporal/scheduler.js');
    const plan = planExecution({ frames: sceneFrames, fps: 24 }, {
      start, end, segmentSize: segSize, warmup, maxHistory,
    });
    const check = validatePlan(plan, { frames: sceneFrames });
    console.log(JSON.stringify({ plan, validation: check }, null, 2));
    return check.ok ? 0 : 1;
  }

  if (cmd === 'run' || cmd === 'export') {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
    try {
      await openHarness(page);
      await page.evaluate(({ id, maxHistory }) => window.__harness.init(id, { samplesPerFrame: 1, maxHistory }),
        { id: sceneId, maxHistory });
      const { planExecution } = await import('../src/temporal/scheduler.js');
      const plan = planExecution({ frames: sceneFrames, fps: 24 }, {
        start, end, segmentSize: segSize, warmup, maxHistory,
      });
      console.log(`场景 ${sceneId}，帧 ${start}–${end}，${plan.segments.length} 段，预热 ${warmup} 帧`);
      for (const seg of plan.segments) {
        console.log(`  段 ${seg.index}: 帧 ${seg.start}–${seg.end}，预热 ` +
          (seg.index === 0 ? '无（首段）' : `${seg.warmup} 帧 @ ${seg.warmupStart}–${seg.warmupEnd}`));
      }

      const results = await page.evaluate(async (planArg) => {
        const out = { frames: [], seams: [] };
        window.__harness.clearHistory();
        for (const seg of planArg.segments) {
          if (seg.index > 0) {
            for (let f = seg.warmupStart; f <= seg.warmupEnd; f++) window.__harness.renderOne(f);
            out.seams.push({ frame: seg.start, warmup: seg.warmup });
          }
          for (let f = seg.start; f <= seg.end; f++) {
            const m = window.__harness.renderOne(f);
            out.frames.push({ frame: f, segment: seg.index, ...m });
          }
        }
        return out;
      }, { segments: plan.segments });

      let seamProblems = 0;
      for (const seam of results.seams) {
        const rec = results.frames.find((f) => f.frame === seam.frame);
        const ok = rec && rec.acceptedPct > 50;
        if (!ok) seamProblems++;
        console.log(`接缝 f${seam.frame}: 预热 ${seam.warmup} 帧，历史采纳 ${rec ? rec.acceptedPct.toFixed(1) : '?'}%` +
          (ok ? '' : '  ← 历史未恢复，接缝画质跳变'));
      }
      const rejectedFrames = results.frames.filter((f) => f.rejectedPct > 50);
      console.log(`完成 ${results.frames.length} 帧；` +
        `历史采纳率均值 ${(results.frames.reduce((s, f) => s + f.acceptedPct, 0) / results.frames.length).toFixed(1)}%；` +
        `历史拒绝>50% 的帧: ${rejectedFrames.length}`);
      for (const f of results.frames.filter((x) => x.acceptedPct < 5)) {
        console.log(`  帧 ${f.frame}: 采纳 ${f.acceptedPct.toFixed(1)}%，主因 ` +
          Object.entries(f.reasons).filter(([, n]) => n > 0).map(([c, n]) => `${c}:${n}`).join(' '));
      }

      if (args.out) {
        await fs.mkdir(args.out, { recursive: true });
        const manifest = {
          scene: sceneId,
          start, end, segments: plan.segments.length, warmup,
          note: 'CLI 通过同一 WebGL2 时序管线执行；metrics 为真实运算结果。',
          frames: results.frames.map((f) => ({
            frame: f.frame, segment: f.segment,
            acceptedPct: +f.acceptedPct.toFixed(2),
            rejectedPct: +f.rejectedPct.toFixed(2),
            meanHistoryWeight: +f.meanHistoryWeight.toFixed(4),
            reasons: f.reasons,
          })),
          seams: results.seams,
        };
        await fs.writeFile(path.join(args.out, 'metrics.json'), JSON.stringify(manifest, null, 2));
        if (cmd === 'export') {
          for (const kind of ['denoised', 'noisy']) {
            const data = await page.evaluate((k) => {
              const cap = window.__harness.capture(k);
              return { width: cap.width, height: cap.height, data: cap.data };
            }, kind);
            // Store the final frame only; full sequences are exported from the UI.
            const png = await page.evaluate(async (cap) => {
              const c = document.createElement('canvas');
              c.width = cap.width; c.height = cap.height;
              const img = new ImageData(new Uint8ClampedArray(cap.data), cap.width, cap.height);
              c.getContext('2d').putImageData(img, 0, 0);
              const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
              return Array.from(new Uint8Array(await blob.arrayBuffer()));
            }, data);
            await fs.writeFile(path.join(args.out, `last-${kind}.png`), Buffer.from(png));
          }
          console.log(`已写出 ${args.out}/metrics.json 与末帧 PNG（完整序列请用图形面板导出）。`);
        } else {
          console.log(`已写出 ${args.out}/metrics.json`);
        }
      }
      return seamProblems === 0 ? 0 : 3;
    } finally {
      await browser.close();
    }
  }

  usage();
  return 2;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('CLI 失败:', e.message);
  process.exit(1);
});
