const REFRESH_TIMEOUT_MS = 90 * 1000;
const READ_TIMEOUT_MS = 45 * 1000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时');
    throw new Error('网络错误，无法连接到服务');
  } finally {
    clearTimeout(timer);
  }
}

function parseDateHeader(headers) {
  const raw = headers.get('Date');
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// cache: 'no-store' 是必须的：同步完成后要立刻读到代理里更新过的缓存，而不是浏览器自己的旧副本。
async function getJson(url) {
  const res = await fetchWithTimeout(url, { cache: 'no-store' }, READ_TIMEOUT_MS);
  if (!res.ok) throw new Error(`服务返回 ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('服务返回的内容不是有效的 JSON');
  }
  return {
    data,
    fetchedAt: parseDateHeader(res.headers),
    cacheStatus: res.headers.get('X-Cache-Status'),
  };
}

// 缓存正常过期后的后台更新也会是 STALE/UPDATING，它只说明“正在给旧一点的缓存”，不代表上游故障。
function isStaleStatus(status) {
  return status === 'STALE' || status === 'UPDATING';
}

function olderOf(a, b) {
  if (!a || !b) return a ?? b ?? null;
  return a < b ? a : b;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 上游可能返回 Content-Type 正确但形状不对的 200。视图模型假定 rows 是对象数组，
// 在这里挡住，页面才会走“加载失败 + 重试”，而不是卡在“正在加载”。
function assertLeaderboardShape(data) {
  if (!isPlainObject(data) || !Array.isArray(data.rows)) throw new Error('官方榜单返回的数据格式不正确（rows 不是数组）');
  if (!data.rows.every(isPlainObject)) throw new Error('官方榜单返回的数据格式不正确（rows 中含有无效项）');
}

function assertItemsShape(data, name) {
  if (!isPlainObject(data) || !Array.isArray(data.items)) throw new Error(`${name} 返回的数据格式不正确（items 不是数组）`);
  if (!data.items.every(isPlainObject)) throw new Error(`${name} 返回的数据格式不正确（items 中含有无效项）`);
}

export async function loadLeaderboard() {
  try {
    const { data, fetchedAt, cacheStatus } = await getJson('/api/leaderboard');
    assertLeaderboardShape(data);
    return { ok: true, raw: data, fetchedAt, stale: isStaleStatus(cacheStatus) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// BenchLM 两个文件缺一不可：价格缺失会让整张补充图失真，所以任一失败就整体算失败。
export async function loadBenchlm() {
  try {
    const [models, pricing] = await Promise.all([
      getJson('/api/benchlm/models.json'),
      getJson('/api/benchlm/pricing.json'),
    ]);
    assertItemsShape(models.data, 'BenchLM 模型文件');
    assertItemsShape(pricing.data, 'BenchLM 价格文件');
    return {
      ok: true,
      models: models.data,
      pricing: pricing.data,
      fetchedAt: olderOf(models.fetchedAt, pricing.fetchedAt),
      stale: isStaleStatus(models.cacheStatus) || isStaleStatus(pricing.cacheStatus),
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// 映射表只服务于 ◆ 标记；取不到时补充视图照常画，只是不标记。
export async function loadModelMap() {
  try {
    const { data } = await getJson('data/model-map.json');
    if (!isPlainObject(data)) throw new Error('模型映射表格式不正确');
    return { ok: true, map: data };
  } catch (err) {
    return { ok: false, error: errorMessage(err), map: {} };
  }
}

export async function loadAll() {
  const [leaderboard, benchlm, modelMap] = await Promise.all([
    loadLeaderboard(),
    loadBenchlm(),
    loadModelMap(),
  ]);
  return { leaderboard, benchlm, modelMap };
}

// 网络失败、超时与非 JSON 响应统一折成 { ok:false }，调用方不需要再区分抛出还是返回。
export async function postRefresh() {
  try {
    const res = await fetchWithTimeout('/api/refresh', { method: 'POST', cache: 'no-store' }, REFRESH_TIMEOUT_MS);
    if (!res.ok) return { ok: false, error: `服务返回 ${res.status}` };
    let result;
    try {
      result = await res.json();
    } catch {
      return { ok: false, error: '服务返回的同步结果不是有效的 JSON' };
    }
    if (!isPlainObject(result?.leaderboard) || !isPlainObject(result?.benchlm)) {
      return { ok: false, error: '服务返回的同步结果格式不正确' };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
