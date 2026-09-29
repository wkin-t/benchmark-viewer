import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgo, evaluateFreshness, summarizeRefresh } from '../../web/js/freshness.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatAgo: 不足 1 分钟与负值都显示刚刚', () => {
  assert.equal(formatAgo(0), '刚刚');
  assert.equal(formatAgo(59 * 1000), '刚刚');
  assert.equal(formatAgo(-5 * MIN), '刚刚');
});

test('formatAgo: 分钟档向下取整，59 分钟仍是分钟', () => {
  assert.equal(formatAgo(60 * 1000), '1 分钟前');
  assert.equal(formatAgo(5 * MIN + 30 * 1000), '5 分钟前');
  assert.equal(formatAgo(59 * MIN + 59 * 1000), '59 分钟前');
});

test('formatAgo: 小时档，24 小时以内', () => {
  assert.equal(formatAgo(60 * MIN), '1 小时前');
  assert.equal(formatAgo(90 * MIN), '1 小时前');
  assert.equal(formatAgo(23 * HOUR + 59 * MIN), '23 小时前');
});

test('formatAgo: 天档，满 24 小时起', () => {
  assert.equal(formatAgo(24 * HOUR), '1 天前');
  assert.equal(formatAgo(47 * HOUR), '1 天前');
  assert.equal(formatAgo(3 * DAY + 5 * HOUR), '3 天前');
});

test('formatAgo: 非有限数按刚刚处理，不输出 NaN', () => {
  assert.equal(formatAgo(NaN), '刚刚');
  assert.equal(formatAgo(undefined), '刚刚');
});

test('evaluateFreshness: 官方更新时间取各行最大值，与输入顺序无关', () => {
  const r = evaluateFreshness({
    upstreamUpdatedAtList: ['2026-09-10T21:58:00.001022+00:00', '2026-09-21T21:28:10.802412+00:00', '2026-09-03T00:09:00.046808+00:00'],
    fetchedAt: '2026-09-29T00:00:00Z',
    now: new Date('2026-09-29T01:00:00Z'),
  });
  assert.equal(r.upstreamUpdatedAt.toISOString(), '2026-09-21T21:28:10.802Z');
});

test('evaluateFreshness: 空列表与非法日期得到 null', () => {
  const now = new Date('2026-09-29T01:00:00Z');
  assert.equal(evaluateFreshness({ upstreamUpdatedAtList: [], fetchedAt: null, now }).upstreamUpdatedAt, null);
  assert.equal(evaluateFreshness({ upstreamUpdatedAtList: ['not-a-date', null], fetchedAt: null, now }).upstreamUpdatedAt, null);
  assert.equal(evaluateFreshness({ upstreamUpdatedAtList: ['not-a-date', '2026-09-01T00:00:00Z'], fetchedAt: null, now }).upstreamUpdatedAt.toISOString(), '2026-09-01T00:00:00.000Z');
});

test('evaluateFreshness: 恰好 48 小时不警告，多 1 毫秒才警告', () => {
  const fetchedAt = new Date('2026-09-27T00:00:00Z');
  const at48h = evaluateFreshness({ upstreamUpdatedAtList: [], fetchedAt, now: new Date('2026-09-29T00:00:00Z') });
  assert.equal(at48h.agoMs, 48 * 3600 * 1000);
  assert.equal(at48h.warn, false);
  const over = evaluateFreshness({ upstreamUpdatedAtList: [], fetchedAt, now: new Date('2026-09-29T00:00:00.001Z') });
  assert.equal(over.warn, true);
});

test('evaluateFreshness: 官方数据很旧但同步很新时不警告', () => {
  const r = evaluateFreshness({
    upstreamUpdatedAtList: ['2026-01-01T00:00:00Z'],
    fetchedAt: '2026-09-29T00:30:00Z',
    now: new Date('2026-09-29T01:00:00Z'),
  });
  assert.equal(r.warn, false);
  assert.equal(r.agoMs, 30 * 60 * 1000);
});

test('evaluateFreshness: fetchedAt 为空时不警告且 fetchedAt 与 agoMs 为 null', () => {
  for (const empty of [null, undefined, '']) {
    const r = evaluateFreshness({ upstreamUpdatedAtList: [], fetchedAt: empty, now: new Date('2026-09-29T01:00:00Z') });
    assert.equal(r.warn, false);
    assert.equal(r.fetchedAt, null);
    assert.equal(r.agoMs, null);
  }
});

test('evaluateFreshness: fetchedAt 可以是 HTTP-date（代理 Date 头的格式）', () => {
  const r = evaluateFreshness({
    upstreamUpdatedAtList: [],
    fetchedAt: 'Tue, 29 Sep 2026 00:00:00 GMT',
    now: new Date('2026-09-29T00:10:00Z'),
  });
  assert.equal(r.fetchedAt.toISOString(), '2026-09-29T00:00:00.000Z');
  assert.equal(r.agoMs, 10 * 60 * 1000);
});

test('evaluateFreshness: fetchedAt 无法解析时按空处理', () => {
  const r = evaluateFreshness({ upstreamUpdatedAtList: [], fetchedAt: 'garbage', now: new Date('2026-09-29T00:10:00Z') });
  assert.equal(r.fetchedAt, null);
  assert.equal(r.warn, false);
});

const D1 = new Date('2026-09-21T21:28:10.802Z');
const D2 = new Date('2026-09-25T08:00:00Z');
const ok = { status: 'refreshed', fetchedAt: 'Tue, 29 Sep 2026 00:00:00 GMT' };

test('summarizeRefresh: 两边都刷新且官方时间未变 -> unchanged 并带日期', () => {
  const r = summarizeRefresh({ beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1, result: { leaderboard: ok, benchlm: ok } });
  assert.deepEqual(r, { kind: 'unchanged', text: '已同步，官方数据无更新（仍为 2026-09-21）' });
});

test('summarizeRefresh: 官方时间变新 -> updated', () => {
  const r = summarizeRefresh({ beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D2, result: { leaderboard: ok, benchlm: ok } });
  assert.deepEqual(r, { kind: 'updated', text: '已同步，官方数据已更新' });
});

// 同步前没有日期说明当时根本没有官方数据（例如页面还没加载完），无法比较新旧，不能声称"已更新"。
test('summarizeRefresh: 同步前没有时间而同步后有 -> loaded，只陈述加载了数据，不声称更新', () => {
  const r = summarizeRefresh({ beforeUpstreamUpdatedAt: null, afterUpstreamUpdatedAt: D2, result: { leaderboard: ok, benchlm: ok } });
  assert.deepEqual(r, { kind: 'loaded', text: '已同步，已加载官方数据（更新于 2026-09-25）' });
});

test('summarizeRefresh: 同步前没有时间、官方冷却外 BenchLM 冷却 -> 仍不声称更新', () => {
  const bench = { status: 'cooldown', retryAfterSeconds: 3000 };
  const r = summarizeRefresh({ beforeUpstreamUpdatedAt: null, afterUpstreamUpdatedAt: D2, result: { leaderboard: ok, benchlm: bench } });
  assert.equal(r.kind, 'partial');
  assert.equal(r.text, '已同步，已加载官方数据（更新于 2026-09-25）；BenchLM 冷却中，只刷新了官方部分');
});

test('summarizeRefresh: 前后都没有官方时间 -> unchanged 且不编造日期', () => {
  const r = summarizeRefresh({ beforeUpstreamUpdatedAt: null, afterUpstreamUpdatedAt: null, result: { leaderboard: ok, benchlm: ok } });
  assert.deepEqual(r, { kind: 'unchanged', text: '已同步，官方数据无更新' });
});

test('summarizeRefresh: 官方冷却中，分钟数向上取整且至少 1 分钟', () => {
  const cool = (s) => ({ status: 'cooldown', retryAfterSeconds: s });
  const at = (s) => summarizeRefresh({ beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1, result: { leaderboard: cool(s), benchlm: cool(s) } });
  assert.deepEqual(at(600), { kind: 'cooldown', text: '刚同步过，还需等待 10 分钟' });
  assert.equal(at(601).text, '刚同步过，还需等待 11 分钟');
  assert.equal(at(1).text, '刚同步过，还需等待 1 分钟');
  assert.equal(at(0).text, '刚同步过，还需等待 1 分钟');
});

test('summarizeRefresh: 官方冷却而 BenchLM 冷却剩余更久时，等待时间取官方部分的', () => {
  const r = summarizeRefresh({
    beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1,
    result: { leaderboard: { status: 'cooldown', retryAfterSeconds: 120 }, benchlm: { status: 'cooldown', retryAfterSeconds: 3000 } },
  });
  assert.equal(r.text, '刚同步过，还需等待 2 分钟');
});

test('summarizeRefresh: 官方刷新成功但 BenchLM 冷却 -> partial 并注明只刷新了官方部分', () => {
  const bench = { status: 'cooldown', retryAfterSeconds: 3000 };
  const same = summarizeRefresh({ beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1, result: { leaderboard: ok, benchlm: bench } });
  assert.equal(same.kind, 'partial');
  assert.equal(same.text, '已同步，官方数据无更新（仍为 2026-09-21）；BenchLM 冷却中，只刷新了官方部分');
  const newer = summarizeRefresh({ beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D2, result: { leaderboard: ok, benchlm: bench } });
  assert.equal(newer.kind, 'partial');
  assert.equal(newer.text, '已同步，官方数据已更新；BenchLM 冷却中，只刷新了官方部分');
});

test('summarizeRefresh: 官方冷却但 BenchLM 刷新成功 -> partial', () => {
  const r = summarizeRefresh({
    beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1,
    result: { leaderboard: { status: 'cooldown', retryAfterSeconds: 300 }, benchlm: ok },
  });
  assert.equal(r.kind, 'partial');
  assert.equal(r.text, '官方榜单刚同步过，还需等待 5 分钟；BenchLM 已刷新');
});

test('summarizeRefresh: 任一上游失败 -> failed 并带原因，旧数据仍可用', () => {
  const r = summarizeRefresh({
    beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1,
    result: { leaderboard: { status: 'failed', error: 'upstream timeout' }, benchlm: ok },
  });
  assert.equal(r.kind, 'failed');
  assert.equal(r.text, '同步失败（官方榜单：upstream timeout），仍显示旧数据');
});

test('summarizeRefresh: BenchLM 失败也算 failed；两边都失败时原因都列出；缺原因时给出兜底', () => {
  const b = summarizeRefresh({
    beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1,
    result: { leaderboard: ok, benchlm: { status: 'failed', error: 'HTTP 403' } },
  });
  assert.equal(b.kind, 'failed');
  assert.equal(b.text, '同步失败（BenchLM：HTTP 403），仍显示旧数据');
  const both = summarizeRefresh({
    beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1,
    result: { leaderboard: { status: 'failed', error: 'HTTP 429' }, benchlm: { status: 'failed' } },
  });
  assert.equal(both.text, '同步失败（官方榜单：HTTP 429；BenchLM：未知原因），仍显示旧数据');
});

test('summarizeRefresh: 失败优先于冷却（一边失败一边冷却）', () => {
  const r = summarizeRefresh({
    beforeUpstreamUpdatedAt: D1, afterUpstreamUpdatedAt: D1,
    result: { leaderboard: { status: 'failed', error: 'x' }, benchlm: { status: 'cooldown', retryAfterSeconds: 60 } },
  });
  assert.equal(r.kind, 'failed');
});
