import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ensureImage, withProxy, API, sleep, FAILURES, ALL_APIS, LEADERBOARD_BODY } from './helpers.mjs';

before(async () => {
  await ensureImage();
});

const REFRESH = '/api/refresh';
const refresh = (proxy) => proxy.get(REFRESH, { method: 'POST', body: '{"ignored":true}', headers: { 'Content-Type': 'application/json' } });
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// 内容不同但仍是合法 JSON，用来区分"读到的是旧缓存还是刷新后的新数据"。
const v2 = (label) => ({ body: JSON.stringify({ items: [], marker: label }) });

async function primeAll(proxy) {
  const out = {};
  for (const [api] of ALL_APIS) out[api] = await proxy.get(api);
  return out;
}

const LONG_TTL = { TTL_LEADERBOARD: '60s', TTL_BENCHLM: '60s' };
const NO_COOLDOWN = { COOLDOWN_LEADERBOARD: '0', COOLDOWN_BENCHLM: '0', COOLDOWN_FAILURE: '0' };

describe('6. 刷新接口', () => {
  it('成功时也带剩余冷却秒数：官方约等于 COOLDOWN_LEADERBOARD，BenchLM 约等于 COOLDOWN_BENCHLM', async () => {
    const env = { ...LONG_TTL, COOLDOWN_LEADERBOARD: '600', COOLDOWN_BENCHLM: '3600', COOLDOWN_FAILURE: '60' };
    await withProxy({ env }, async ({ proxy }) => {
      const j = (await refresh(proxy)).json();
      assert.equal(j.leaderboard.status, 'refreshed');
      assert.equal(j.benchlm.status, 'refreshed');
      for (const [group, cooldown] of [['leaderboard', 600], ['benchlm', 3600]]) {
        const n = j[group].retryAfterSeconds;
        assert.ok(Number.isInteger(n), `${group} retryAfterSeconds 应为整数，实际 ${n}`);
        assert.ok(n >= cooldown - 5 && n <= cooldown, `${group} retryAfterSeconds=${n} 应约等于 ${cooldown}`);
      }
    });
  });

  it('冷却值为 0 时成功响应不带 retryAfterSeconds', async () => {
    await withProxy({ env: { ...LONG_TTL, ...NO_COOLDOWN } }, async ({ proxy }) => {
      const j = (await refresh(proxy)).json();
      assert.equal(j.leaderboard.status, 'refreshed');
      assert.equal(j.benchlm.status, 'refreshed');
      assert.equal('retryAfterSeconds' in j.leaderboard, false);
      assert.equal('retryAfterSeconds' in j.benchlm, false);
    });
  });

  it('两个上游冷却值不同时，各自独立带各自的剩余秒数', async () => {
    await withProxy({ env: { ...LONG_TTL, ...NO_COOLDOWN, COOLDOWN_BENCHLM: '900' } }, async ({ proxy }) => {
      const j = (await refresh(proxy)).json();
      assert.equal('retryAfterSeconds' in j.leaderboard, false);
      assert.ok(j.benchlm.retryAfterSeconds >= 895 && j.benchlm.retryAfterSeconds <= 900);
    });
  });

  it('成功：绕过缓存取新数据并写入同一缓存条目，所有客户端随后读到新数据和新 Date（含 5 的刷新部分）', async () => {
    await withProxy({ env: LONG_TTL }, async ({ proxy, upstream }) => {
      const before = await primeAll(proxy);
      await sleep(1500);
      upstream.set('leaderboard', v2('lb2'));
      upstream.set('models', v2('m2'));
      upstream.set('pricing', v2('p2'));

      const r = await refresh(proxy);
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /json/);
      const j = r.json();
      assert.equal(j.leaderboard.status, 'refreshed');
      assert.equal(j.benchlm.status, 'refreshed');
      assert.match(j.leaderboard.fetchedAt, HTTP_DATE);
      assert.match(j.benchlm.fetchedAt, HTTP_DATE);

      const newDates = {};
      for (const [api, marker] of [[API.leaderboard, 'lb2'], [API.models, 'm2'], [API.pricing, 'p2']]) {
        const gz = await proxy.get(api, { headers: { 'Accept-Encoding': 'gzip' } });
        const plain = await proxy.get(api, { headers: { 'Accept-Encoding': 'identity' } });
        for (const c of [gz, plain]) {
          assert.equal(c.headers['x-cache-status'], 'HIT');
          assert.equal(c.json().marker, marker, `${api} 刷新后应读到新数据`);
        }
        assert.equal(gz.headers.date, plain.headers.date);
        assert.notEqual(gz.headers.date, before[api].headers.date, `${api} 的 Date 应更新为刷新时的拉取时间`);
        newDates[api] = Date.parse(gz.headers.date);
      }
      assert.equal(Date.parse(j.leaderboard.fetchedAt), newDates[API.leaderboard]);
      assert.equal(Date.parse(j.benchlm.fetchedAt), Math.min(newDates[API.models], newDates[API.pricing]), '上次同步取两个 BenchLM 文件中较旧的 Date');

      for (const key of ['leaderboard', 'models', 'pricing']) {
        const reqs = upstream.forKey(key);
        assert.equal(reqs.length, 2, `${key}: 预热一次 + 刷新一次`);
        assert.equal(reqs[1].search, reqs[0].search);
        assert.equal(reqs[1].body, reqs[0].body);
        assert.equal(reqs[1].headers['user-agent'], reqs[0].headers['user-agent']);
        assert.equal(reqs[1].headers['accept-encoding'], undefined);
      }
    });
  });

  it('没有缓存时刷新也能建立缓存', async () => {
    await withProxy({ env: LONG_TTL }, async ({ proxy, upstream }) => {
      const j = (await refresh(proxy)).json();
      assert.equal(j.leaderboard.status, 'refreshed');
      assert.equal(j.benchlm.status, 'refreshed');
      for (const [api, key] of ALL_APIS) {
        const r = await proxy.get(api);
        assert.equal(r.headers['x-cache-status'], 'HIT');
        assert.equal(upstream.forKey(key).length, 1);
      }
    });
  });

  it('冷却：官方与 BenchLM 各自冷却，冷却内返回 cooldown 与剩余秒数且不打上游；BenchLM 冷却内只刷新官方部分', async () => {
    const env = { ...LONG_TTL, COOLDOWN_LEADERBOARD: '4', COOLDOWN_BENCHLM: '7', COOLDOWN_FAILURE: '2' };
    await withProxy({ env }, async ({ proxy, upstream }) => {
      const first = (await refresh(proxy)).json();
      assert.equal(first.leaderboard.status, 'refreshed');
      assert.equal(first.benchlm.status, 'refreshed');

      const second = (await refresh(proxy)).json();
      assert.equal(second.leaderboard.status, 'cooldown');
      assert.equal(second.benchlm.status, 'cooldown');
      assert.ok(Number.isInteger(second.leaderboard.retryAfterSeconds));
      assert.ok(second.leaderboard.retryAfterSeconds >= 1 && second.leaderboard.retryAfterSeconds <= 4);
      assert.ok(second.benchlm.retryAfterSeconds >= 1 && second.benchlm.retryAfterSeconds <= 7);
      assert.equal(second.leaderboard.fetchedAt, undefined);
      for (const key of ['leaderboard', 'models', 'pricing']) assert.equal(upstream.forKey(key).length, 1, `${key} 冷却内不应再打上游`);

      await sleep(4500);
      const third = (await refresh(proxy)).json();
      assert.equal(third.leaderboard.status, 'refreshed', '官方冷却已过');
      assert.equal(third.benchlm.status, 'cooldown', 'BenchLM 冷却还没过');
      assert.ok(third.benchlm.retryAfterSeconds >= 1 && third.benchlm.retryAfterSeconds <= 3);
      assert.equal(upstream.forKey('leaderboard').length, 2);
      assert.equal(upstream.forKey('models').length, 1);
      assert.equal(upstream.forKey('pricing').length, 1);
    });
  });

  it('冷却值为 0 表示无冷却：连续刷新都会打上游', async () => {
    await withProxy({ env: NO_COOLDOWN }, async ({ proxy, upstream }) => {
      for (let i = 0; i < 3; i++) {
        const j = (await refresh(proxy)).json();
        assert.equal(j.leaderboard.status, 'refreshed');
        assert.equal(j.benchlm.status, 'refreshed');
      }
      assert.equal(upstream.forKey('leaderboard').length, 3);
      assert.equal(upstream.forKey('models').length, 3);
      assert.equal(upstream.forKey('pricing').length, 3);
    });
  });

  it('并发的两个刷新只有一个到达上游，另一个得到 cooldown', async () => {
    await withProxy({ env: { ...NO_COOLDOWN, UPSTREAM_READ_TIMEOUT: '5s' } }, async ({ proxy, upstream }) => {
      for (const key of ['leaderboard', 'models', 'pricing']) upstream.set(key, { delayMs: 800 });
      const [a, b] = await Promise.all([refresh(proxy), refresh(proxy)]);
      const results = [a.json(), b.json()];
      for (const group of ['leaderboard', 'benchlm']) {
        const statuses = results.map((r) => r[group].status).sort();
        assert.deepEqual(statuses, ['cooldown', 'refreshed'], `${group}: 一个刷新、一个冷却`);
      }
      assert.equal(upstream.forKey('leaderboard').length, 1);
      assert.equal(upstream.forKey('models').length, 1);
      assert.equal(upstream.forKey('pricing').length, 1);
    });
  });

  for (const [name, { override }] of Object.entries(FAILURES)) {
    it(`官方上游 ${name}：failed，旧缓存不被覆盖，之后按失败冷却，冷却过后可再刷新`, async () => {
      const env = { ...LONG_TTL, ...NO_COOLDOWN, COOLDOWN_FAILURE: '3' };
      await withProxy({ env }, async ({ proxy, upstream }) => {
        const before = await proxy.get(API.leaderboard);
        await sleep(1200);
        upstream.set('leaderboard', override);
        const failed = (await refresh(proxy)).json();
        assert.equal(failed.leaderboard.status, 'failed');
        assert.equal(typeof failed.leaderboard.error, 'string');
        assert.ok(failed.leaderboard.error.length > 0);
        assert.equal(failed.benchlm.status, 'refreshed', '官方失败不影响 BenchLM 部分');

        const after = await proxy.get(API.leaderboard);
        assert.equal(after.headers['x-cache-status'], 'HIT');
        assert.ok(after.body.equals(before.body), '失败不得覆盖旧缓存');
        assert.equal(after.headers.date, before.headers.date);

        const during = (await refresh(proxy)).json();
        assert.equal(during.leaderboard.status, 'cooldown', '失败后进入失败冷却');
        assert.ok(during.leaderboard.retryAfterSeconds >= 1 && during.leaderboard.retryAfterSeconds <= 3);
        assert.equal(during.benchlm.status, 'refreshed', 'BenchLM 冷却为 0，不受官方失败冷却影响');

        await sleep(3500);
        upstream.clear('leaderboard');
        const recovered = (await refresh(proxy)).json();
        assert.equal(recovered.leaderboard.status, 'refreshed');
      });
    });
  }

  for (const failing of ['models', 'pricing']) {
    it(`BenchLM 的 ${failing} 失败则整体算 failed，失败文件的旧缓存不被覆盖`, async () => {
      await withProxy({ env: { ...LONG_TTL, ...NO_COOLDOWN } }, async ({ proxy, upstream }) => {
        const before = await primeAll(proxy);
        await sleep(1200);
        upstream.set(failing, { status: 403, body: 'ERR-BODY', headers: { 'Content-Type': 'text/html' } });
        if (failing === 'pricing') upstream.set('models', v2('m2'));
        const j = (await refresh(proxy)).json();
        if (failing === 'pricing') {
          // 已知限制（plan 4.3 "不覆盖"只对失败的文件成立）：models 先成功，缓存已被更新，无法原子回滚。
          assert.equal((await proxy.get(API.models)).json().marker, 'm2');
        } else {
          assert.equal(upstream.forKey('pricing').length, 1, 'models 失败后不再请求 pricing');
        }
        assert.equal(j.leaderboard.status, 'refreshed');
        assert.equal(j.benchlm.status, 'failed', `${failing} 失败时 BenchLM 整体应为 failed`);
        assert.equal(j.benchlm.fetchedAt, undefined);
        assert.match(j.benchlm.error, /403/);
        const api = failing === 'models' ? API.models : API.pricing;
        const after = await proxy.get(api);
        assert.ok(after.body.equals(before[api].body));
        assert.equal(after.headers.date, before[api].headers.date);
      });
    });
  }

  it('刷新请求的请求体与请求头不会影响发往上游的请求', async () => {
    await withProxy({}, async ({ proxy, upstream }) => {
      await proxy.get(REFRESH, { method: 'POST', body: '{"package":"evil"}', headers: { 'Content-Type': 'application/json', Cookie: 'a=b' } });
      const [req] = upstream.forKey('leaderboard');
      assert.equal(req.body, LEADERBOARD_BODY);
      assert.equal(req.headers.cookie, undefined);
    });
  });
});
