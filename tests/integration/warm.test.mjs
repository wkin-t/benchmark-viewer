// 13. 后台心跳：无人访问时缓存也按周期被触碰，而不是停在过期快照上。
// 多数集成用例默认 WARM_INTERVAL=0（见 helpers.mjs 的 FAST_ENV），只有这里显式打开验证。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ensureImage, withProxy, waitFor, sleep } from './helpers.mjs';

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
});
