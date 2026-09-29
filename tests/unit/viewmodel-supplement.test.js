import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSupplementView } from '../../web/js/viewmodel.js';

const read = (url) => JSON.parse(readFileSync(new URL(url, import.meta.url), 'utf8'));
const models = read('../fixtures/models.json');
const pricing = read('../fixtures/pricing.json');
const modelMap = read('../../web/data/model-map.json');
const real = (over = {}) => buildSupplementView({ models, pricing, modelMap, vendorFilter: {}, ...over });
const bySlug = (v, slug) => v.points.find((p) => p.slug === slug);

const item = (slug, aa, creator = 'C', extra = {}) => ({
  slug,
  model: `Model ${slug}`,
  creator,
  releaseDate: '2026-01-01',
  benchmarks: { agentic: { aaTerminalBench4: aa } },
  ...extra,
});
const priceItem = (slug, outputPrice) => ({ slug, outputPrice });
const synth = (modelItems, priceItems, over = {}) =>
  buildSupplementView({
    models: { generatedAt: '2026-09-29T00:00:00Z', items: modelItems },
    pricing: { generatedAt: '2026-09-29T00:00:00Z', items: priceItems },
    modelMap: {},
    vendorFilter: {},
    ...over,
  });

test('夹具：25 个有 AA 分数的模型里 5 个无正输出单价被排除，画 20 个点', () => {
  const v = real();
  assert.equal(v.points.length, 20);
  assert.deepEqual(
    v.excluded.map((e) => e.slug).sort(),
    ['glm-5-3', 'glm-5-3-flash', 'muse-glimmer-30b', 'nemotron-3-ultra', 'qwen3-8-27b'],
  );
  assert.equal(v.excluded.find((e) => e.slug === 'glm-5-3').model, 'GLM-5.3');
});

test('夹具：Mistral Medium 3.5 128B 的 AA 分数为 0 且有价格，必须显示', () => {
  const p = bySlug(real(), 'mistral-medium-3-5-128b');
  assert.ok(p);
  assert.equal(p.score, 0);
  assert.equal(p.price, 7.5);
  assert.equal(p.creator, 'Mistral');
  assert.equal(p.releaseDate, '2026-04-29');
  assert.equal(p.model, 'Mistral Medium 3.5 128B');
});

test('夹具：点的字段取自模型文件与价格文件', () => {
  const p = bySlug(real(), 'claude-sonnet-5-5');
  assert.deepEqual(
    { model: p.model, creator: p.creator, score: p.score, price: p.price, releaseDate: p.releaseDate },
    { model: 'Claude Sonnet 5.5', creator: 'Anthropic', score: 63.6, price: 10, releaseDate: '2026-09-28' },
  );
});

test('夹具：没有 AA 分数的模型不出现在点或排除名单里', () => {
  const v = real();
  const all = [...v.points.map((p) => p.slug), ...v.excluded.map((e) => e.slug)];
  assert.equal(all.length, 25);
  assert.equal(new Set(all).size, 25);
});

test('夹具：◆ 标记只按映射表精确匹配 slug，GPT-6 Sol 与 GPT-5.6 Sol 不混淆', () => {
  const v = real();
  const official = v.points.filter((p) => p.alsoOfficial).map((p) => p.slug).sort();
  assert.deepEqual(official, [
    'claude-fable-5-1',
    'claude-opus-5',
    'gemini-3-8-flash',
    'gpt-5-6-luna',
    'gpt-5-6-sol',
    'gpt-6-astra',
    'grok-4-7',
  ]);
  assert.equal(bySlug(v, 'gpt-6-sol').alsoOfficial, false);
  assert.equal(bySlug(v, 'gpt-6-luna').alsoOfficial, false);
  assert.equal(bySlug(v, 'claude-opus-5-5').alsoOfficial, false);
});

test('夹具：按单价的最优前沿（手算）是 GPT-6 Luna、MiMo-V2.6-Pro、Claude Sonnet 5.5', () => {
  const v = real();
  assert.deepEqual(v.frontier.pointIds, ['gpt-6-luna', 'mimo-v2-6-pro', 'claude-sonnet-5-5']);
  assert.deepEqual(v.points.filter((p) => p.onFrontier).map((p) => p.slug).sort(), [...v.frontier.pointIds].sort());
});

test('夹具：厂商列表只含画得出点的厂商，total 为其点数', () => {
  const v = real();
  const m = Object.fromEntries(v.vendors.map((x) => [x.creator, x]));
  assert.equal(v.vendors.length, 12);
  assert.equal(m.Anthropic.total, 4);
  assert.equal(m.OpenAI.total, 5);
  assert.equal(m.Google.total, 2);
  assert.equal(m.Alibaba, undefined);
  assert.equal(m['Z.AI'], undefined);
  assert.ok(v.vendors.every((x) => x.selected === true));
  assert.equal(v.vendors.reduce((s, x) => s + x.total, 0), 20);
});

test('夹具：取消 Anthropic 后点、前沿重算，排除名单与厂商 total 不变', () => {
  const v = real({ vendorFilter: { Anthropic: false } });
  assert.equal(v.points.length, 16);
  assert.ok(!v.points.some((p) => p.creator === 'Anthropic'));
  assert.deepEqual(v.frontier.pointIds, ['gpt-6-luna', 'mimo-v2-6-pro', 'gpt-6-sol', 'gpt-6-astra']);
  assert.equal(v.excluded.length, 5);
  const a = v.vendors.find((x) => x.creator === 'Anthropic');
  assert.deepEqual({ total: a.total, selected: a.selected }, { total: 4, selected: false });
});

test('vendorFilter 缺省或缺少某厂商时视为选中；全部取消得到空图', () => {
  assert.equal(real({ vendorFilter: undefined }).points.length, 20);
  assert.equal(real({ vendorFilter: { Nobody: false } }).points.length, 20);
  const none = real({ vendorFilter: Object.fromEntries(real().vendors.map((x) => [x.creator, false])) });
  assert.deepEqual(none.points, []);
  assert.deepEqual(none.frontier.pointIds, []);
  assert.equal(none.excluded.length, 5);
});

test('snapshotAt 取两个文件 generatedAt 中较旧者，夹具里两者相同', () => {
  assert.equal(real().snapshotAt.toISOString(), '2026-09-29T02:03:20.922Z');
  const older = synth([], [], {
    models: { generatedAt: '2026-09-29T10:00:00Z', items: [] },
    pricing: { generatedAt: '2026-09-28T10:00:00Z', items: [] },
  });
  assert.equal(older.snapshotAt.toISOString(), '2026-09-28T10:00:00.000Z');
  const swapped = synth([], [], {
    models: { generatedAt: '2026-09-27T10:00:00Z', items: [] },
    pricing: { generatedAt: '2026-09-28T10:00:00Z', items: [] },
  });
  assert.equal(swapped.snapshotAt.toISOString(), '2026-09-27T10:00:00.000Z');
});

test('snapshotAt: 一个文件缺时间取另一个，都缺得到 null', () => {
  const one = synth([], [], { models: { items: [] }, pricing: { generatedAt: '2026-09-28T10:00:00Z', items: [] } });
  assert.equal(one.snapshotAt.toISOString(), '2026-09-28T10:00:00.000Z');
  const none = synth([], [], { models: { items: [] }, pricing: { generatedAt: 'garbage', items: [] } });
  assert.equal(none.snapshotAt, null);
});

test('价格：outputPrice 为 null、0、负数、缺失、非数字都归入 excluded', () => {
  const v = synth(
    [item('a', 10), item('b', 10), item('c', 10), item('d', 10), item('e', 10), item('ok', 10)],
    [
      priceItem('a', null),
      priceItem('b', 0),
      priceItem('c', -1),
      { slug: 'd' },
      priceItem('e', 'free'),
      priceItem('ok', 0.5),
    ],
  );
  assert.deepEqual(v.excluded.map((e) => e.slug), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(v.points.map((p) => p.slug), ['ok']);
});

test('价格：没有对应价格条目的模型也被排除', () => {
  const v = synth([item('lonely', 10)], [priceItem('other', 1)]);
  assert.deepEqual(v.excluded, [{ slug: 'lonely', model: 'Model lonely' }]);
  assert.deepEqual(v.points, []);
});

test('价格：slug 为 null 的价格项被忽略，不会当作任何模型的价格', () => {
  const v = synth([item('x', 10), item(null, 10)], [priceItem(null, 9), priceItem('x', 2)]);
  assert.deepEqual(v.points.map((p) => p.slug), ['x']);
  assert.equal(v.points[0].price, 2);
  const noMatch = synth([item(null, 10)], [priceItem(null, 9)]);
  assert.deepEqual(noMatch.points, []);
});

test('AA 分数：0 有效；null、缺失、无 benchmarks 的模型不参与，也不算被排除', () => {
  const v = synth(
    [
      item('zero', 0),
      item('nullscore', null),
      { slug: 'nobench', model: 'N', creator: 'C', releaseDate: null },
      { slug: 'noagentic', model: 'N', creator: 'C', releaseDate: null, benchmarks: {} },
      item('undef', undefined),
    ],
    [priceItem('zero', 1), priceItem('nullscore', 1), priceItem('nobench', 1), priceItem('noagentic', 1), priceItem('undef', 1)],
  );
  assert.deepEqual(v.points.map((p) => p.slug), ['zero']);
  assert.equal(v.points[0].score, 0);
  assert.deepEqual(v.excluded, []);
});

test('前沿：同价更高分只留高的，同分更低价只留低的，完全相同的点都留', () => {
  const v = synth(
    [item('cheap-low', 10), item('cheap-high', 20), item('dear-same', 20), item('twin-a', 30), item('twin-b', 30)],
    [priceItem('cheap-low', 1), priceItem('cheap-high', 1), priceItem('dear-same', 2), priceItem('twin-a', 3), priceItem('twin-b', 3)],
  );
  assert.deepEqual(v.frontier.pointIds, ['cheap-high', 'twin-a', 'twin-b']);
});

test('映射表缺失或为空时没有 ◆，不抛错', () => {
  const inputs = [{ modelMap: undefined }, { modelMap: null }, { modelMap: {} }];
  for (const over of inputs) {
    const v = real(over);
    assert.equal(v.points.length, 20);
    assert.ok(v.points.every((p) => p.alsoOfficial === false));
  }
});

test('映射表里同一官方模型可以对应多个 slug', () => {
  const v = synth([item('one', 10), item('two', 10), item('three', 10)], [priceItem('one', 1), priceItem('two', 1), priceItem('three', 1)], {
    modelMap: { 'Official X': ['one', 'two'] },
  });
  assert.deepEqual(v.points.map((p) => p.alsoOfficial), [true, true, false]);
});

test('空数据不抛错', () => {
  const v = synth([], []);
  assert.deepEqual(v.points, []);
  assert.deepEqual(v.excluded, []);
  assert.deepEqual(v.vendors, []);
  assert.deepEqual(v.frontier.pointIds, []);
});
