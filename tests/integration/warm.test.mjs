// 13. 后台心跳：无人访问时缓存也按周期被触碰，而不是停在过期快照上。
// 多数集成用例默认 WARM_INTERVAL=0（见 helpers.mjs 的 FAST_ENV），只有这里显式打开验证。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ensureImage, withProxy, waitFor, sleep, ALL_APIS } from './helpers.mjs';

before(async () => {
  await ensureImage();
});

describe('13. 后台心跳', () => {
  it('启用后无人访问也会周期性触碰三个读接口，让过期缓存被刷新', async () => {
    await withProxy({ env: { WARM_INTERVAL: '2' } }, async ({ upstream }) => {
      // 不主动请求任何数据接口，只等心跳自己把请求打到模拟上游。
      await waitFor(() => upstream.forKey('leaderboard').length > 0, { what: '心跳触达 leaderboard', timeoutMs: 15000 });
      await waitFor(() => upstream.forKey('models').length > 0 && upstream.forKey('pricing').length > 0, {
        what: '心跳触达 BenchLM 两个文件',
        timeoutMs: 15000,
      });
      // 是循环而不是一次性：TTL 3s 过期后，后续心跳会再次触发后台更新打上游。
      const first = upstream.forKey('leaderboard').length;
      await waitFor(() => upstream.forKey('leaderboard').length > first, { what: '后续心跳再次触达上游', timeoutMs: 20000 });
    });
  });

  it('WARM_INTERVAL=0 时没有心跳，无人访问就不碰上游', async () => {
    await withProxy({}, async ({ upstream }) => {
      await sleep(5000);
      assert.equal(upstream.requests.length, 0);
    });
  });

  it('心跳不绕过缓存：TTL 未过期时只打在缓存上，不重复打上游', async () => {
    // 锁住"心跳只制造访问、不强制拉取"这一不变量：长 TTL + 短心跳下，首轮建立缓存后
    // 每轮触碰都应命中缓存；若有人把心跳改到绕过缓存的路径（/_refresh/* 或加 bypass），
    // 上游计数会持续增长，这个用例会失败。
    await withProxy({ env: { TTL_LEADERBOARD: '600s', TTL_BENCHLM: '600s', WARM_INTERVAL: '2' } }, async ({ upstream }) => {
      await waitFor(() => upstream.requests.length >= 3, { what: '首轮建立三个缓存', timeoutMs: 15000 });
      const before = Object.fromEntries(ALL_APIS.map(([, key]) => [key, upstream.forKey(key).length]));
      await sleep(6000); // 心跳至少再跑三轮
      for (const [key, n] of Object.entries(before)) {
        assert.equal(upstream.forKey(key).length, n, `${key} 在 TTL 内不应再次打到上游`);
      }
    });
  });
});
