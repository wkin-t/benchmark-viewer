// 开发与烟雾测试用静态服务器：没有容器时给前端提供页面、夹具数据和可控的 /api 行为。
// 用法：node tests/smoke/dev-server.mjs [--refresh=unchanged|updated|cooldown|failed]
// 环境变量：PORT（默认 18300）、REFRESH_MODE、FETCHED_AGO_HOURS（“上次同步”距今小时数，默认 0.1）、
//   COOLDOWN_SECONDS（同步后的冷却秒数，默认 90；0 表示响应里不带 retryAfterSeconds）
// 运行中可以 POST /__dev/config?<参数> 改行为（reset=1 先恢复默认）：
//   refresh=unchanged|updated|cooldown|failed   /api/refresh 的结果
//   api=ok|502                                  502 时所有 /api/* 都返回 502
//   shape=ok|rows-not-array|rows-null-item|empty-rows   官方榜单响应的形状（状态码仍是 200 且是 JSON）
//   cache=HIT|STALE|UPDATING                    X-Cache-Status 头
//   agoHours=<数字>  cooldownSeconds=<数字>  delayMs=<毫秒，读接口延迟>  refreshDelayMs=<毫秒>
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const webDir = path.join(root, 'web');
const fixtureDir = path.join(root, 'tests', 'fixtures');

const MODES = ['unchanged', 'updated', 'cooldown', 'failed'];
const API_MODES = ['ok', '502'];
const SHAPES = ['ok', 'rows-not-array', 'rows-null-item', 'empty-rows'];
const CACHE_STATUSES = ['HIT', 'STALE', 'UPDATING'];

const argMode = process.argv.find((a) => a.startsWith('--refresh='))?.slice('--refresh='.length);
const initialMode = argMode ?? process.env.REFRESH_MODE ?? 'unchanged';
if (!MODES.includes(initialMode)) {
  console.error(`未知的刷新模式：${initialMode}（可选 ${MODES.join(' / ')}）`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 18300);

function defaults() {
  return {
    refresh: initialMode,
    api: 'ok',
    shape: 'ok',
    cache: 'HIT',
    agoHours: Number(process.env.FETCHED_AGO_HOURS ?? 0.1),
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 90),
    delayMs: 0,
    refreshDelayMs: 0,
  };
}

let cfg = defaults();
let fetchedAt = new Date(Date.now() - cfg.agoHours * 3600 * 1000);
let leaderboardBump = 0;

function resetState() {
  cfg = defaults();
  fetchedAt = new Date(Date.now() - cfg.agoHours * 3600 * 1000);
  leaderboardBump = 0;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readFixture(name) {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, name), 'utf8'));
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  res.end(payload);
}

function cacheHeaders(date) {
  return { Date: date.toUTCString(), 'X-Cache-Status': cfg.cache };
}

// “updated”模式下让最新一行的更新时间前进，模拟官方发布了新数据。
async function leaderboardBody() {
  const data = await readFixture('leaderboard.json');
  if (leaderboardBump > 0) {
    // 所有行一起前进：官方数据日期取各行更新时间的最大值，只动第一行不一定动得到最大值。
    for (const row of data.rows) {
      row.updated_at = new Date(Date.parse(row.updated_at) + leaderboardBump * 24 * 3600 * 1000).toISOString();
    }
  }
  if (cfg.shape === 'rows-not-array') data.rows = { broken: true };
  if (cfg.shape === 'rows-null-item') data.rows = [null, ...data.rows.slice(1)];
  if (cfg.shape === 'empty-rows') data.rows = [];
  return data;
}

// 与后端约定一致：已刷新的分组也带剩余冷却秒数；冷却值为 0 时不带。
function withRetry(part, seconds) {
  return cfg.cooldownSeconds > 0 ? { ...part, retryAfterSeconds: seconds } : part;
}

async function handleRefresh(res) {
  await sleep(cfg.refreshDelayMs);
  const now = new Date();
  const cd = cfg.cooldownSeconds;
  if (cfg.refresh === 'cooldown') {
    return sendJson(res, 200, {
      leaderboard: { status: 'cooldown', retryAfterSeconds: cd },
      benchlm: { status: 'cooldown', retryAfterSeconds: cd * 6 },
    });
  }
  if (cfg.refresh === 'failed') {
    return sendJson(res, 200, {
      leaderboard: { status: 'failed', error: '上游返回 429' },
      benchlm: withRetry({ status: 'refreshed', fetchedAt: now.toUTCString() }, cd * 6),
    });
  }
  if (cfg.refresh === 'updated') leaderboardBump += 7;
  fetchedAt = now;
  return sendJson(res, 200, {
    leaderboard: withRetry({ status: 'refreshed', fetchedAt: now.toUTCString() }, cd),
    benchlm: withRetry({ status: 'refreshed', fetchedAt: now.toUTCString() }, cd * 6),
  });
}

function applyConfig(params) {
  if (params.get('reset') === '1') resetState();
  const set = (key, allowed) => {
    const value = params.get(key);
    if (value === null) return null;
    if (!allowed.includes(value)) return `${key} 可选：${allowed.join(', ')}`;
    cfg[key] = value;
    return null;
  };
  const numeric = (key) => {
    const raw = params.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return `${key} 必须是非负数`;
    cfg[key] = value;
    return null;
  };
  const errors = [set('refresh', MODES), set('api', API_MODES), set('shape', SHAPES), set('cache', CACHE_STATUSES)];
  errors.push(numeric('agoHours'), numeric('cooldownSeconds'), numeric('delayMs'), numeric('refreshDelayMs'));
  if (params.get('agoHours') !== null) fetchedAt = new Date(Date.now() - cfg.agoHours * 3600 * 1000);
  return errors.find(Boolean) ?? null;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(webDir, rel);
  if (full !== webDir && !full.startsWith(webDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await fs.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;
  try {
    if (pathname === '/healthz') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');

    if (pathname === '/__dev/mode' && req.method === 'POST') {
      const mode = url.searchParams.get('refresh');
      if (!MODES.includes(mode)) return sendJson(res, 400, { error: `可选：${MODES.join(', ')}` });
      cfg.refresh = mode;
      return sendJson(res, 200, { refreshMode: cfg.refresh });
    }
    if (pathname === '/__dev/config' && req.method === 'POST') {
      const problem = applyConfig(url.searchParams);
      if (problem) return sendJson(res, 400, { error: problem });
      return sendJson(res, 200, { ...cfg, fetchedAt: fetchedAt.toISOString() });
    }

    if (pathname.startsWith('/api/') && cfg.api === '502') {
      return sendJson(res, 502, { error: 'Bad Gateway' });
    }

    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      await sleep(cfg.delayMs);
      return sendJson(res, 200, await leaderboardBody(), cacheHeaders(fetchedAt));
    }
    if (pathname === '/api/benchlm/models.json' && req.method === 'GET') {
      await sleep(cfg.delayMs);
      return sendJson(res, 200, await readFixture('models.json'), cacheHeaders(fetchedAt));
    }
    if (pathname === '/api/benchlm/pricing.json' && req.method === 'GET') {
      await sleep(cfg.delayMs);
      return sendJson(res, 200, await readFixture('pricing.json'), cacheHeaders(fetchedAt));
    }
    if (pathname === '/api/refresh') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
      return await handleRefresh(res);
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not Found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message ?? err) });
  }
});

server.listen(port, () => {
  console.log(`dev-server: http://localhost:${port}/  刷新模式=${cfg.refresh}  上次同步=${fetchedAt.toISOString()}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
