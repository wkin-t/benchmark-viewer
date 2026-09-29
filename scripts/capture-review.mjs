import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const serverScript = path.resolve('tests/smoke/dev-server.mjs');
const port = 8089;
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [serverScript], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore'
});

for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}

let browser;
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel });
    break;
  } catch {}
}

if (!browser) {
  console.error('No browser available');
  server.kill();
  process.exit(1);
}

const outDir = path.resolve('.impeccable/review');
fs.mkdirSync(outDir, { recursive: true });

async function capture(name, { width, height, theme, source = 'official' }) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  await page.locator('.pt').first().waitFor();

  if (theme) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('bv-theme', t);
    }, theme);
  }

  if (source === 'supplement') {
    await page.getByRole('button', { name: '补充', exact: true }).click();
    await page.locator('.pt').nth(19).waitFor();
  }

  await page.waitForTimeout(300);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`Saved screenshot: ${file}`);
  await context.close();
}

await capture('desktop-1300-light', { width: 1300, height: 900, theme: 'light' });
await capture('desktop-1300-dark', { width: 1300, height: 900, theme: 'dark' });
await capture('mobile-360-light', { width: 360, height: 800, theme: 'light' });
await capture('mobile-360-dark', { width: 360, height: 800, theme: 'dark' });

await browser.close();
server.kill();
