import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ensureImage, withProxy, API, sleep, ALL_APIS, LEADERBOARD_BODY } from './helpers.mjs';

before(async () => {
  await ensureImage();
});

describe('10. HEAD 与 OPTIONS 不得改变发往上游的请求，也不得污染缓存', () => {
  const CASES = [[API.leaderboard, 'leaderboard', 'POST'], [API.models, 'models', 'GET'], [API.pricing, 'pricing', 'GET']];
  const LONG = { TTL_LEADERBOARD: '30s', TTL_BENCHLM: '30s' };

  for (const method of ['HEAD', 'OPTIONS']) {
    it(`冷缓存下对三个白名单路径发 ${method}：405、上游收不到任何请求，之后 GET 仍得到完整数据`, async () => {
      await withProxy({ env: LONG }, async ({ proxy, upstream }) => {
        for (const [api] of CASES) {
          const r = await proxy.get(api, { method });
          assert.equal(r.status, 405, `${method} ${api}`);
        }
        assert.equal(upstream.requests.length, 0, `${method} 不应触达上游`);

        const lb = await proxy.get(API.leaderboard);
        assert.equal(lb.status, 200);
        assert.equal(lb.headers['x-cache-status'], 'MISS');
        const expected = JSON.parse(upstream.fixtures.leaderboard);
        assert.deepEqual(lb.json(), expected);
        assert.equal(expected.rows?.length ?? expected.length, 27);
        assert.ok((await proxy.get(API.models)).body.equals(upstream.fixtures.models));
        assert.ok((await proxy.get(API.pricing)).body.equals(upstream.fixtures.pricing));

        for (const [, key, upstreamMethod] of CASES) {
          const reqs = upstream.forKey(key);
          assert.equal(reqs.length, 1, key);
          assert.equal(reqs[0].method, upstreamMethod, `${key} 上游只应收到 ${upstreamMethod}`);
        }
        assert.equal(upstream.forKey('leaderboard')[0].body, LEADERBOARD_BODY);
        assert.equal(upstream.forKey('models')[0].body, '');
      });
    });

    it(`热缓存下 ${method} 同样是 405，缓存内容不变`, async () => {
      await withProxy({ env: LONG }, async ({ proxy, upstream }) => {
        const before = {};
        for (const [api] of CASES) before[api] = await proxy.get(api);
        for (const [api, key] of CASES) {
          assert.equal((await proxy.get(api, { method })).status, 405);
          const after = await proxy.get(api);
          assert.equal(after.headers['x-cache-status'], 'HIT');
          assert.ok(after.body.equals(before[api].body));
          assert.equal(upstream.forKey(key).length, 1);
        }
      });
    });
  }
});

describe('11. 响应头收敛', () => {
  const HOSTILE = {
    Server: 'cloudflare',
    'CF-Ray': '8a1b2c3d4e5f-HKG',
    'CF-Cache-Status': 'DYNAMIC',
    'CF-Mitigated': 'challenge',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'X-Secret',
    'X-Powered-By': 'Express',
    'Alt-Svc': 'h3=":443"; ma=86400',
    'Strict-Transport-Security': 'max-age=31536000',
    'Report-To': '{"group":"cf-nel"}',
    NEL: '{"report_to":"cf-nel"}',
  };
  const LEAKED = ['cf-ray', 'cf-cache-status', 'cf-mitigated', 'access-control-allow-origin', 'access-control-allow-credentials',
    'access-control-expose-headers', 'x-powered-by', 'alt-svc', 'strict-transport-security', 'report-to', 'nel'];
  const hasVersion = (server) => /\d/.test(server ?? '');

  it('代理响应不带版本号形式的 Server，也不带上游的 CF-*、Access-Control-* 等头；保留 Date、Content-Type、X-Cache-Status、Cache-Control', async () => {
    await withProxy({ env: { TTL_LEADERBOARD: '30s', TTL_BENCHLM: '30s' } }, async ({ proxy, upstream }) => {
      for (const key of ['leaderboard', 'models', 'pricing']) upstream.set(key, { headers: HOSTILE });
      for (const [api] of ALL_APIS) {
        for (const expectedStatus of ['MISS', 'HIT']) {
          const r = await proxy.get(api);
          assert.equal(r.status, 200);
          assert.equal(r.headers['x-cache-status'], expectedStatus);
          assert.ok(!hasVersion(r.headers.server), `${api} Server 不得带版本号: ${r.headers.server}`);
          assert.notEqual(r.headers.server, 'cloudflare');
          for (const h of LEAKED) assert.equal(r.headers[h], undefined, `${api} ${expectedStatus} 不应下发 ${h}`);
          const names = Object.keys(r.headers);
          assert.ok(!names.some((h) => h.startsWith('cf-') || h.startsWith('access-control-')), `${api} 响应头: ${names}`);
          assert.match(r.headers.date, /GMT$/);
          assert.match(r.headers['content-type'], /json/);
          assert.equal(r.headers['cache-control'], 'no-cache');
        }
      }
    });
  });

  it('容器自己的响应（静态页、404、405、healthz）的 Server 也不带版本号', async () => {
    await withProxy({}, async ({ proxy }) => {
      for (const [p, method] of [['/', 'GET'], ['/healthz', 'GET'], ['/nope', 'GET'], ['/api/other', 'GET'], [API.models, 'POST']]) {
        const r = await proxy.get(p, { method });
        assert.ok(!hasVersion(r.headers.server), `${method} ${p} Server: ${r.headers.server}`);
      }
    });
  });
});

describe('12. TTL 过期后的 X-Cache-Status 取值', () => {
  const env = { TTL_LEADERBOARD: '2s', TTL_BENCHLM: '2s' };

  for (const [api, key] of ALL_APIS) {
    it(`${api} 上游正常：过期后第一个请求 STALE，后台更新期间的并发请求 UPDATING，更新完成后 HIT 且 Date 与数据更新`, async () => {
      await withProxy({ env }, async ({ proxy, upstream }) => {
        const first = await proxy.get(api);
        assert.equal(first.headers['x-cache-status'], 'MISS');
        await sleep(3300);
        upstream.set(key, { delayMs: 1000, body: JSON.stringify({ items: [], marker: 'fresh' }) });

        const a = await proxy.get(api);
        const b = await proxy.get(api);
        assert.equal(a.headers['x-cache-status'], 'STALE');
        assert.equal(b.headers['x-cache-status'], 'UPDATING');
        for (const r of [a, b]) {
          assert.equal(r.status, 200);
          assert.equal(r.headers.date, first.headers.date, '旧数据的 Date 不变');
          assert.ok(r.body.equals(first.body));
        }

        await sleep(1600);
        const c = await proxy.get(api);
        assert.equal(c.headers['x-cache-status'], 'HIT');
        assert.notEqual(c.headers.date, first.headers.date, '后台更新完成后 Date 变新');
        assert.equal(c.json().marker, 'fresh');
        assert.equal(upstream.forKey(key).length, 2, '并发请求只触发一次后台更新');
      });
    });

    it(`${api} 上游故障（403）：过期后 STALE，更新期间 UPDATING，更新失败后仍是 STALE，Date 与数据始终不变`, async () => {
      await withProxy({ env }, async ({ proxy, upstream }) => {
        const first = await proxy.get(api);
        await sleep(3300);
        upstream.set(key, { status: 403, body: 'ERR-BODY', headers: { 'Content-Type': 'text/html' }, delayMs: 1000 });

        const a = await proxy.get(api);
        const b = await proxy.get(api);
        assert.equal(a.headers['x-cache-status'], 'STALE');
        assert.equal(b.headers['x-cache-status'], 'UPDATING');

        await sleep(1600);
        const c = await proxy.get(api);
        assert.equal(c.headers['x-cache-status'], 'STALE', '更新失败后条目仍是过期的，不会回到 HIT');
        for (const r of [a, b, c]) {
          assert.equal(r.status, 200);
          assert.equal(r.headers.date, first.headers.date);
          assert.ok(r.body.equals(first.body));
        }
      });
    });
  }
});
