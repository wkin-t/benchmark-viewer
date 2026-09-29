import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeLeaderboard,
  defaultFilter,
  toggleModel,
  toggleEffort,
  clearAll,
  buildOfficialView,
  METRICS,
  EFFORT_ORDER,
  effortShade,
} from '../../web/js/viewmodel.js';

const leaderboardRaw = JSON.parse(readFileSync(new URL('../fixtures/leaderboard.json', import.meta.url), 'utf8'));
const officialRows = normalizeLeaderboard(leaderboardRaw).rows;
const view = (over = {}) =>
  buildOfficialView({ rows: officialRows, filter: defaultFilter(officialRows), metric: 'cost', bestOnly: false, ...over });
const astra = (effort) => `GPT-6 Astra|Codex|${effort}`;
const LUNA = 'GPT-5.6 Luna|Codex|max';

function luminance(color) {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(color);
  const lin = (c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('档位越高颜色越深', () => {
  const base = '#0891b2';
  const shades = ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) => luminance(effortShade(base, e)));
  for (let i = 1; i < shades.length; i++) {
    assert.ok(shades[i] < shades[i - 1], `${shades[i]} 应深于前一档 ${shades[i - 1]}`);
  }
});

test('EFFORT_ORDER 与 METRICS 的固定文案', () => {
  assert.deepEqual(EFFORT_ORDER, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(Object.keys(METRICS), ['cost', 'outTokens', 'duration']);
  assert.equal(METRICS.cost.axisTitle, '平均每任务成本（美元，实测）');
  assert.equal(METRICS.outTokens.axisTitle, '平均每任务输出 token');
  assert.equal(METRICS.duration.axisTitle, '平均单次耗时（秒）');
  assert.equal(METRICS.outTokens.tooltipHtml, '每次试验平均输出 token 数');
  assert.equal(METRICS.duration.tooltipHtml, '官方公布的平均单次试验耗时');
  assert.equal(METRICS.cost.legendText, '最优前沿：没有“成本更低且分数更高”的行');
  assert.equal(METRICS.outTokens.legendText, '最优前沿：没有“输出 token 更低且分数更高”的行');
  assert.equal(METRICS.duration.legendText, '最优前沿：没有“耗时更低且分数更高”的行');
  for (const m of Object.values(METRICS)) {
    for (const k of ['key', 'label', 'unit', 'axisTitle', 'tooltipHtml', 'legendText']) assert.ok(m[k], `${m.key}.${k}`);
  }
});

test('buildOfficialView: 成本视图全部 27 个点，x 为成本、y 为分数', () => {
  const v = view();
  assert.equal(v.metric.key, 'cost');
  assert.equal(v.points.length, 27);
  const p = v.points.find((q) => q.id === astra('max'));
  assert.equal(p.y, 58.18);
  assert.ok(Math.abs(p.x - 9.9) < 0.01);
  assert.equal(p.model, 'GPT-6 Astra');
  assert.equal(v.missing, 0);
  assert.equal(v.truncated, false);
});

test('buildOfficialView: 官方最优前沿（成本）从低到高是 Luna max 与 Astra 的 low/medium/high/max', () => {
  const v = view();
  assert.deepEqual(v.frontier.pointIds, [LUNA, astra('low'), astra('medium'), astra('high'), astra('max')]);
  const flagged = v.points.filter((p) => p.onFrontier).map((p) => p.id).sort();
  assert.deepEqual(flagged, [...v.frontier.pointIds].sort());
});

test('buildOfficialView: 预算档 <=$5 是 Astra low，<=$10 与 <=$15 是 Astra max', () => {
  const t = view().budgetTable;
  assert.deepEqual(t.map((r) => r.limit), [5, 10, 15]);
  assert.deepEqual(t.map((r) => r.best.map((p) => p.id)), [[astra('low')], [astra('max')], [astra('max')]]);
});

test('buildOfficialView: 连线只给同模型同框架且至少 2 个可见点的组合，按档位顺序', () => {
  const v = view();
  assert.equal(v.lines.length, 3);
  const a = v.lines.find((l) => l.model === 'GPT-6 Astra');
  assert.deepEqual(a.pointIds, ['low', 'medium', 'high', 'xhigh', 'max'].map(astra));
  assert.equal(a.framework, 'Codex');
  assert.equal(a.org, 'OpenAI');
  assert.equal(a.key, 'GPT-6 Astra|Codex');
  const o = v.lines.find((l) => l.model === 'Opus 5');
  assert.deepEqual(o.pointIds.map((id) => id.split('|')[2]), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!v.lines.some((l) => l.model === 'GPT-5.6 Luna'));
});

test('buildOfficialView: 输出 token 视图没有预算档表，前沿按 token 计算', () => {
  const v = view({ metric: 'outTokens' });
  assert.equal(v.budgetTable, null);
  assert.equal(v.metric.key, 'outTokens');
  assert.deepEqual(v.frontier.pointIds, [astra('low'), astra('medium'), astra('high'), astra('max')]);
  const p = v.points.find((q) => q.id === astra('max'));
  assert.ok(Math.abs(p.x - 72693.9) < 0.1);
});

test('buildOfficialView: 耗时视图直接用官方平均单次耗时', () => {
  const v = view({ metric: 'duration' });
  assert.equal(v.budgetTable, null);
  assert.equal(v.points.find((q) => q.id === astra('max')).x, 2796.3);
  assert.deepEqual(v.frontier.pointIds, [astra('low'), astra('medium'), astra('high'), astra('max')]);
});

test('buildOfficialView: 指标缺失的行不上图并计入 missing，且不影响其他指标', () => {
  const rows = [
    { ...officialRows.find((r) => r.id === astra('low')), outTokens: null },
    { ...officialRows.find((r) => r.id === astra('max')), durationSec: null },
    officialRows.find((r) => r.id === astra('high')),
  ];
  const filter = defaultFilter(rows);
  const tokens = buildOfficialView({ rows, filter, metric: 'outTokens', bestOnly: false });
  assert.equal(tokens.missing, 1);
  assert.deepEqual(tokens.points.map((p) => p.id).sort(), [astra('high'), astra('max')]);
  const dur = buildOfficialView({ rows, filter, metric: 'duration', bestOnly: false });
  assert.equal(dur.missing, 1);
  const cost = buildOfficialView({ rows, filter, metric: 'cost', bestOnly: false });
  assert.equal(cost.missing, 0);
  for (const p of tokens.points) assert.ok(Number.isFinite(p.x));
});

test('buildOfficialView: 缺失指标的行只有被筛选选中时才计入 missing', () => {
  const rows = [{ ...officialRows.find((r) => r.id === astra('low')), outTokens: null }, officialRows.find((r) => r.id === astra('max'))];
  const filter = toggleEffort(defaultFilter(rows), 'GPT-6 Astra', 'low');
  const v = buildOfficialView({ rows, filter, metric: 'outTokens', bestOnly: false });
  assert.equal(v.missing, 0);
  assert.equal(v.points.length, 1);
});

test('buildOfficialView: 缺失指标使连线不足 2 点时不出线', () => {
  const rows = [
    { ...officialRows.find((r) => r.id === astra('low')), outTokens: null },
    officialRows.find((r) => r.id === astra('high')),
  ];
  const v = buildOfficialView({ rows, filter: defaultFilter(rows), metric: 'outTokens', bestOnly: false });
  assert.deepEqual(v.lines, []);
});

test('buildOfficialView: bestOnly 先取每个模型最佳档再算前沿（Fable 5.1 取 xhigh，被 Astra max 压制）', () => {
  const v = view({ bestOnly: true });
  assert.equal(v.points.length, 15);
  // 手算：按成本升序，Luna 1.05/17.27、Terra 5.25/21.52、Sol 7.70/37.27、GLM-5.3 8.27/41.82、Astra max 9.90/58.18 依次刷新最高分；其后无更高分。
  assert.deepEqual(v.frontier.pointIds, [
    LUNA,
    'GPT-5.6 Terra|Codex|max',
    'GPT-5.6 Sol|Codex|max',
    'GLM-5.3|Claude Code|max',
    astra('max'),
  ]);
  assert.deepEqual(v.lines, []);
  assert.deepEqual(v.budgetTable.map((r) => r.best.map((p) => p.id)), [[LUNA], [astra('max')], [astra('max')]]);
});

test('buildOfficialView: 取消 GPT-6 Astra 后，前沿与预算档随可见点重算', () => {
  const filter = toggleModel(defaultFilter(officialRows), 'GPT-6 Astra');
  const v = view({ filter });
  assert.equal(v.points.length, 22);
  assert.deepEqual(v.counts, { selected: 22, total: 27 });
  assert.deepEqual(v.frontier.pointIds, [
    LUNA,
    'GPT-5.6 Terra|Codex|max',
    'Fable 5.1|Claude Code|low',
    'Fable 5.1|Claude Code|medium',
    'Fable 5.1|Claude Code|high',
    'Fable 5.1|Claude Code|xhigh',
  ]);
  assert.deepEqual(v.budgetTable.map((r) => r.best.map((p) => p.id)), [
    [LUNA],
    ['Fable 5.1|Claude Code|medium'],
    ['Fable 5.1|Claude Code|xhigh'],
  ]);
});

test('buildOfficialView: 只关掉 Astra max 档，前沿到 high 为止（xhigh 与 high 同分更贵）', () => {
  const filter = toggleEffort(defaultFilter(officialRows), 'GPT-6 Astra', 'max');
  const v = view({ filter });
  assert.equal(v.points.length, 26);
  assert.deepEqual(v.frontier.pointIds, [LUNA, astra('low'), astra('medium'), astra('high')]);
  const node = v.filterTree.find((n) => n.model === 'GPT-6 Astra');
  assert.equal(node.state, 'some');
  assert.equal(node.selected, 4);
  assert.equal(node.total, 5);
});

test('buildOfficialView: filterTree 的档位只列数据里出现过的（没有 none），无数据档位 available=false', () => {
  const v = view();
  assert.equal(v.filterTree.length, 15);
  const a = v.filterTree.find((n) => n.model === 'GPT-6 Astra');
  assert.deepEqual(a.efforts.map((e) => e.effort), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual({ org: a.org, total: a.total, selected: a.selected, state: a.state }, { org: 'OpenAI', total: 5, selected: 5, state: 'all' });
  const luna = v.filterTree.find((n) => n.model === 'GPT-5.6 Luna');
  assert.deepEqual(luna.efforts.map((e) => [e.effort, e.available, e.selected]), [
    ['low', false, false],
    ['medium', false, false],
    ['high', false, false],
    ['xhigh', false, false],
    ['max', true, true],
  ]);
  assert.deepEqual(v.counts, { selected: 27, total: 27 });
});

test('buildOfficialView: 全部取消时 state 为 none、点与前沿为空、预算档每档为空数组', () => {
  const v = view({ filter: clearAll(defaultFilter(officialRows)) });
  assert.equal(v.points.length, 0);
  assert.deepEqual(v.frontier.pointIds, []);
  assert.ok(v.filterTree.every((n) => n.state === 'none' && n.selected === 0));
  assert.deepEqual(v.counts, { selected: 0, total: 27 });
  assert.deepEqual(v.budgetTable.map((r) => r.best), [[], [], []]);
});

test('buildOfficialView: 成本提示文案带上数据里的试验次数；次数不一致时不写死数字', () => {
  const t = view().metric.tooltipHtml;
  assert.ok(t.startsWith('成本 = 官方榜单公布的该行 330 次试验总成本 ÷ 330。'), t);
  assert.ok(t.includes('每一行是“模型 + 框架 + 档位”的整套结果，不是模型单价。'));
  const rows = [{ ...officialRows[0], nTrials: 100 }, { ...officialRows[1], nTrials: 330 }];
  const mixed = buildOfficialView({ rows, filter: defaultFilter(rows), metric: 'cost', bestOnly: false }).metric.tooltipHtml;
  assert.ok(!mixed.includes('330 次'), mixed);
  assert.ok(mixed.includes('试验总成本 ÷ 试验次数'));
  assert.equal(view({ metric: 'duration' }).metric.tooltipHtml, '官方公布的平均单次试验耗时');
});

test('buildOfficialView: notes 取全部行的置信区间范围，不受筛选影响；truncated 透传', () => {
  const v = view({ filter: clearAll(defaultFilter(officialRows)), truncated: true });
  assert.deepEqual({ ciMin: v.notes.ciMin, ciMax: v.notes.ciMax }, { ciMin: 2.45, ciMax: 3.94 });
  assert.equal(v.truncated, true);
});

test('buildOfficialView: 空榜单不抛错', () => {
  const v = buildOfficialView({ rows: [], filter: defaultFilter([]), metric: 'cost', bestOnly: false });
  assert.deepEqual(v.points, []);
  assert.deepEqual(v.filterTree, []);
  assert.deepEqual(v.counts, { selected: 0, total: 0 });
  assert.equal(v.notes.ciMin, null);
});

test('buildOfficialView: 筛选状态里没登记的模型视为可见，避免刷新出的新数据被悄悄藏起来', () => {
  const v = view({ filter: { models: {} } });
  assert.equal(v.points.length, 27);
});

test('buildOfficialView: 同 x 更高 y 只留高的；相同点都留（经由整条流水线）', () => {
  const mk = (effort, cost, score) => ({
    id: `M|F|${effort}`, model: 'M', framework: 'F', org: 'O', effort, score, ciHalf: 1, nTrials: 1,
    cost, outTokens: 1, durationSec: 1, releaseDate: null, updatedAt: null,
  });
  const rows = [mk('low', 2, 10), mk('medium', 2, 20), mk('high', 3, 20), mk('xhigh', 3, 20)];
  const v = buildOfficialView({ rows, filter: defaultFilter(rows), metric: 'cost', bestOnly: false });
  assert.deepEqual(v.frontier.pointIds, ['M|F|medium']);
  const rows2 = [mk('low', 2, 20), mk('medium', 2, 20), mk('high', 3, 30)];
  const v2 = buildOfficialView({ rows: rows2, filter: defaultFilter(rows2), metric: 'cost', bestOnly: false });
  assert.deepEqual(v2.frontier.pointIds, ['M|F|low', 'M|F|medium', 'M|F|high']);
});
