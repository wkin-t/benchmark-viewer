import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeLeaderboard, computeFrontier, pickBestPerModel, budgetBest, defaultFilter, toggleModel, toggleEffort, selectAll, clearAll } from '../../web/js/viewmodel.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const leaderboardRaw = fixture('leaderboard');

const rawRow = (over = {}) => ({
  n_trials: 100,
  updated_at: '2026-09-01T00:00:00Z',
  metadata: {
    model_display: { label: 'M' },
    agent_display: { label: 'F' },
    model_org: { label: 'O' },
    reasoning_effort: 'high',
    date: '2026-08-01',
  },
  metrics: {
    accuracy: 50,
    accuracy_ci95_half_width: 3,
    total_cost_usd: 200,
    output_tokens: 5000,
    avg_trial_duration_sec: 60,
  },
  ...over,
});
const rawBoard = (rows, pagination) => ({ rows, pagination: pagination ?? { total: rows.length, total_pages: 1 } });

// ---------- normalizeLeaderboard ----------

test('normalizeLeaderboard: 夹具共 27 行、15 个不同模型、每行 330 次试验', () => {
  const { rows, truncated, notes } = normalizeLeaderboard(leaderboardRaw);
  assert.equal(rows.length, 27);
  assert.equal(new Set(rows.map((r) => r.model)).size, 15);
  assert.equal(truncated, false);
  assert.deepEqual(notes.nTrialsSet, [330]);
});

test('normalizeLeaderboard: GPT-6 Astra max 行的换算（成本 = 总成本 / 试验次数）', () => {
  const { rows } = normalizeLeaderboard(leaderboardRaw);
  const r = rows.find((x) => x.id === 'GPT-6 Astra|Codex|max');
  assert.ok(r, '应存在 id 为 model|framework|effort 的行');
  assert.equal(r.model, 'GPT-6 Astra');
  assert.equal(r.framework, 'Codex');
  assert.equal(r.org, 'OpenAI');
  assert.equal(r.effort, 'max');
  assert.equal(r.score, 58.18);
  assert.equal(r.ciHalf, 2.79);
  assert.equal(r.nTrials, 330);
  assert.ok(Math.abs(r.cost - 9.9) < 0.01, `cost=${r.cost}`);
  assert.ok(Math.abs(r.outTokens - 72693.9) < 0.1, `outTokens=${r.outTokens}`);
  assert.equal(r.durationSec, 2796.3);
  assert.equal(r.releaseDate, '2026-09-03');
  assert.equal(r.updatedAt, '2026-09-10T21:58:00.001022+00:00');
});

test('normalizeLeaderboard: 置信区间半宽范围取全部行的最小与最大（2.45 到 3.94）', () => {
  const { notes } = normalizeLeaderboard(leaderboardRaw);
  assert.equal(notes.ciMin, 2.45);
  assert.equal(notes.ciMax, 3.94);
});

test('normalizeLeaderboard: 手写数值换算，不依赖夹具', () => {
  const { rows } = normalizeLeaderboard(rawBoard([rawRow()]));
  assert.equal(rows[0].cost, 2);
  assert.equal(rows[0].outTokens, 50);
  assert.equal(rows[0].durationSec, 60);
  assert.equal(rows[0].id, 'M|F|high');
});

test('normalizeLeaderboard: output_tokens 或耗时缺失时对应指标为 null，不出现 NaN', () => {
  const noTokens = rawRow();
  delete noTokens.metrics.output_tokens;
  const noDuration = rawRow();
  delete noDuration.metrics.avg_trial_duration_sec;
  const junk = rawRow();
  junk.metrics.output_tokens = 'abc';
  junk.metrics.avg_trial_duration_sec = null;
  const { rows } = normalizeLeaderboard(rawBoard([noTokens, noDuration, junk]));
  assert.equal(rows[0].outTokens, null);
  assert.equal(rows[0].durationSec, 60);
  assert.equal(rows[1].outTokens, 50);
  assert.equal(rows[1].durationSec, null);
  assert.equal(rows[2].outTokens, null);
  assert.equal(rows[2].durationSec, null);
  for (const r of rows) {
    for (const k of ['cost', 'outTokens', 'durationSec']) {
      assert.ok(r[k] === null || Number.isFinite(r[k]), `${k} 不应为 NaN`);
    }
  }
});

test('normalizeLeaderboard: 试验次数为 0 或缺失时成本与 token 为 null，而不是 Infinity', () => {
  const zero = rawRow({ n_trials: 0 });
  const missing = rawRow();
  delete missing.n_trials;
  const { rows } = normalizeLeaderboard(rawBoard([zero, missing]));
  for (const r of rows) {
    assert.equal(r.cost, null);
    assert.equal(r.outTokens, null);
  }
});

test('normalizeLeaderboard: total_cost_usd 缺失时成本为 null', () => {
  const r = rawRow();
  delete r.metrics.total_cost_usd;
  assert.equal(normalizeLeaderboard(rawBoard([r])).rows[0].cost, null);
});

test('normalizeLeaderboard: 分页显示还有更多数据时 truncated 为 true', () => {
  assert.equal(normalizeLeaderboard(rawBoard([rawRow()], { total: 1, total_pages: 2 })).truncated, true);
  assert.equal(normalizeLeaderboard(rawBoard([rawRow()], { total: 5, total_pages: 1 })).truncated, true);
  assert.equal(normalizeLeaderboard(rawBoard([rawRow()], { total: 1, total_pages: 1 })).truncated, false);
});

test('normalizeLeaderboard: 缺少 pagination 时按未截断处理', () => {
  assert.equal(normalizeLeaderboard({ rows: [rawRow()] }).truncated, false);
});

// 容器只校验 Content-Type 含 json，不校验形状；形状异常的 200 会被缓存，
// 所以这里必须给出可读的错误让页面走错误面板，而不是抛出难懂的 TypeError。
test('normalizeLeaderboard: 响应不是对象、rows 缺失或不是数组时抛出明确错误', () => {
  const bad = [null, undefined, 'x', 42, [], {}, { rows: null }, { rows: 'no' }, { rows: { a: 1 } }];
  for (const raw of bad) {
    assert.throws(() => normalizeLeaderboard(raw), /官方榜单响应格式异常/, `输入 ${JSON.stringify(raw)}`);
  }
});

test('normalizeLeaderboard: rows 里的 null、非对象和缺模型名、框架、档位的行被丢弃并计数', () => {
  const good = rawRow();
  const noModel = rawRow(); delete noModel.metadata.model_display;
  const noAgent = rawRow(); delete noAgent.metadata.agent_display;
  const noEffort = rawRow(); delete noEffort.metadata.reasoning_effort;
  const { rows, notes } = normalizeLeaderboard({ rows: [good, null, 7, 'x', noModel, noAgent, noEffort] });
  assert.equal(rows.length, 1);
  assert.equal(notes.dropped, 6);
});

test('normalizeLeaderboard: 没有 accuracy 的行同样计入丢弃数', () => {
  const noScore = rawRow(); delete noScore.metrics.accuracy;
  const { rows, notes } = normalizeLeaderboard({ rows: [rawRow(), noScore] });
  assert.equal(rows.length, 1);
  assert.equal(notes.dropped, 1);
});

test('normalizeLeaderboard: 空榜单得到空行与 null 的区间范围', () => {
  const { rows, notes } = normalizeLeaderboard({ rows: [], pagination: { total: 0, total_pages: 1 } });
  assert.deepEqual(rows, []);
  assert.equal(notes.ciMin, null);
  assert.equal(notes.ciMax, null);
  assert.deepEqual(notes.nTrialsSet, []);
});

test('normalizeLeaderboard: 没有分数的行不是榜单行，被丢弃；置信区间缺失的行不影响范围', () => {
  const noScore = rawRow();
  delete noScore.metrics.accuracy;
  const noCi = rawRow();
  delete noCi.metrics.accuracy_ci95_half_width;
  const { rows, notes } = normalizeLeaderboard(rawBoard([noScore, noCi, rawRow()]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ciHalf, null);
  assert.equal(notes.ciMin, 3);
  assert.equal(notes.ciMax, 3);
});

// ---------- computeFrontier ----------

const P = (id, x, y) => ({ id, x, y });

test('computeFrontier: 被"更便宜且更高分"的点压制，结果按 x 升序', () => {
  const pts = [P('C', 3, 15), P('B', 2, 20), P('A', 1, 10), P('D', 4, 30)];
  assert.deepEqual(computeFrontier(pts), ['A', 'B', 'D']);
});

test('computeFrontier: 同 x 时只保留更高的 y', () => {
  assert.deepEqual(computeFrontier([P('low', 1, 10), P('high', 1, 20)]), ['high']);
});

test('computeFrontier: 同 y 时只保留更低的 x', () => {
  assert.deepEqual(computeFrontier([P('far', 2, 10), P('near', 1, 10)]), ['near']);
});

test('computeFrontier: 完全相同的点都保留，次序按 id 字典序', () => {
  assert.deepEqual(computeFrontier([P('b', 1, 10), P('a', 1, 10)]), ['a', 'b']);
});

test('computeFrontier: 与前沿点相同的点也在前沿上，被更优点压制的相同点一并被压制', () => {
  const pts = [P('a', 1, 10), P('b', 1, 10), P('c', 2, 10), P('d', 3, 5)];
  assert.deepEqual(computeFrontier(pts), ['a', 'b']);
});

test('computeFrontier: 空输入与单点', () => {
  assert.deepEqual(computeFrontier([]), []);
  assert.deepEqual(computeFrontier([P('only', 5, 0)]), ['only']);
});

test('computeFrontier: 分数为 0 的点在没有更优点时仍在前沿上', () => {
  assert.deepEqual(computeFrontier([P('zero', 1, 0), P('worse', 2, 0)]), ['zero']);
});

test('computeFrontier: 不修改入参的次序', () => {
  const pts = [P('B', 2, 20), P('A', 1, 10)];
  computeFrontier(pts);
  assert.deepEqual(pts.map((p) => p.id), ['B', 'A']);
});

const costPoints = () =>
  normalizeLeaderboard(leaderboardRaw).rows.map((r) => ({ ...r, x: r.cost, y: r.score }));

// ---------- pickBestPerModel ----------

const M = (id, model, framework, x, y) => ({ id, model, framework, x, y });

test('pickBestPerModel: 每个模型加框架取分数最高者', () => {
  const pts = [M('a1', 'A', 'F', 1, 10), M('a2', 'A', 'F', 2, 30), M('a3', 'A', 'F', 3, 20)];
  assert.deepEqual(pickBestPerModel(pts).map((p) => p.id), ['a2']);
});

test('pickBestPerModel: 分数并列时取 x 更小者，再并列按 id', () => {
  const tieY = [M('far', 'A', 'F', 5, 30), M('near', 'A', 'F', 2, 30)];
  assert.deepEqual(pickBestPerModel(tieY).map((p) => p.id), ['near']);
  const tieBoth = [M('z', 'A', 'F', 2, 30), M('b', 'A', 'F', 2, 30), M('m', 'A', 'F', 2, 30)];
  assert.deepEqual(pickBestPerModel(tieBoth).map((p) => p.id), ['b']);
});

test('pickBestPerModel: 同一模型的不同框架各算一组', () => {
  const pts = [M('a-f', 'A', 'F', 1, 10), M('a-g', 'A', 'G', 1, 5), M('b-f', 'B', 'F', 1, 1)];
  assert.deepEqual(pickBestPerModel(pts).map((p) => p.id).sort(), ['a-f', 'a-g', 'b-f']);
});

test('pickBestPerModel: 组名不会因字符拼接而串组', () => {
  const pts = [M('p1', 'A|B', 'C', 1, 10), M('p2', 'A', 'B|C', 1, 20)];
  assert.deepEqual(pickBestPerModel(pts).map((p) => p.id).sort(), ['p1', 'p2']);
});

test('pickBestPerModel: 空输入得到空数组，不修改入参', () => {
  assert.deepEqual(pickBestPerModel([]), []);
  const pts = [M('a2', 'A', 'F', 2, 30), M('a1', 'A', 'F', 1, 10)];
  pickBestPerModel(pts);
  assert.deepEqual(pts.map((p) => p.id), ['a2', 'a1']);
});

test('pickBestPerModel: 夹具中 Fable 5.1 的 xhigh 与 max 同为 57.88，取成本更低的 xhigh', () => {
  const best = pickBestPerModel(costPoints());
  assert.equal(best.length, 15);
  assert.equal(best.find((p) => p.model === 'Fable 5.1').effort, 'xhigh');
  assert.equal(best.find((p) => p.model === 'GPT-6 Astra').effort, 'max');
  assert.equal(best.find((p) => p.model === 'Opus 5').effort, 'xhigh');
});

// ---------- budgetBest ----------

test('budgetBest: 夹具中 <=$5 档是 GPT-6 Astra low，<=$10 与 <=$15 档是 GPT-6 Astra max', () => {
  const table = budgetBest(costPoints(), [5, 10, 15]);
  assert.deepEqual(table.map((t) => t.limit), [5, 10, 15]);
  assert.deepEqual(table[0].best.map((p) => p.id), ['GPT-6 Astra|Codex|low']);
  assert.deepEqual(table[1].best.map((p) => p.id), ['GPT-6 Astra|Codex|max']);
  assert.deepEqual(table[2].best.map((p) => p.id), ['GPT-6 Astra|Codex|max']);
});

test('budgetBest: 恰好等于阈值的点算在该档内', () => {
  const table = budgetBest([M('edge', 'A', 'F', 5, 10), M('over', 'A', 'F', 5.01, 99)], [5]);
  assert.deepEqual(table[0].best.map((p) => p.id), ['edge']);
});

test('budgetBest: 没有点落入的档位得到空数组', () => {
  const table = budgetBest([M('pricey', 'A', 'F', 50, 10)], [5, 10]);
  assert.deepEqual(table, [{ limit: 5, best: [] }, { limit: 10, best: [] }]);
  assert.deepEqual(budgetBest([], [5]), [{ limit: 5, best: [] }]);
});

test('budgetBest: 分数并列时全部返回，x 更小者靠前，x 也相同时按 id', () => {
  const pts = [M('c', 'A', 'F', 4, 30), M('a', 'B', 'F', 2, 30), M('b', 'C', 'F', 2, 30), M('lower', 'D', 'F', 1, 20)];
  const table = budgetBest(pts, [5]);
  assert.deepEqual(table[0].best.map((p) => p.id), ['a', 'b', 'c']);
});

test('budgetBest: 阈值是累计的，同一个点可以出现在多个档里', () => {
  const table = budgetBest([M('cheap', 'A', 'F', 1, 10)], [5, 10]);
  assert.equal(table[0].best[0].id, 'cheap');
  assert.equal(table[1].best[0].id, 'cheap');
});

// ---------- 筛选状态 ----------

const deepFreeze = (o) => {
  Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v));
  return Object.freeze(o);
};
const R = (model, effort, framework = 'F') => ({ id: `${model}|${framework}|${effort}`, model, framework, effort });
const smallRows = [R('A', 'low'), R('A', 'high'), R('B', 'max')];

test('defaultFilter: 全部选中，每个模型只登记自己有数据的档位', () => {
  assert.deepEqual(defaultFilter(smallRows), {
    models: {
      A: { selected: true, efforts: { low: true, high: true } },
      B: { selected: true, efforts: { max: true } },
    },
  });
});

test('defaultFilter: 夹具中 GPT-6 Astra 有 5 个档位，GPT-5.6 Luna 只有 max', () => {
  const f = defaultFilter(normalizeLeaderboard(leaderboardRaw).rows);
  assert.deepEqual(Object.keys(f.models['GPT-6 Astra'].efforts).sort(), ['high', 'low', 'max', 'medium', 'xhigh']);
  assert.deepEqual(Object.keys(f.models['GPT-5.6 Luna'].efforts), ['max']);
  assert.equal(Object.keys(f.models).length, 15);
});

test('toggleEffort: 翻转单个档位并同步模型的 selected（全关则模型不再选中）', () => {
  const f0 = deepFreeze(defaultFilter(smallRows));
  const f1 = toggleEffort(f0, 'A', 'low');
  assert.deepEqual(f1.models.A, { selected: true, efforts: { low: false, high: true } });
  const f2 = toggleEffort(f1, 'A', 'high');
  assert.deepEqual(f2.models.A, { selected: false, efforts: { low: false, high: false } });
  const f3 = toggleEffort(f2, 'A', 'low');
  assert.deepEqual(f3.models.A, { selected: true, efforts: { low: true, high: false } });
});

test('toggleEffort: 不可变更新；未知模型或该模型没有的档位原样返回', () => {
  const f0 = deepFreeze(defaultFilter(smallRows));
  const f1 = toggleEffort(f0, 'A', 'low');
  assert.notEqual(f1, f0);
  assert.equal(f0.models.A.efforts.low, true);
  assert.equal(f1.models.B, f0.models.B);
  assert.deepEqual(toggleEffort(f0, 'A', 'max'), f0);
  assert.deepEqual(toggleEffort(f0, 'nope', 'low'), f0);
});

test('toggleModel: 全选 -> 全关；半选或全关 -> 全开', () => {
  const f0 = deepFreeze(defaultFilter(smallRows));
  const off = toggleModel(f0, 'A');
  assert.deepEqual(off.models.A, { selected: false, efforts: { low: false, high: false } });
  const on = toggleModel(off, 'A');
  assert.deepEqual(on.models.A, { selected: true, efforts: { low: true, high: true } });
  const some = toggleEffort(f0, 'A', 'low');
  const fromSome = toggleModel(some, 'A');
  assert.deepEqual(fromSome.models.A, { selected: true, efforts: { low: true, high: true } });
  assert.deepEqual(toggleModel(f0, 'nope'), f0);
  assert.equal(off.models.B, f0.models.B);
});

test('selectAll 与 clearAll: 一键全开与全关，不修改入参', () => {
  const f0 = deepFreeze(toggleModel(defaultFilter(smallRows), 'B'));
  const all = selectAll(f0);
  assert.deepEqual(all, defaultFilter(smallRows));
  const none = clearAll(f0);
  assert.deepEqual(none, {
    models: {
      A: { selected: false, efforts: { low: false, high: false } },
      B: { selected: false, efforts: { max: false } },
    },
  });
  assert.equal(f0.models.B.selected, false);
});
