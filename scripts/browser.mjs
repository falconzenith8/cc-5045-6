import { chromium } from 'playwright';

const LIBS = '/tmp/sysroot/usr/lib/aarch64-linux-gnu:/tmp/sysroot/lib/aarch64-linux-gnu';

export async function launch() {
  return chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
      '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS },
  });
}

export async function openHarness(page) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.type(), m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:5173/tests/harness.html');
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30000 });
}
