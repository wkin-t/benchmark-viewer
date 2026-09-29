// 浏览器烟雾测试：用本机已安装的 Chrome 或 Edge 驱动页面，服务端是 tests/smoke/dev-server.mjs（夹具数据）。
// 断言全部来自夹具事实（27 行、官方数据 2026-09-21、预算梯三档等）或页面上的实际文字。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, 'dev-server.mjs');

let server = null;
let base = '';
let browser = null;
let skipReason = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [serverScript], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // 服务还没起来，继续等。
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('dev-server 没有在 5 秒内启动');
}

async function launchBrowser() {
  const failures = [];
  for (const channel of ['chrome', 'msedge']) {
    try {
      return { browser: await chromium.launch({ channel }) };
    } catch (err) {
      failures.push(`${channel}: ${String(err.message).split('\n')[0]}`);
    }
  }
  return { reason: `本机没有可用的 Chrome 或 Edge，浏览器烟雾测试被跳过（${failures.join('；')}）` };
}

async function configure(params = {}) {
  const query = new URLSearchParams({ reset: '1', ...params });
  const res = await fetch(`${base}/__dev/config?${query}`, { method: 'POST' });
  assert.equal(res.status, 200, `配置 dev-server 失败：${await res.text()}`);
}

// 每个用例一个独立上下文；把控制台 error 与未捕获异常收进 errors，供需要的用例断言。
async function openPage({ viewport = { width: 1300, height: 900 }, reducedMotion, blockStorage = false, wait = true } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  if (blockStorage) {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
  }
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/`);
  if (wait) await page.locator('.pt').first().waitFor({ timeout: 10000 });
  return { page, context, errors };
}

const infoText = (page) => page.locator('#info-row').innerText();

describe('Benchmark Viewer 浏览器烟雾测试', () => {
  before(async () => {
    await startServer();
    const launched = await launchBrowser();
    browser = launched.browser ?? null;
    skipReason = launched.reason ?? null;
  });

  after(async () => {
    await browser?.close();
    server?.kill();
  });

  // 没有浏览器时每个用例开头都会 t.skip(skipReason)，明确跳过并说明原因，而不是静默通过。
  it('页面加载出 27 个点，顶部信息行有数据日期与上次同步，控制台无报错', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context, errors } = await openPage();
    try {
      assert.equal(await page.locator('.pt').count(), 27);
      const info = await infoText(page);
      assert.match(info, /榜单行数\s*27/);
      assert.match(info, /每行试验次数\s*330/);
      assert.match(info, /官方数据更新于\s*2026-09-21/);
      assert.match(info, /上次同步\s*\d+ 分钟前/);
      assert.equal(await page.locator('.flag.warn').count(), 0, '刚同步过不应有陈旧警告');
      assert.equal(await page.locator('#sync-btn').isEnabled(), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it('预算梯三档与夹具一致：≤$5 为 GPT-6 Astra low，≤$10 与 ≤$15 均为 GPT-6 Astra max', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage();
    try {
      const tier = (limit) => page.locator(`.tier[data-limit="${limit}"]`);
      assert.equal(await page.locator('.tier').count(), 3);
      const t5 = await tier(5).innerText();
      assert.match(t5, /≤\$5/);
      assert.match(t5, /GPT-6 Astra/);
      assert.match(t5, /\blow\b/);
      assert.match(t5, /\$4\.72/);
      for (const limit of [10, 15]) {
        const text = await tier(limit).innerText();
        assert.match(text, new RegExp(`≤\\$${limit}`));
        assert.match(text, /GPT-6 Astra/);
        assert.match(text, /\bmax\b/);
        assert.match(text, /\$9\.90/);
        assert.doesNotMatch(text, /\blow\b/);
      }
      const tags = await page.locator('.tier .tag').allTextContents();
      assert.deepEqual(tags, ['low', 'max', 'max'], '档位标签应为小写');
    } finally {
      await context.close();
    }
  });

  it('预算档小表在图下，图上没有预算标尺', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage();
    try {
      assert.equal(await page.locator('.budget-mark').count(), 0);
      assert.equal(await page.locator('.frontier-toggle').count(), 0);
      const box = await page.evaluate(() => {
        const chart = document.getElementById('chart-area').getBoundingClientRect();
        const ladder = document.getElementById('ladder').getBoundingClientRect();
        return { chartBottom: chart.bottom, ladderTop: ladder.top };
      });
      assert.ok(box.ladderTop >= box.chartBottom - 1, '预算档小表应在图的下方');
    } finally {
      await context.close();
    }
  });

  it('指向某一档时，该模型从低档到高档的标注都保持可见', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage();
    try {
      const multi = await page.evaluate(() => {
        const counts = new Map();
        for (const el of document.querySelectorAll('.pt')) {
          const model = el.getAttribute('data-model');
          counts.set(model, (counts.get(model) || 0) + 1);
        }
        return [...counts.entries()].find(([, n]) => n > 1)?.[0] ?? null;
      });
      assert.ok(multi, '夹具里应有同一模型的多个档位');
      await page.locator(`.pt[data-model="${multi}"]`).first().hover();
      const focus = await page.evaluate((model) => {
        const opacityOf = (el) => Number(getComputedStyle(el).opacity);
        const labels = [...document.querySelectorAll('.lbl')];
        const own = labels.filter((el) => el.getAttribute('data-model') === model);
        const other = labels.filter((el) => el.getAttribute('data-model') !== model);
        return {
          own: own.length,
          ownMatched: own.filter((el) => el.classList.contains('model-match')).length,
          ownVisible: own.every((el) => opacityOf(el) > 0.9),
          otherFaded: other.filter((el) => opacityOf(el) < 0.5).length,
        };
      }, multi);
      assert.ok(focus.own >= 2, '同一模型至少有两个标注');
      assert.equal(focus.ownMatched, focus.own, '指向任一档时，该模型各档标注都应保持匹配');
      assert.equal(focus.ownVisible, true, '该模型的标注不应被淡化');
      assert.ok(focus.otherFaded > 0, '其他模型的标注应让开');
    } finally {
      await context.close();
    }
  });

  it('指标切到输出 token 时预算梯隐藏、X 轴标题随之变化；切回成本后预算梯回来', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage();
    try {
      await page.getByRole('button', { name: '输出 token', exact: true }).click();
      assert.equal(await page.locator('#ladder').isHidden(), true);
      assert.match(await page.locator('#x-title').innerText(), /平均每任务输出 token/);
      assert.equal(await page.locator('.pt').count(), 27);
      await page.getByRole('button', { name: '成本', exact: true }).click();
      assert.equal(await page.locator('.tier').count(), 3);
      assert.match(await page.locator('#x-title').innerText(), /平均每任务成本（美元，实测）/);
    } finally {
      await context.close();
    }
  });

  it('切换到补充视图：横幅 B1、已排除 5 个无公开价格的模型、20 个点、预算梯隐藏', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage();
    try {
      await page.getByRole('button', { name: '补充', exact: true }).click();
      await page.locator('.pt').nth(19).waitFor();
      assert.equal(await page.locator('.pt').count(), 20);
      assert.equal(
        (await page.locator('#banner').innerText()).trim(),
        '分数来自 Artificial Analysis 的独立评测（经 BenchLM 数据集提供），评测设置与官方榜单不同，不可与官方视图直接比较。',
      );
      assert.match(await page.locator('#notes').innerText(), /已排除 5 个无公开价格的模型/);
      assert.match(await page.locator('#x-title').innerText(), /输出单价（美元 \/ 百万 token，不是每任务成本）/);
      assert.match(await page.locator('#legend').innerText(), /◆|官方榜单也收录了此模型（这里的分数来自另一套评测）/);
      assert.match(await page.locator('#info-row').innerText(), /BenchLM 快照日期\s*2026-09-29/);
      assert.equal(await page.locator('#ladder').isHidden(), true);
      assert.equal(await page.locator('.dropdown-btn').innerText().then((s) => s.replace(/\s+/g, '')), '厂商（12/12）▾');
    } finally {
      await context.close();
    }
  });

  describe('同步反馈', () => {
    it('官方数据有更新：已同步，官方数据已更新', async (t) => {
      if (!browser) return t.skip(skipReason);
      await configure({ refresh: 'updated', cooldownSeconds: '0' });
      const { page, context } = await openPage();
      try {
        await page.locator('#sync-btn').click();
        await page.locator('#sync-msg .msg').waitFor();
        assert.equal((await page.locator('#sync-msg').innerText()).trim(), '已同步，官方数据已更新');
        assert.match(await infoText(page), /官方数据更新于\s*2026-09-28/);
      } finally {
        await context.close();
      }
    });

    it('官方数据无更新：已同步，官方数据无更新（仍为 2026-09-21）', async (t) => {
      if (!browser) return t.skip(skipReason);
      await configure({ refresh: 'unchanged', cooldownSeconds: '0' });
      const { page, context } = await openPage();
      try {
        await page.locator('#sync-btn').click();
        await page.locator('#sync-msg .msg').waitFor();
        assert.equal((await page.locator('#sync-msg').innerText()).trim(), '已同步，官方数据无更新（仍为 2026-09-21）');
        assert.equal(await page.locator('#sync-btn').isEnabled(), true, '服务端没给冷却秒数时按钮不禁用');
      } finally {
        await context.close();
      }
    });

    it('冷却中：提示含剩余等待，按钮禁用并显示倒计时', async (t) => {
      if (!browser) return t.skip(skipReason);
      await configure({ refresh: 'cooldown', cooldownSeconds: '90' });
      const { page, context } = await openPage();
      try {
        await page.locator('#sync-btn').click();
        await page.locator('#sync-msg .msg').waitFor();
        assert.equal((await page.locator('#sync-msg').innerText()).trim(), '刚同步过，还需等待 2 分钟');
        const btn = page.locator('#sync-btn');
        assert.equal(await btn.isDisabled(), true);
        const first = await btn.innerText();
        assert.match(first, /^冷却中 1:[0-5]\d$/);
        await page.waitForFunction((was) => document.getElementById('sync-btn').textContent !== was, first, { timeout: 4000 });
        assert.match(await btn.innerText(), /^冷却中 1:[0-5]\d$/);
      } finally {
        await context.close();
      }
    });

    it('失败：显示原因与失败时间，按钮可重试，旧数据保持', async (t) => {
      if (!browser) return t.skip(skipReason);
      await configure({ refresh: 'failed' });
      const { page, context } = await openPage();
      try {
        await page.locator('#sync-btn').click();
        await page.locator('#sync-msg .msg').waitFor();
        const msg = await page.locator('#sync-msg').innerText();
        assert.match(msg, /同步失败（官方榜单：上游返回 429），仍显示旧数据，失败时间 \d{2}:\d{2}:\d{2}/);
        assert.equal(await page.locator('#sync-btn').isEnabled(), true);
        assert.equal(await page.locator('#sync-btn').innerText(), '立即同步');
        assert.equal(await page.locator('.pt').count(), 27);
      } finally {
        await context.close();
      }
    });

    it('同步成功后按钮进入冷却倒计时，倒计时结束后恢复', async (t) => {
      if (!browser) return t.skip(skipReason);
      await configure({ refresh: 'unchanged', cooldownSeconds: '3' });
      const { page, context } = await openPage();
      try {
        await page.locator('#sync-btn').click();
        await page.locator('#sync-msg .msg').waitFor();
        const btn = page.locator('#sync-btn');
        assert.equal(await btn.isDisabled(), true);
        assert.match(await btn.innerText(), /^冷却中 0:0[1-3]$/);
        await page.waitForFunction(() => document.getElementById('sync-btn').textContent === '立即同步', null, { timeout: 8000 });
        assert.equal(await btn.isEnabled(), true);
      } finally {
        await context.close();
      }
    });

    it('同步进行中按钮显示同步中并禁用', async (t) => {
      if (!browser) return t.skip(skipReason);
      await configure({ refresh: 'unchanged', cooldownSeconds: '0', refreshDelayMs: '1200' });
      const { page, context } = await openPage();
      try {
        await page.locator('#sync-btn').click();
        assert.equal(await page.locator('#sync-btn').innerText(), '同步中…');
        assert.equal(await page.locator('#sync-btn').isDisabled(), true);
        await page.locator('#sync-msg .msg').waitFor();
        assert.equal(await page.locator('#sync-btn').innerText(), '立即同步');
      } finally {
        await context.close();
      }
    });
  });

  it('上次同步超过 48 小时：出现陈旧警告与天数；官方数据日期本身旧不警告', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure({ agoHours: '50' });
    const { page, context } = await openPage();
    try {
      const info = await infoText(page);
      assert.match(info, /上次同步\s*2 天前/);
      assert.match(await page.locator('.flag.warn').innerText(), /已超过 48 小时未同步，数据可能已陈旧/);
    } finally {
      await context.close();
    }
    // 对照：同步很新时，官方数据仍是 2026-09-21（已经过去多天）也不应警告。
    await configure({ agoHours: '1' });
    const fresh = await openPage();
    try {
      assert.match(await infoText(fresh.page), /官方数据更新于\s*2026-09-21/);
      assert.equal(await fresh.page.locator('.flag.warn').count(), 0);
    } finally {
      await fresh.context.close();
    }
  });

  it('缓存状态 STALE 或 UPDATING：显示中性文案，不再说上游不可用', async (t) => {
    if (!browser) return t.skip(skipReason);
    for (const cache of ['STALE', 'UPDATING']) {
      await configure({ cache });
      const { page, context } = await openPage();
      try {
        const info = await infoText(page);
        assert.match(info, /正在显示缓存数据，后台更新中/, cache);
        assert.doesNotMatch(info, /上游暂时不可用/, cache);
      } finally {
        await context.close();
      }
    }
    await configure({ cache: 'HIT' });
    const { page, context } = await openPage();
    try {
      assert.doesNotMatch(await infoText(page), /后台更新中/);
    } finally {
      await context.close();
    }
  });

  it('首次加载时显示正在加载数据，同步按钮禁用，加载完成后恢复', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure({ delayMs: '1500' });
    const { page, context } = await openPage({ wait: false });
    try {
      assert.match(await infoText(page), /正在加载数据/);
      assert.equal(await page.locator('#sync-btn').isDisabled(), true);
      assert.equal(await page.locator('.pt').count(), 0);
      await page.locator('.pt').first().waitFor({ timeout: 10000 });
      assert.equal(await page.locator('#sync-btn').isEnabled(), true);
      assert.doesNotMatch(await infoText(page), /正在加载数据/);
    } finally {
      await context.close();
    }
  });

  it('所有 /api 返回 502：显示错误面板与重试，重试后恢复', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure({ api: '502' });
    const { page, context } = await openPage({ wait: false });
    try {
      const panel = page.locator('.state-panel.is-error');
      await panel.waitFor({ timeout: 10000 });
      const text = await panel.innerText();
      assert.match(text, /官方榜单暂时无法加载/);
      assert.match(text, /服务返回 502/);
      assert.equal(await page.locator('.pt').count(), 0);
      assert.equal(await page.locator('#sync-btn').isEnabled(), true);
      assert.match(await infoText(page), /官方榜单数据暂不可用/);

      await configure({ api: 'ok' });
      await panel.getByRole('button', { name: '重试' }).click();
      await page.locator('.pt').first().waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.pt').count(), 27);
      assert.equal(await page.locator('.state-panel.is-error').count(), 0);
    } finally {
      await context.close();
    }
  });

  it('官方榜单 rows 不是数组或含 null 的 200 JSON：显示错误面板而不是卡在正在加载', async (t) => {
    if (!browser) return t.skip(skipReason);
    for (const shape of ['rows-not-array', 'rows-null-item', 'empty-rows']) {
      await configure({ shape });
      const { page, context } = await openPage({ wait: false });
      try {
        const panel = page.locator('.state-panel.is-error');
        await panel.waitFor({ timeout: 10000 });
        assert.match(await panel.innerText(), /官方榜单暂时无法加载/, shape);
        assert.equal(await page.getByText('正在加载官方榜单…').count(), 0, shape);
        assert.doesNotMatch(await infoText(page), /正在加载数据/, shape);
        assert.equal(await page.locator('#sync-btn').isEnabled(), true, shape);
        // 补充视图的数据没有问题，应当照常可用。
        await panel.getByRole('button', { name: '查看补充视图' }).click();
        await page.locator('.pt').first().waitFor();
        assert.equal(await page.locator('.pt').count(), 20, shape);

        await configure({ shape: 'ok' });
        await page.getByRole('button', { name: '官方榜单', exact: true }).click();
        await page.getByRole('button', { name: '重试' }).click();
        await page.locator('.pt').nth(26).waitFor({ timeout: 10000 });
        assert.equal(await page.locator('.pt').count(), 27, shape);
      } finally {
        await context.close();
      }
    }
  });

  it('筛选清空后显示空态且不报错，全选后恢复', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context, errors } = await openPage();
    try {
      const toggle = page.locator('.dropdown-btn');
      assert.equal((await toggle.innerText()).replace(/\s+/g, ''), '配置（27/27）▾');
      await toggle.click();
      await page.getByRole('button', { name: '清空', exact: true }).click();
      await page.getByText('没有选中的配置，请全选或选一个模型').waitFor();
      assert.equal(await page.locator('.pt').count(), 0);
      assert.equal(await page.locator('#ladder').isHidden(), true);
      assert.equal((await toggle.innerText()).replace(/\s+/g, ''), '配置（0/27）▾');

      await page.getByRole('button', { name: '全选', exact: true }).click();
      await page.locator('.pt').nth(26).waitFor();
      assert.equal(await page.locator('.tier').count(), 3);

      // 半选与无数据档位：只勾一个档位后模型变半选；Fable 5 只有 max，其余档位划掉且不可点。
      assert.equal(await page.locator('[data-fk="eff:Fable 5:low"]').isDisabled(), true);
      assert.equal(await page.locator('[data-fk="eff:Fable 5:max"]').isEnabled(), true);
      await page.locator('[data-fk="eff:Opus 5:low"]').click();
      assert.equal(await page.locator('[data-fk="row:Opus 5"]').evaluate((n) => n.indeterminate), true);
      assert.equal(await page.locator('.pt').count(), 26);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it('筛选下拉可完整键盘操作：方向键移动、空格勾选、Escape 关闭并把焦点还给触发按钮', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage();
    try {
      const toggle = page.locator('.dropdown-btn');
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('ArrowDown');
      const first = await page.evaluate(() => document.activeElement?.getAttribute('data-fk'));
      assert.match(first, /^row:/);
      await page.keyboard.press('ArrowDown');
      const second = await page.evaluate(() => document.activeElement?.getAttribute('data-fk'));
      assert.match(second, /^row:/);
      assert.notEqual(second, first);
      await page.keyboard.press('Space');
      assert.match((await toggle.innerText()).replace(/\s+/g, ''), /^配置（\d+\/27）▾$/);
      assert.notEqual((await toggle.innerText()).replace(/\s+/g, ''), '配置（27/27）▾', '空格应切换该模型的勾选');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-fk')), second, '重绘后焦点仍在原控件');
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dropdown-btn')), true);
    } finally {
      await context.close();
    }
  });

  it('主题：手动切换后写入本地存储并在刷新后保持；本地存储不可用时页面照常显示', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage();
    try {
      const themeBtn = page.locator('#theme-btn');
      assert.equal(await themeBtn.innerText(), '主题：跟随系统');
      await themeBtn.click();
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
      await themeBtn.click();
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
      assert.equal(await page.evaluate(() => localStorage.getItem('bv-theme')), 'dark');
      const paperDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(paperDark, 'rgb(7, 20, 28)');
      await page.reload();
      await page.locator('.pt').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
      assert.equal(await themeBtn.innerText(), '主题：深色');
    } finally {
      await context.close();
    }

    const blocked = await openPage({ blockStorage: true });
    try {
      assert.equal(await blocked.page.locator('.pt').count(), 27);
      await blocked.page.locator('#theme-btn').click();
      assert.equal(await blocked.page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
      assert.equal(await blocked.page.locator('.pt').count(), 27);
      assert.deepEqual(blocked.errors, []);
    } finally {
      await blocked.context.close();
    }
  });

  for (const [label, width] of [['手机 360px', 360], ['平板 768px', 768], ['桌面 1300px', 1300]]) {
    it(`${label}：页面不横向滚动（官方与补充视图），预算梯重排`, async (t) => {
      if (!browser) return t.skip(skipReason);
      await configure();
      const { page, context } = await openPage({ viewport: { width, height: 900 } });
      try {
        const overflow = () =>
          page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            wide: [...document.querySelectorAll('body *')]
              .filter((el) => !el.closest('#chart-scroll') && el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
              .map((el) => el.tagName + '.' + el.className)
              .slice(0, 5),
          }));
        let o = await overflow();
        assert.ok(o.page <= 0, `官方视图横向溢出 ${o.page}px：${o.wide.join(', ')}`);
        assert.deepEqual(o.wide, []);

        const rects = await page.evaluate(() => {
          const tiers = [...document.querySelectorAll('.tier')].map((e) => e.getBoundingClientRect());
          const chart = document.getElementById('chart-area').getBoundingClientRect();
          return { tiers, chart: { top: chart.top, bottom: chart.bottom, left: chart.left } };
        });
        assert.ok(rects.tiers.every((r) => r.top >= rects.chart.bottom - 1), '预算档在图的下方');
        if (width > 600 && width <= 1000) assert.ok(Math.abs(rects.tiers[0].top - rects.tiers[2].top) < 2, '平板：三格横排');
        if (width <= 600) assert.ok(rects.tiers[1].top > rects.tiers[0].top, '手机：三档竖排');

        const scroll = await page.evaluate(() => {
          const el = document.getElementById('chart-scroll');
          return { client: el.clientWidth, scroll: el.scrollWidth };
        });
        if (width < 540 + 40) assert.ok(scroll.scroll > scroll.client, '窄屏图表应在容器内横向平移');

        await page.getByRole('button', { name: '补充', exact: true }).click();
        await page.locator('.pt').nth(19).waitFor();
        o = await overflow();
        assert.ok(o.page <= 0, `补充视图横向溢出 ${o.page}px：${o.wide.join(', ')}`);
        assert.deepEqual(o.wide, []);
      } finally {
        await context.close();
      }
    });
  }

  it('prefers-reduced-motion：阶梯线直接画好且没有运行中的动画；对照组会播放动画', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const reduced = await openPage({ reducedMotion: 'reduce' });
    try {
      assert.equal(await reduced.page.locator('.pt').count(), 27);
      const box = await reduced.page.locator('.frontier-line').boundingBox();
      assert.ok(box && box.width > 50 && box.height > 50, '阶梯线应完整可见');
      assert.equal(await reduced.page.evaluate(() => document.getAnimations().length), 0);
      await reduced.page.locator('#sync-btn').click();
      await reduced.page.locator('#sync-msg .msg').waitFor();
      assert.equal(await reduced.page.evaluate(() => document.getAnimations().length), 0, '同步提示不淡入');
      assert.equal(await reduced.page.locator('#sync-btn').isDisabled(), true, '状态线索照旧');
    } finally {
      await reduced.context.close();
    }

    const normal = await openPage({ reducedMotion: 'no-preference', wait: false });
    try {
      await normal.page.waitForFunction(
        () => [...document.getAnimations()].some((a) => a.effect?.target?.classList?.contains('frontier-line')),
        null,
        { timeout: 5000 },
      );
      // 播完之后，筛选引起的重绘不再重播。
      await normal.page.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 5000 });
      await normal.page.getByRole('button', { name: '输出 token', exact: true }).click();
      await normal.page.locator('.pt').first().waitFor();
      assert.equal(
        await normal.page.evaluate(() => [...document.getAnimations()].some((a) => a.effect?.target?.classList?.contains('frontier-line'))),
        false,
      );
    } finally {
      await normal.context.close();
    }
  });

  it('前沿点与点之间以直线连接，前沿点加粗', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context } = await openPage({ reducedMotion: 'reduce' });
    try {
      const d = await page.locator('.frontier-line').getAttribute('d');
      assert.match(d, /^M[\d.,-]+(?:L[\d.,-]+)+$/);
      // 夹具的前沿有 5 个点，点与点之间直接以直线相连，共 4 段直线。
      assert.equal((d.match(/L/g) ?? []).length, 4);
      const widths = await page.locator('.pt-mark').evaluateAll((els) => els.map((e) => Number(e.getAttribute('stroke-width'))));
      assert.equal(widths.filter((w) => w === 3).length, 5);
    } finally {
      await context.close();
    }
  });

  it('最优前沿一直画着，图例不能把它关掉', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context, errors } = await openPage();
    try {
      assert.equal(await page.locator('.frontier-toggle').count(), 0);
      assert.equal(await page.locator('.frontier-line').isVisible(), true);
      await page.locator('.frontier-key').click();
      assert.equal(await page.locator('.frontier-line').isVisible(), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it('图例分行显示且厂商芯片支持反复点击隐藏与重新显示', async (t) => {
    if (!browser) return t.skip(skipReason);
    await configure();
    const { page, context, errors } = await openPage();
    try {
      // 1. 结构与分行验证：最优前沿规则在第一行，厂商在第二行
      const rulesRow = page.locator('#legend .legend-rules');
      const vendorsRow = page.locator('#legend .legend-vendors');
      assert.equal(await rulesRow.count(), 1, '应有 .legend-rules 行');
      assert.equal(await vendorsRow.count(), 1, '应有 .legend-vendors 行');

      const rulesBox = await rulesRow.boundingBox();
      const vendorsBox = await vendorsRow.boundingBox();
      assert.ok(rulesBox.y < vendorsBox.y, '最优前沿规则行应在厂商行上方');

      const vendorChips = page.locator('#legend .vendor-chip');
      const chipCount = await vendorChips.count();
      assert.ok(chipCount >= 2, '至少应有 2 个厂商芯片');
      const firstChip = vendorChips.first();
      const vendorName = await firstChip.getAttribute('data-vendor');
      const initialPointsCount = await page.locator(`.pt[data-org="${vendorName}"]`).count();
      assert.ok(initialPointsCount > 0, `初态应有 ${vendorName} 的点`);
      assert.equal(await firstChip.evaluate((el) => el.tagName), 'SPAN', '官方图例只标颜色，不筛选');
      await firstChip.click();
      assert.equal(await page.locator(`.pt[data-org="${vendorName}"]`).count(), initialPointsCount, '点击官方厂商图例不应改变筛选');

      // 3. 补充视图：同样支持两行与厂商芯片反复切换
      await page.getByRole('button', { name: '补充', exact: true }).click();
      await page.locator('.pt').nth(19).waitFor();

      const suppRulesRow = page.locator('#legend .legend-rules');
      const suppVendorsRow = page.locator('#legend .legend-vendors');
      assert.equal(await suppRulesRow.count(), 1);
      assert.equal(await suppVendorsRow.count(), 1);

      const suppChips = page.locator('#legend .vendor-chip');
      const suppChipCount = await suppChips.count();
      const suppFirstChip = suppChips.first();
      const suppVendor = await suppFirstChip.getAttribute('data-vendor');

      await suppFirstChip.click();
      assert.equal(await suppChips.count(), suppChipCount, '补充视图隐藏后芯片数量不变');
      assert.equal(await suppFirstChip.getAttribute('aria-pressed'), 'false');

      await suppFirstChip.click();
      assert.equal(await suppChips.count(), suppChipCount);
      assert.equal(await suppFirstChip.getAttribute('aria-pressed'), 'true');

      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  // 散点图标签几何与避让测试（真实验收）：
  // 1. 越界裁切必须严格为 0：不仅落在 SVG 内部，且落在 #chart-scroll 当前可视区域内的标签，笔画绝对不能被滚动视口边缘切掉。
  // 2. 两个标签文字笔画绝对不得相交（零重叠，删除 15% 容忍度例外）。
  // 3. 覆盖 360px、768px、1300px 三种宽度，官方视图与补充视图，浅色与深色。
  for (const [viewMode, switchBtn] of [
    ['官方视图', null],
    ['补充视图', '补充'],
  ]) {
    for (const [vpLabel, width] of [
      ['窄屏 360px', 360],
      ['平板 768px', 768],
      ['宽屏 1300px', 1300],
    ]) {
      for (const theme of ['light', 'dark']) {
        it(`散点图标签避让与边界：${viewMode}在${vpLabel}（${theme}）下文字不被切且零重叠`, async (t) => {
          if (!browser) return t.skip(skipReason);
          await configure();
          const { page, context } = await openPage({ viewport: { width, height: 900 }, colorScheme: theme });
          try {
            if (theme === 'dark') {
              await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
            } else {
              await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
            }

            const evaluateLabels = () => {
              const svg = document.querySelector('#chart svg');
              if (!svg) return { error: '未找到 #chart svg' };
              const scrollBox = document.querySelector('#chart-scroll');
              if (!scrollBox) return { error: '未找到 #chart-scroll' };

              const svgRect = svg.getBoundingClientRect();
              const scrollRect = scrollBox.getBoundingClientRect();
              const lbls = [...svg.querySelectorAll('.lbl')];
              if (lbls.length === 0) return { error: '未找到 .lbl' };

              const tolerance = 1;
              const boxes = lbls.map((el) => {
                const r = el.getBoundingClientRect();
                const text = el.textContent.trim().replace(/\s+/g, ' ');
                return {
                  text,
                  screenLeft: r.left,
                  screenRight: r.right,
                  screenTop: r.top,
                  screenBottom: r.bottom,
                  left: r.left - svgRect.left,
                  top: r.top - svgRect.top,
                  right: r.right - svgRect.left,
                  bottom: r.bottom - svgRect.top,
                  width: r.width,
                  height: r.height,
                  area: r.width * r.height,
                };
              });

              // 1. SVG 画布边界检查
              const svgOverflows = [];
              for (const b of boxes) {
                const leftOverflow = -b.left;
                const rightOverflow = b.right - svgRect.width;
                const topOverflow = -b.top;
                const bottomOverflow = b.bottom - svgRect.height;
                if (leftOverflow > tolerance || rightOverflow > tolerance || topOverflow > tolerance || bottomOverflow > tolerance) {
                  svgOverflows.push({
                    text: b.text,
                    box: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
                    overflow: {
                      left: Math.max(0, leftOverflow),
                      right: Math.max(0, rightOverflow),
                      top: Math.max(0, topOverflow),
                      bottom: Math.max(0, bottomOverflow),
                    },
                  });
                }
              }

              // 2. #chart-scroll 滚动可见区域检查：
              // 如果标签与当前视口水平投影相交，其文字笔画必须完整位于可视窗口内，绝不能被可视边界切成半截
              const scrollEdgeClipped = [];
              for (const b of boxes) {
                const inViewWindow = b.screenRight > scrollRect.left + tolerance && b.screenLeft < scrollRect.right - tolerance;
                if (inViewWindow) {
                  const leftClipped = scrollRect.left - b.screenLeft;
                  const rightClipped = b.screenRight - scrollRect.right;
                  if (leftClipped > tolerance || rightClipped > tolerance) {
                    scrollEdgeClipped.push({
                      text: b.text,
                      leftClipped: Math.max(0, leftClipped),
                      rightClipped: Math.max(0, rightClipped),
                    });
                  }
                }
              }

              // 3. 标签两两重叠检查：绝对零重叠，笔画不得相交
              const overlaps = [];
              for (let i = 0; i < boxes.length; i++) {
                for (let j = i + 1; j < boxes.length; j++) {
                  const a = boxes[i];
                  const b = boxes[j];
                  const interLeft = Math.max(a.screenLeft, b.screenLeft);
                  const interRight = Math.min(a.screenRight, b.screenRight);
                  const interTop = Math.max(a.screenTop, b.screenTop);
                  const interBottom = Math.min(a.screenBottom, b.screenBottom);
                  if (interRight - interLeft > tolerance && interBottom - interTop > tolerance) {
                    const interArea = (interRight - interLeft) * (interBottom - interTop);
                    overlaps.push({
                      a: a.text,
                      b: b.text,
                      interArea,
                    });
                  }
                }
              }

              return {
                svgSize: { width: svgRect.width, height: svgRect.height },
                scrollSize: { width: scrollRect.width, height: scrollRect.height },
                labelCount: boxes.length,
                svgOverflows,
                scrollEdgeClipped,
                overlaps,
              };
            };

            const checkView = async (sceneName) => {
              const result = await page.evaluate(evaluateLabels);
              assert.ok(!result.error, `${sceneName}：${result.error}`);
              assert.equal(
                result.svgOverflows.length,
                0,
                `${sceneName}存在越界出 SVG 画布的标签 (${result.svgOverflows.length} 个): ${JSON.stringify(result.svgOverflows)}`,
              );
              assert.equal(
                result.scrollEdgeClipped.length,
                0,
                `${sceneName}存在被 #chart-scroll 边缘切断的标签 (${result.scrollEdgeClipped.length} 个): ${JSON.stringify(result.scrollEdgeClipped)}`,
              );
              assert.equal(
                result.overlaps.length,
                0,
                `${sceneName}存在重叠相交的标签对 (${result.overlaps.length} 对): ${JSON.stringify(result.overlaps)}`,
              );
            };

            if (switchBtn) {
              await page.getByRole('button', { name: switchBtn, exact: true }).click();
              await page.locator('.pt').nth(19).waitFor();
              await checkView('补充视图');
            } else {
              await page.locator('.pt').nth(26).waitFor();
              await checkView('官方成本视图');
            }
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});

