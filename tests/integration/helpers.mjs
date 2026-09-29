import { execFile, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startMockUpstream } from './mock-upstream.mjs';

export const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const IMAGE = 'bv-test-image';

// 出问题时容器名前缀统一为 bv-test-，便于 docker ps --filter name=bv-test 检查残留。
const liveContainers = new Set();
const liveVolumes = new Set();
let counter = 0;

export function docker(args, { allowFail = false, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        reject(new Error(`docker ${args.join(' ')} 失败: ${stderr || err.message}`));
        return;
      }
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

let imageReady = null;
export function ensureImage() {
  imageReady ??= buildImage();
  return imageReady;
}

export async function buildImage() {
  // Docker Desktop 的构建缓存偶发 "parent snapshot does not exist"，重试一次即可恢复。
  try {
    await docker(['build', '-q', '-t', IMAGE, projectRoot]);
  } catch {
    await docker(['build', '-q', '-t', IMAGE, projectRoot]);
  }
}

async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = 18100 + Math.floor(Math.random() * 1900);
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('找不到空闲端口');
}

export function newVolumeName() {
  const name = `bv-test-vol-${process.pid}-${++counter}`;
  liveVolumes.add(name);
  return name;
}

export async function removeVolume(name) {
  await docker(['volume', 'rm', '-f', name], { allowFail: true });
  liveVolumes.delete(name);
}

export async function removeContainer(name) {
  await docker(['rm', '-f', name], { allowFail: true });
  liveContainers.delete(name);
}

async function cleanupAll() {
  for (const n of [...liveContainers]) await removeContainer(n);
  for (const v of [...liveVolumes]) await removeVolume(v);
}

// 测试进程被中断时也尽量不留容器。
process.once('exit', () => {
  for (const n of liveContainers) {
    try { execFileSyncQuiet(['rm', '-f', n]); } catch { /* 退出阶段无法再处理 */ }
  }
});
function execFileSyncQuiet(args) {
  execFileSync('docker', args, { stdio: 'ignore' });
}

export const FAST_ENV = {
  TTL_LEADERBOARD: '3s',
  TTL_BENCHLM: '3s',
  UPSTREAM_CONNECT_TIMEOUT: '2s',
  UPSTREAM_READ_TIMEOUT: '2s',
  COOLDOWN_LEADERBOARD: '0',
  COOLDOWN_BENCHLM: '0',
  COOLDOWN_FAILURE: '0',
};

export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 200, what = '条件' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(intervalMs);
  }
  throw new Error(`等待${what}超时${last ? `: ${last.message}` : ''}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动一个测试容器并等到 /healthz 可用。返回 { name, port, get, request, stop, logs }。
 * volume 传入时把缓存目录挂到该命名卷。
 */
export async function startProxy(upstream, { env = {}, volume = null, useDefaultEnv = false, waitReady = true } = {}) {
  const name = `bv-test-${process.pid}-${++counter}`;
  const port = await freePort();
  // upstream 为 null 表示使用镜像内置的真实上游地址（仅烟雾测试用）。
  const fullEnv = {
    ...(upstream ? { UPSTREAM_LEADERBOARD_URL: upstream.leaderboardUrl, UPSTREAM_BENCHLM_BASE: upstream.benchlmBase } : {}),
    ...(useDefaultEnv ? {} : FAST_ENV),
    ...env,
  };
  const args = ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:80`];
  if (volume) args.push('-v', `${volume}:/var/cache/bv`);
  for (const [k, v] of Object.entries(fullEnv)) {
    if (v === undefined || v === null) continue;
    args.push('-e', `${k}=${v}`);
  }
  args.push(IMAGE);
  liveContainers.add(name);
  await docker(args);
  const proxy = {
    name,
    port,
    request: (opts) => request({ port, ...opts }),
    get: (p, opts = {}) => request({ port, path: p, ...opts }),
    logs: async () => {
      const r = await docker(['logs', name], { allowFail: true });
      return r.stdout + r.stderr;
    },
    exec: (cmd) => docker(['exec', name, ...cmd], { allowFail: true }),
    stop: () => removeContainer(name),
  };
  if (waitReady) {
    try {
      await waitFor(async () => (await proxy.get('/healthz')).status === 200, { what: `容器 ${name} 就绪` });
    } catch (e) {
      const logs = await proxy.logs();
      await removeContainer(name);
      throw new Error(`${e.message}\n容器日志:\n${logs}`);
    }
  }
  return proxy;
}

/** 起模拟上游与容器，跑完 fn 后无论成败都清理。 */
export async function withProxy(options, fn) {
  const upstream = await startMockUpstream();
  let proxy;
  try {
    proxy = await startProxy(upstream, options);
    await fn({ proxy, upstream });
  } finally {
    if (proxy) await removeContainer(proxy.name);
    await upstream.close();
  }
}

export function request({ port, path: p = '/', method = 'GET', headers = {}, body = null, decode = true }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let bodyBuf = raw;
        if (decode && res.headers['content-encoding'] === 'gzip') bodyBuf = zlib.gunzipSync(raw);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawLength: raw.length,
          body: bodyBuf,
          text: bodyBuf.toString('utf8'),
          json() { return JSON.parse(bodyBuf.toString('utf8')); },
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('客户端请求超时')));
    if (body !== null) req.write(body);
    req.end();
  });
}

export const API = {
  leaderboard: '/api/leaderboard',
  models: '/api/benchlm/models.json',
  pricing: '/api/benchlm/pricing.json',
};

export { cleanupAll };

export const LEADERBOARD_BODY = '{"package":"terminal-bench/terminal-bench","name":"4-0-0","page":1,"page_size":100}';
export const USER_AGENT = 'benchmark-viewer/1.0 (internal LAN tool)';

export const FAILURES = {
  403: { override: { status: 403, body: 'ERR-BODY forbidden', headers: { 'Content-Type': 'text/html' } }, noCacheStatus: 403 },
  429: { override: { status: 429, body: 'ERR-BODY slow down', headers: { 'Content-Type': 'text/html' } }, noCacheStatus: 429 },
  500: { override: { status: 500, body: 'ERR-BODY boom', headers: { 'Content-Type': 'text/html' } }, noCacheStatus: 500 },
  timeout: { override: { hang: true }, noCacheStatus: 504 },
  '没有 Content-Type 的 200': { override: { status: 200, body: '<html>ERR-BODY no ctype</html>', headers: { 'Content-Type': null } }, noCacheStatus: 502 },
  '非 JSON 的 200': { override: { status: 200, body: '<html>ERR-BODY maintenance</html>', headers: { 'Content-Type': 'text/html' } }, noCacheStatus: 502 },
};
export const ALL_APIS = [[API.leaderboard, 'leaderboard'], [API.models, 'models'], [API.pricing, 'pricing']];


/** 前台运行一次容器直到它退出（用于校验入口脚本拒绝非法配置），返回退出码与输出。 */
export async function runOnce(env) {
  const name = `bv-test-once-${process.pid}-${++counter}`;
  const args = ['run', '--name', name];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE);
  liveContainers.add(name);
  try {
    const r = await docker(args, { allowFail: true, timeoutMs: 20000 });
    return { code: r.code, output: r.stdout + r.stderr };
  } finally {
    await removeContainer(name);
  }
}
