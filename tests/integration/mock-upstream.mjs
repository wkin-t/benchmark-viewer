import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixtures = {
  leaderboard: readFileSync(path.join(fixtureDir, 'leaderboard.json')),
  models: readFileSync(path.join(fixtureDir, 'models.json')),
  pricing: readFileSync(path.join(fixtureDir, 'pricing.json')),
};

// 键即"上游接口名"，测试用它给单个文件单独设置故障，互不影响。
export const ROUTES = {
  leaderboard: { method: 'POST', path: '/functions/v1/leaderboard-read', fixture: 'leaderboard' },
  models: { method: 'GET', path: '/data/models.json', fixture: 'models' },
  pricing: { method: 'GET', path: '/data/pricing.json', fixture: 'pricing' },
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * 宿主机上的模拟上游。容器经 host.docker.internal 访问。
 * behavior(key) 返回 { status, headers, body, delayMs, hang } 的覆盖项；未设置时返回夹具。
 */
export async function startMockUpstream() {
  const requests = [];
  const behaviors = new Map();
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const entry = Object.entries(ROUTES).find(([, r]) => r.path === url.pathname);
    const key = entry ? entry[0] : null;
    requests.push({
      key,
      method: req.method,
      url: req.url,
      pathname: url.pathname,
      search: url.search,
      headers: req.headers,
      body,
      at: Date.now(),
    });

    if (!entry || req.method !== entry[1].method) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const override = behaviors.get(key) ?? {};
    if (override.hang) return;
    const send = () => {
      const payload = override.body ?? fixtures[entry[1].fixture];
      const headers = { 'Content-Type': 'application/json', ...(override.headers ?? {}) };
      // 值为 null 表示"不发这个头"，用来模拟缺失 Content-Type 的响应。
      for (const [k, v] of Object.entries(headers)) if (v === null) delete headers[k];
      res.writeHead(override.status ?? 200, headers);
      res.end(payload);
    };
    if (override.delayMs) setTimeout(send, override.delayMs);
    else send();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  const origin = `http://host.docker.internal:${port}`;

  return {
    port,
    origin,
    leaderboardUrl: `${origin}${ROUTES.leaderboard.path}?apikey=k1&mode=full`,
    benchlmBase: `${origin}/data`,
    fixtures,
    requests,
    forKey: (key) => requests.filter((r) => r.key === key),
    set: (key, override) => behaviors.set(key, override),
    clear: (key) => (key ? behaviors.delete(key) : behaviors.clear()),
    resetRequests: () => { requests.length = 0; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
