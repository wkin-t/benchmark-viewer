const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < MIN) return '刚刚';
  if (ms < HOUR) return `${Math.floor(ms / MIN)} 分钟前`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} 小时前`;
  return `${Math.floor(ms / DAY)} 天前`;
}

const WARN_AFTER_MS = 48 * HOUR;

function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function evaluateFreshness({ upstreamUpdatedAtList, fetchedAt, now }) {
  let upstreamUpdatedAt = null;
  for (const item of upstreamUpdatedAtList ?? []) {
    const d = toDate(item);
    if (d && (!upstreamUpdatedAt || d > upstreamUpdatedAt)) upstreamUpdatedAt = d;
  }
  const fetched = toDate(fetchedAt);
  const agoMs = fetched ? toDate(now).getTime() - fetched.getTime() : null;
  return {
    upstreamUpdatedAt,
    fetchedAt: fetched,
    agoMs,
    warn: agoMs !== null && agoMs > WARN_AFTER_MS,
  };
}

const UPSTREAM_NAMES = { leaderboard: '官方榜单', benchlm: 'BenchLM' };

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function waitMinutes(part) {
  return Math.max(1, Math.ceil((part.retryAfterSeconds ?? 0) / 60));
}

// 同步前没有日期说明当时没有官方数据可比（例如页面还没加载完），此时只能陈述"已加载"，不能声称"已更新"。
function officialOutcome(before, after) {
  if (after && !before) return { changed: false, kind: 'loaded', text: `已同步，已加载官方数据（更新于 ${isoDay(after)}）` };
  if (after && after > before) return { changed: true, kind: 'updated', text: '已同步，官方数据已更新' };
  const text = after ? `已同步，官方数据无更新（仍为 ${isoDay(after)}）` : '已同步，官方数据无更新';
  return { changed: false, kind: 'unchanged', text };
}

// 失败优先于冷却：一边失败时用户最需要知道的是原因，而不是另一边在冷却。
export function summarizeRefresh({ beforeUpstreamUpdatedAt, afterUpstreamUpdatedAt, result }) {
  const parts = { leaderboard: result.leaderboard, benchlm: result.benchlm };

  const failures = Object.entries(parts)
    .filter(([, p]) => p.status === 'failed')
    .map(([name, p]) => `${UPSTREAM_NAMES[name]}：${p.error || '未知原因'}`);
  if (failures.length > 0) {
    return { kind: 'failed', text: `同步失败（${failures.join('；')}），仍显示旧数据` };
  }

  const { leaderboard, benchlm } = parts;
  if (leaderboard.status === 'cooldown') {
    if (benchlm.status === 'cooldown') {
      return { kind: 'cooldown', text: `刚同步过，还需等待 ${waitMinutes(leaderboard)} 分钟` };
    }
    return { kind: 'partial', text: `官方榜单刚同步过，还需等待 ${waitMinutes(leaderboard)} 分钟；BenchLM 已刷新` };
  }

  const { kind, text: official } = officialOutcome(beforeUpstreamUpdatedAt, afterUpstreamUpdatedAt);
  if (benchlm.status === 'cooldown') {
    return { kind: 'partial', text: `${official}；BenchLM 冷却中，只刷新了官方部分` };
  }
  return { kind, text: official };
}
