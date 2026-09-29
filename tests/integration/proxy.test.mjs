import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ensureImage, withProxy, API, sleep, FAILURES, ALL_APIS, LEADERBOARD_BODY, USER_AGENT } from './helpers.mjs';


before(async () => {
  await ensureImage();
});

describe('1. 接口、白名单、方法与请求体', () => {
  it('三个代理接口返回夹具数据，上游收到固定请求', async () => {
    await withProxy({}, async ({ proxy, upstream }) => {
      const lb = await proxy.get(API.leaderboard);
      assert.equal(lb.status, 200);
      assert.match(lb.headers['content-type'], /json/);
      assert.deepEqual(lb.json(), JSON.parse(upstream.fixtures.leaderboard));

      const models = await proxy.get(API.models);
      assert.equal(models.status, 200);
      assert.ok(models.body.equals(upstream.fixtures.models));

      const pricing = await proxy.get(API.pricing);
      assert.equal(pricing.status, 200);
      assert.ok(pricing.body.equals(upstream.fixtures.pricing));

      const [lbReq] = upstream.forKey('leaderboard');
      assert.equal(lbReq.method, 'POST');
      assert.equal(lbReq.pathname, '/functions/v1/leaderboard-read');
      assert.equal(lbReq.body, LEADERBOARD_BODY);
      assert.match(lbReq.headers['content-type'], /^application\/json/);
      assert.equal(lbReq.headers['user-agent'], USER_AGENT);
      assert.equal(lbReq.headers.host, `host.docker.internal:${upstream.port}`);
      assert.equal(lbReq.headers['accept-encoding'], undefined);

      const [mReq] = upstream.forKey('models');
      assert.equal(mReq.method, 'GET');
      assert.equal(mReq.body, '');
      assert.equal(mReq.headers['user-agent'], USER_AGENT);
      const [pReq] = upstream.forKey('pricing');
      assert.equal(pReq.method, 'GET');
      assert.equal(pReq.pathname, '/data/pricing.json');
    });
  });

  it('白名单外路径一律 404，且不会打到上游', async () => {
    await withProxy({}, async ({ proxy, upstream }) => {
      const paths = [
        '/api/', '/api/other', '/api/leaderboard/x', '/api/leaderboard/',
        '/api/benchlm/other.json', '/api/benchlm/', '/api/benchlm/models.json/x',
        '/api/benchlm/models', '/api/benchlm/..%2Fmodels.json', '/api/benchlm/%2e%2e/secret.json',
        '/_refresh/leaderboard', '/_refresh/benchlm/models', '/nope', '/etc/passwd',
      ];
      for (const p of paths) {
        const r = await proxy.get(p);
        assert.equal(r.status, 404, `${p} 应为 404，实际 ${r.status}`);
      }
      assert.equal(upstream.requests.length, 0);
    });
  });

  it('白名单路径上 GET 以外的方法（含 HEAD、OPTIONS）返回 405；GET /api/refresh 也是 405', async () => {
    await withProxy({}, async ({ proxy, upstream }) => {
      for (const p of [API.leaderboard, API.models, API.pricing]) {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
          const r = await proxy.get(p, { method });
          assert.equal(r.status, 405, `${method} ${p}`);
          assert.equal(r.headers.allow, 'GET', `${method} ${p} 的 Allow`);
        }
      }
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
        const r = await proxy.get('/api/refresh', { method });
        assert.equal(r.status, 405, `${method} /api/refresh`);
      }
      assert.equal(upstream.requests.length, 0);
    });
  });

  it('请求体与请求头不能由客户端指定，客户端凭据不转发给上游', async () => {
    await withProxy({}, async ({ proxy, upstream }) => {
      const r = await proxy.get(API.leaderboard, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '30',
          Cookie: 'session=secret',
          Authorization: 'Bearer secret',
          'X-Evil': '1',
        },
        body: '{"package":"evil","page_size":9}',
      });
      assert.equal(r.status, 200);
      const [req] = upstream.forKey('leaderboard');
      assert.equal(req.body, LEADERBOARD_BODY);
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['x-evil'], undefined);
    });
  });

  it('静态首页返回 200', async () => {
    await withProxy({}, async ({ proxy }) => {
      const r = await proxy.get('/');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /html/);
    });
  });
});

describe('2. 缓存命中', () => {
  it('TTL 内上游只收到一次请求，命中时 X-Cache-Status 为 HIT 且 Date 不变', async () => {
    await withProxy({ env: { TTL_LEADERBOARD: '30s', TTL_BENCHLM: '30s' } }, async ({ proxy, upstream }) => {
      for (const [api, key] of [[API.leaderboard, 'leaderboard'], [API.models, 'models'], [API.pricing, 'pricing']]) {
        const first = await proxy.get(api);
        assert.equal(first.status, 200);
        assert.equal(first.headers['x-cache-status'], 'MISS');
        await sleep(1200);
        const second = await proxy.get(api);
        const third = await proxy.get(api);
        assert.equal(second.headers['x-cache-status'], 'HIT');
        assert.equal(third.headers['x-cache-status'], 'HIT');
        assert.equal(second.headers.date, first.headers.date, `${api} 命中时 Date 必须保持首次拉取时间`);
        assert.equal(third.headers.date, first.headers.date);
        assert.ok(second.body.equals(first.body));
        assert.equal(upstream.forKey(key).length, 1, `${api} 上游应只收到一次请求`);
      }
    });
  });

  it('带查询串的请求命中同一缓存条目，且上游收到的请求不带客户端的查询串', async () => {
    await withProxy({ env: { TTL_LEADERBOARD: '30s', TTL_BENCHLM: '30s' } }, async ({ proxy, upstream }) => {
      const plain = await proxy.get(API.models);
      const withQuery = await proxy.get(`${API.models}?x=1&page=2`);
      assert.equal(plain.headers['x-cache-status'], 'MISS');
      assert.equal(withQuery.headers['x-cache-status'], 'HIT');
      const [req] = upstream.forKey('models');
      assert.equal(upstream.forKey('models').length, 1);
      assert.equal(req.search, '');

      const lbFirst = await proxy.get(`${API.leaderboard}?x=1`);
      const lbSecond = await proxy.get(`${API.leaderboard}?y=2`);
      assert.equal(lbFirst.headers['x-cache-status'], 'MISS');
      assert.equal(lbSecond.headers['x-cache-status'], 'HIT');
      const lbReqs = upstream.forKey('leaderboard');
      assert.equal(lbReqs.length, 1);
      assert.equal(lbReqs[0].search, '?apikey=k1&mode=full', '上游查询串只能是配置里写死的那份');
    });
  });

  it('缓存过期后重新向上游取数据', async () => {
    await withProxy({ env: { TTL_BENCHLM: '2s' } }, async ({ proxy, upstream }) => {
      const first = await proxy.get(API.pricing);
      assert.equal(first.headers['x-cache-status'], 'MISS');
      await sleep(3300);
      const after = await proxy.get(API.pricing);
      assert.notEqual(after.headers['x-cache-status'], 'HIT');
      await sleep(600);
      assert.equal(upstream.forKey('pricing').length, 2);
      const again = await proxy.get(API.pricing);
      assert.equal(again.headers['x-cache-status'], 'HIT');
      assert.notEqual(again.headers.date, first.headers.date);
    });
  });
});

describe('3. 上游的 Set-Cookie、Vary、Cache-Control 不影响缓存', () => {
  it('带这些头的响应仍被缓存，且不向客户端下发 cookie 或上游的缓存指令', async () => {
    await withProxy({ env: { TTL_LEADERBOARD: '30s', TTL_BENCHLM: '30s' } }, async ({ proxy, upstream }) => {
      const hostile = {
        'Set-Cookie': ['__cf_bm=abc; Path=/; HttpOnly', 'other=1'],
        Vary: 'Accept-Encoding, Origin',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        Expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
      };
      for (const key of ['leaderboard', 'models', 'pricing']) upstream.set(key, { headers: hostile });

      for (const [api, key] of [[API.leaderboard, 'leaderboard'], [API.models, 'models'], [API.pricing, 'pricing']]) {
        const first = await proxy.get(api);
        const second = await proxy.get(api, { headers: { 'Accept-Encoding': 'identity' } });
        assert.equal(first.status, 200);
        assert.equal(first.headers['x-cache-status'], 'MISS');
        assert.equal(second.headers['x-cache-status'], 'HIT', `${api} 带 Set-Cookie/Vary/Cache-Control 时也应命中`);
        assert.equal(upstream.forKey(key).length, 1);
        for (const r of [first, second]) {
          assert.equal(r.headers['set-cookie'], undefined, '不得向客户端下发上游 cookie');
          assert.equal(r.headers['cache-control'], 'no-cache', '对浏览器只应有 no-cache，不带上游的指令');
          assert.equal(r.headers.expires, undefined);
        }
      }
    });
  });
});

describe('4. 上游异常时返回旧数据、不覆盖缓存', () => {
  for (const [name, { override }] of Object.entries(FAILURES)) {
    it(`缓存过期后上游 ${name}：仍返回旧数据，多次请求后依然是旧数据`, async () => {
      await withProxy({ env: { TTL_LEADERBOARD: '2s', TTL_BENCHLM: '2s' } }, async ({ proxy, upstream }) => {
        const original = {};
        for (const [api] of ALL_APIS) {
          const r = await proxy.get(api);
          assert.equal(r.status, 200);
          original[api] = r;
        }
        await sleep(3300);
        for (const [, key] of ALL_APIS) upstream.set(key, override);

        for (let round = 0; round < 2; round++) {
          for (const [api] of ALL_APIS) {
            const r = await proxy.get(api);
            assert.equal(r.status, 200, `${api} 第 ${round + 1} 轮应返回旧数据`);
            assert.ok(r.body.equals(original[api].body), `${api} 返回的必须是旧数据`);
            assert.equal(r.headers.date, original[api].headers.date, '旧数据的 Date 保持首次拉取时间');
            assert.ok(!r.text.includes('ERR-BODY'));
          }
          await sleep(2500);
        }
        assert.ok(ALL_APIS.every(([, key]) => upstream.forKey(key).length >= 2), '过期后应当确实去上游尝试过');

        upstream.clear();
        for (const [api] of ALL_APIS) {
          const r = await proxy.get(api);
          assert.equal(r.status, 200);
          assert.ok(r.body.equals(original[api].body));
        }
      });
    });

    it(`没有缓存时上游 ${name}：返回错误，且错误响应不会被缓存`, async () => {
      await withProxy({ env: { TTL_LEADERBOARD: '30s', TTL_BENCHLM: '30s' } }, async ({ proxy, upstream }) => {
        for (const [, key] of ALL_APIS) upstream.set(key, override);
        for (const [api] of ALL_APIS) {
          const r = await proxy.get(api);
          assert.equal(r.status, FAILURES[name].noCacheStatus, `${api}`);
          if (name === '非 JSON 的 200' || name === '没有 Content-Type 的 200') {
            assert.ok(!r.text.includes('ERR-BODY'), '不得把上游的非 JSON 页面当数据返回');
          }
        }
        upstream.clear();
        upstream.resetRequests();
        for (const [api, key] of ALL_APIS) {
          const r = await proxy.get(api);
          assert.equal(r.status, 200);
          assert.equal(r.headers['x-cache-status'], 'MISS', '错误响应不得留在缓存里');
          assert.equal(upstream.forKey(key).length, 1);
        }
      });
    });
  }
});

describe('5. 不同 Accept-Encoding 的客户端共用同一缓存条目', () => {
  it('gzip、br、identity、无该头的客户端只触发一次上游请求，上游从不收到 Accept-Encoding', async () => {
    await withProxy({ env: { TTL_BENCHLM: '30s' } }, async ({ proxy, upstream }) => {
      const variants = [{ 'Accept-Encoding': 'gzip' }, { 'Accept-Encoding': 'br' }, { 'Accept-Encoding': 'identity' }, {}];
      const results = [];
      for (const headers of variants) results.push(await proxy.get(API.pricing, { headers }));
      assert.deepEqual(results.map((r) => r.headers['x-cache-status']), ['MISS', 'HIT', 'HIT', 'HIT']);
      for (const r of results) {
        assert.ok(r.body.equals(upstream.fixtures.pricing));
        assert.equal(r.headers.date, results[0].headers.date);
      }
      const reqs = upstream.forKey('pricing');
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0].headers['accept-encoding'], undefined);
    });
  });
});

describe('9. gzip', () => {
  it('客户端接受 gzip 时压缩传输，否则原样传输，内容一致', async () => {
    await withProxy({ env: { TTL_BENCHLM: '30s', TTL_LEADERBOARD: '30s' } }, async ({ proxy, upstream }) => {
      const zipped = await proxy.get(API.models, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(zipped.headers['content-encoding'], 'gzip');
      assert.ok(zipped.rawLength < upstream.fixtures.models.length / 3, `压缩后应明显变小，实际 ${zipped.rawLength}`);
      assert.ok(zipped.body.equals(upstream.fixtures.models));

      const plain = await proxy.get(API.models, { headers: { 'Accept-Encoding': 'identity' } });
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.equal(plain.rawLength, upstream.fixtures.models.length);

      const lb = await proxy.get(API.leaderboard, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(lb.headers['content-encoding'], 'gzip');
      assert.deepEqual(lb.json(), JSON.parse(upstream.fixtures.leaderboard));
    });
  });
});
