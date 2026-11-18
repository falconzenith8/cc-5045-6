import { test, expect } from '@playwright/test';

// The headless Chromium in this environment needs a few unpacked system libs.
const LIBS = '/tmp/sysroot/usr/lib/aarch64-linux-gnu:/tmp/sysroot/lib/aarch64-linux-gnu';

test.use({
  launchOptions: {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS },
  },
});

async function runToCompletion(page) {
  await page.getByRole('button', { name: '开始渲染' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.progressFill');
    return el && parseFloat(el.style.width) >= 99.9;
  }, null, { timeout: 260000 });
  await page.waitForTimeout(600);
}

test('panel reports real temporal results and exposes scrub + history controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '时序降噪出图面板' })).toBeVisible();
  await page.locator('.topActions select').selectOption('moving-camera');
  await runToCompletion(page);

  // Timeline is draggable and updates the current frame.
  const scrub = page.locator('input.scrub');
  await expect(scrub).toBeEnabled();
  await scrub.fill('30');
  await expect(page.locator('.transport .mono')).toContainText('f30');

  // Results section shows the comparison table with all three columns.
  const table = page.locator('table.table').first();
  await expect(table).toContainText('时序降噪');
  await expect(table).toContainText('逐帧独立降噪');
  await expect(table).toContainText('原始噪声');

  // History adoption view renders on the CPU overlay canvas.
  await page.getByRole('button', { name: '历史采用' }).click();
  const overlay = page.locator('canvas.cpuCanvas');
  await expect(overlay).toBeVisible();
  const nonBlank = await page.evaluate(() => {
    const c = document.querySelector('canvas.cpuCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s;
  });
  expect(nonBlank).toBeGreaterThan(0);

  // Clearing history is announced and takes effect on the next delivered frame.
  await page.getByRole('button', { name: '清除历史' }).click();
  await expect(page.locator('.banner.warn')).toContainText('历史已清除');
});

test('two-segment run preheats the seam and reports it', async ({ page }) => {
  await page.goto('/');
  await page.locator('.topActions select').selectOption('fast-occlusion');
  await page.locator('.field select').selectOption('split');
  await runToCompletion(page);

  const seamTable = page.locator('table.table').nth(1);
  await expect(seamTable).toContainText('接缝帧');
  const seamRow = seamTable.locator('tr').nth(1);
  await expect(seamRow).toContainText('11 帧');

  // The seam frame must have recovered history thanks to warm-up.
  const seamAccepted = await seamRow.locator('td').nth(2).innerText();
  expect(parseFloat(seamAccepted)).toBeGreaterThan(50);

  await expect(page.getByText('预热重放 11 帧')).toBeVisible();
});

test('exports a playable WebM and a review archive with noisy frames', async ({ page }) => {
  await page.goto('/');
  await page.locator('.topActions select').selectOption('background-reveal');
  // Render a short range to keep the test fast.
  await page.locator('.field input[type="number"]').first().fill('1');
  await runToCompletion(page);

  const [webm] = await Promise.all([
    page.waitForEvent('download', { timeout: 200000 }),
    page.getByRole('button', { name: '导出降噪 WebM' }).click(),
  ]);
  expect(webm.suggestedFilename()).toMatch(/denoised\.webm$/);
  const webmPath = await webm.path();
  const { statSync } = await import('node:fs');
  expect(statSync(webmPath).size).toBeGreaterThan(10000);

  const [zip] = await Promise.all([
    page.waitForEvent('download', { timeout: 200000 }),
    page.getByRole('button', { name: '导出复核包（噪声帧 + 指标）' }).click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/-review\.zip$/);
  const zipPath = await zip.path();
  const { execFileSync } = await import('node:child_process');
  const listing = execFileSync('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
names=z.namelist()
print(len(names), sum(1 for n in names if n.startswith('noisy/')), 'manifest.json' in names)
`, zipPath]).toString().trim();
  const [entries, noisy, hasManifest] = listing.split(' ').map((x) => x === 'True' ? true : x);
  expect(Number(noisy)).toBeGreaterThan(0);
  expect(hasManifest).toBe(true);
});
