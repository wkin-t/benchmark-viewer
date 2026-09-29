// 第 10 项：对真实上游的烟雾测试。默认跳过；REAL_UPSTREAM=1 时才会访问真实第三方服务。
// 验证容器内 DNS、TLS（SNI）、Cloudflare 放行、Set-Cookie 处理后仍能缓存，
// 以及 Date 反映的是"容器拉取时间"而不是 CDN 的当前时间。
// 请求量刻意克制：每个文件只有 首次 + 刷新 两次到达上游（第二次读取应命中缓存）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureImage, startProxy, removeContainer, API, sleep } from './helpers.mjs';

const enabled = process.env.REAL_UPSTREAM === '1';

describe('10. 真实上游烟雾（REAL_UPSTREAM=1 开启）', { skip: enabled ? false : '未设置 REAL_UPSTREAM=1，跳过真实上游访问' }, () => {
  it('两次读取第二次命中且 Date 不变；刷新绕过缓存后 Date 更新', async () => {
    await ensureImage();
    const proxy = await startProxy(null, { useDefaultEnv: true });
    const log = [];
    try {
      const first = {};
      for (const [name, api] of Object.entries(API)) {
        const a = await proxy.get(api);
        const b = await proxy.get(api);
        log.push(`${api}: ${a.status}/${a.headers['x-cache-status']} -> ${b.status}/${b.headers['x-cache-status']} Date ${a.headers.date} -> ${b.headers.date} 大小 ${a.body.length}`);
        assert.equal(a.status, 200, `${api} 首次应为 200`);
        assert.match(a.headers['content-type'], /json/);
        assert.equal(a.headers['x-cache-status'], 'MISS');
        assert.equal(b.headers['x-cache-status'], 'HIT');
        assert.equal(b.headers.date, a.headers.date, `${api} 命中时 Date 不得变化`);
        assert.equal(a.headers['set-cookie'], undefined);
        first[name] = { date: a.headers.date, json: a.json() };
      }
      assert.ok(Array.isArray(first.leaderboard.json.rows) && first.leaderboard.json.rows.length > 0, '官方榜单应有行');
      assert.ok(Array.isArray(first.models.json.items) && first.models.json.items.length > 0);
      assert.ok(Array.isArray(first.pricing.json.items) && first.pricing.json.items.length > 0);

      await sleep(2500);
      const refreshed = await proxy.get('/api/refresh', { method: 'POST' });
      const j = refreshed.json();
      log.push(`refresh: ${JSON.stringify(j)}`);
      assert.equal(j.leaderboard.status, 'refreshed', j.leaderboard.error);
      assert.equal(j.benchlm.status, 'refreshed', j.benchlm.error);

      for (const [name, api] of Object.entries(API)) {
        const r = await proxy.get(api);
        log.push(`${api} 刷新后: ${r.headers['x-cache-status']} Date ${r.headers.date}`);
        assert.equal(r.headers['x-cache-status'], 'HIT');
        assert.ok(Date.parse(r.headers.date) > Date.parse(first[name].date), `${api} 刷新后 Date 应更新`);
      }
    } finally {
      console.log(log.join('\n'));
      await removeContainer(proxy.name);
    }
  });
});
