import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureImage, withProxy, startProxy, API, sleep, docker, waitFor, newVolumeName, removeVolume,
  removeContainer, runOnce, ALL_APIS, FAST_ENV,
} from './helpers.mjs';
import { startMockUpstream } from './mock-upstream.mjs';

before(async () => {
  await ensureImage();
});

async function renderedConfig(proxy) {
  const r = await proxy.exec(['cat', '/usr/local/openresty/nginx/conf/nginx.conf']);
  assert.equal(r.code, 0);
  return r.stdout;
}

describe('7. 容器重启（同一命名卷）后仍可回退旧数据', () => {
  it('上游返回 403 或完全不可达时，新容器仍从命名卷返回旧数据', async () => {
    const volume = newVolumeName();
    const upstream = await startMockUpstream();
    let closed = false;
    try {
      const env = { TTL_LEADERBOARD: '2s', TTL_BENCHLM: '2s' };
      const first = await startProxy(upstream, { env, volume });
      const original = {};
      for (const [api] of ALL_APIS) original[api] = await first.get(api);
      await first.stop();
      await sleep(2500);

      for (const key of ['leaderboard', 'models', 'pricing']) {
        upstream.set(key, { status: 403, body: 'ERR-BODY', headers: { 'Content-Type': 'text/html' } });
      }
      const second = await startProxy(upstream, { env, volume });
      for (const [api] of ALL_APIS) {
        const r = await second.get(api);
        assert.equal(r.status, 200, `${api} 重启后上游 403 应回退旧数据`);
        assert.ok(r.body.equals(original[api].body));
        assert.equal(r.headers.date, original[api].headers.date);
      }
      await second.stop();

      await upstream.close();
      closed = true;
      const third = await startProxy(upstream, { env, volume });
      for (const [api] of ALL_APIS) {
        const r = await third.get(api);
        assert.equal(r.status, 200, `${api} 重启后上游不可达应回退旧数据`);
        assert.ok(r.body.equals(original[api].body));
      }
      await third.stop();
    } finally {
      if (!closed) await upstream.close();
      await removeVolume(volume);
    }
  });

  it('CACHE_INACTIVE 默认 3650d 且没有 max_size；缓存目录是命名卷，镜像没有匿名 VOLUME', async () => {
    const upstream = await startMockUpstream();
    const volume = newVolumeName();
    let proxy;
    try {
      proxy = await startProxy(upstream, { env: { ...FAST_ENV }, volume });
      const conf = await renderedConfig(proxy);
      const line = conf.split('\n').find((l) => l.includes('proxy_cache_path'));
      assert.match(line, /inactive=3650d/);
      assert.doesNotMatch(line, /max_size/);
      assert.match(line, /\/var\/cache\/bv/);

      const inspect = JSON.parse((await docker(['inspect', proxy.name])).stdout)[0];
      assert.deepEqual(inspect.Mounts.map((m) => [m.Type, m.Name, m.Destination]), [['volume', volume, '/var/cache/bv']]);

      const image = JSON.parse((await docker(['image', 'inspect', 'bv-test-image'])).stdout)[0];
      assert.ok(!image.Config.Volumes || Object.keys(image.Config.Volumes).length === 0, '镜像不得声明匿名 VOLUME');
    } finally {
      if (proxy) await removeContainer(proxy.name);
      await upstream.close();
      await removeVolume(volume);
    }
  });

  it('CACHE_INACTIVE 可以覆盖', async () => {
    await withProxy({ env: { CACHE_INACTIVE: '30d' } }, async ({ proxy }) => {
      const line = (await renderedConfig(proxy)).split('\n').find((l) => l.includes('proxy_cache_path'));
      assert.match(line, /inactive=30d/);
    });
  });
});

describe('8. 环境变量注入', () => {
  it('上游 URL 含 & 与查询串时原样到达上游；BenchLM 基址的尾部斜杠被规整', async () => {
    await withProxy({}, async ({ proxy, upstream }) => {
      // 默认夹具 URL 已含 ?apikey=k1&mode=full，此处再验证 BenchLM 尾斜杠与百分号编码
      await proxy.get(API.leaderboard);
      assert.equal(upstream.forKey('leaderboard')[0].search, '?apikey=k1&mode=full');
    });

    const upstream = await startMockUpstream();
    let proxy;
    try {
      proxy = await startProxy(upstream, {
        env: {
          UPSTREAM_LEADERBOARD_URL: `${upstream.origin}/functions/v1/leaderboard-read?a=1&b=x%20y&c=p+q&d=1,2`,
          UPSTREAM_BENCHLM_BASE: `${upstream.origin}/data///`,
        },
      });
      const lb = await proxy.get(API.leaderboard);
      const m = await proxy.get(API.models);
      assert.equal(lb.status, 200);
      assert.equal(m.status, 200);
      assert.equal(upstream.forKey('leaderboard')[0].search, '?a=1&b=x%20y&c=p+q&d=1,2');
      assert.equal(upstream.forKey('models')[0].pathname, '/data/models.json');
      assert.equal(upstream.forKey('models')[0].url, '/data/models.json');
    } finally {
      if (proxy) await removeContainer(proxy.name);
      await upstream.close();
    }
  });

  const BAD = [
    ['UPSTREAM_LEADERBOARD_URL', 'http://x/y;evil'],
    ['UPSTREAM_LEADERBOARD_URL', 'http://x/y z'],
    ['UPSTREAM_LEADERBOARD_URL', 'http://x/y"z'],
    ['UPSTREAM_LEADERBOARD_URL', 'http://x/$host'],
    ['UPSTREAM_LEADERBOARD_URL', 'http://x/y#frag'],
    ['UPSTREAM_LEADERBOARD_URL', 'ftp://x/y'],
    ['UPSTREAM_BENCHLM_BASE', 'http://x/data}{'],
    ['UPSTREAM_BENCHLM_BASE', 'http://x/data?k=v'],
    ['TTL_LEADERBOARD', '6h; evil'],
    ['TTL_BENCHLM', 'abc'],
    ['CACHE_INACTIVE', '10'],
    ['UPSTREAM_CONNECT_TIMEOUT', '1500ms'],
    ['UPSTREAM_READ_TIMEOUT', '30'],
    ['COOLDOWN_LEADERBOARD', '-1'],
    ['COOLDOWN_BENCHLM', '1.5'],
    ['COOLDOWN_FAILURE', '60; evil'],
  ];
  it('不安全或格式错误的环境变量被入口脚本拒绝，容器不启动', async () => {
    const upstream = await startMockUpstream();
    try {
      const chunks = [];
      for (let i = 0; i < BAD.length; i += 4) chunks.push(BAD.slice(i, i + 4));
      for (const chunk of chunks) {
        const results = await Promise.all(chunk.map(([name, value]) => runOnce({
          UPSTREAM_LEADERBOARD_URL: upstream.leaderboardUrl,
          UPSTREAM_BENCHLM_BASE: upstream.benchlmBase,
          [name]: value,
        })));
        results.forEach((r, i) => {
          const [name, value] = chunk[i];
          assert.notEqual(r.code, 0, `${name}=${JSON.stringify(value)} 应被拒绝`);
          assert.match(r.output, new RegExp(name), `${name} 的错误信息应指明变量名`);
        });
      }
    } finally {
      await upstream.close();
    }
  });
});

describe('9. 健康检查与启动', () => {
  it('HEALTHCHECK 使用 wget 访问 127.0.0.1/healthz 并最终 healthy', async () => {
    await withProxy({}, async ({ proxy }) => {
      const inspect = JSON.parse((await docker(['inspect', proxy.name])).stdout)[0];
      assert.deepEqual(inspect.Config.Healthcheck.Test, ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1/healthz']);
      const exec = await proxy.exec(['wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/healthz']);
      assert.equal(exec.code, 0);
      await waitFor(async () => {
        const s = JSON.parse((await docker(['inspect', proxy.name])).stdout)[0].State.Health.Status;
        return s === 'healthy';
      }, { timeoutMs: 40000, intervalMs: 1000, what: '容器 healthy' });
    });
  });

  it('resolver 取自容器的 /etc/resolv.conf', async () => {
    await withProxy({}, async ({ proxy }) => {
      const conf = await renderedConfig(proxy);
      const resolverLine = conf.split('\n').find((l) => /^\s*resolver\s/.test(l));
      const resolv = (await proxy.exec(['cat', '/etc/resolv.conf'])).stdout;
      const nameservers = resolv.split('\n').map((l) => l.trim().match(/^nameserver\s+(\S+)/)?.[1]).filter(Boolean);
      assert.ok(nameservers.length > 0);
      for (const ns of nameservers) assert.ok(resolverLine.includes(ns), `resolver 行应包含 ${ns}: ${resolverLine}`);
      assert.match(resolverLine, /valid=30s/);
      assert.match(resolverLine, /ipv6=off/);
    });
  });

  it('冷却值渲染进 init_by_lua_block 常量', async () => {
    await withProxy({ env: { COOLDOWN_LEADERBOARD: '11', COOLDOWN_BENCHLM: '22', COOLDOWN_FAILURE: '33' } }, async ({ proxy }) => {
      const conf = await renderedConfig(proxy);
      assert.match(conf, /leaderboard = 11,/);
      assert.match(conf, /benchlm = 22,/);
      assert.match(conf, /failure = 33,/);
    });
  });

  it('缓存锁等待时间不小于 连接超时 + 读取超时（默认 35 秒以上）', async () => {
    const upstream = await startMockUpstream();
    let proxy;
    try {
      proxy = await startProxy(upstream, { useDefaultEnv: true });
      const conf = await renderedConfig(proxy);
      const lock = Number(conf.match(/proxy_cache_lock_timeout (\d+)s;/)[1]);
      const age = Number(conf.match(/proxy_cache_lock_age (\d+)s;/)[1]);
      assert.ok(lock >= 35 && age >= 35, `lock=${lock} age=${age}`);
      assert.match(conf, /proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504 http_403 http_429;/);
      assert.match(conf, /proxy_connect_timeout 5s;/);
      assert.match(conf, /proxy_read_timeout 30s;/);
      assert.match(conf, /inactive=3650d/);
    } finally {
      if (proxy) await removeContainer(proxy.name);
      await upstream.close();
    }
  });
});
