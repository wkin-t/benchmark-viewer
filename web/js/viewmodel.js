export const EFFORT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 官方接口的 output_tokens 与 avg_trial_duration_sec 是可选字段；除以 0 或缺失都必须落成 null，
// 否则 NaN/Infinity 会让比例尺和前沿计算悄悄出错。
function perTrial(total, nTrials) {
  const t = finiteOrNull(total);
  return t !== null && nTrials !== null && nTrials > 0 ? t / nTrials : null;
}

function isLabel(value) {
  return typeof value === 'string' && value.length > 0;
}

// 缺模型名、框架或档位的行没法归入连线和筛选树，渲染层还会对档位做字符串处理，
// 留着只会让整张图崩溃，所以在入口丢弃并由调用方通过 notes.dropped 得知。
function normalizeRow(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const meta = raw.metadata ?? {};
  const metrics = raw.metrics ?? {};
  const score = finiteOrNull(metrics.accuracy);
  if (score === null) return null;
  const model = meta.model_display?.label;
  const framework = meta.agent_display?.label;
  const effort = meta.reasoning_effort;
  if (!isLabel(model) || !isLabel(framework) || !isLabel(effort)) return null;
  const nTrials = finiteOrNull(raw.n_trials ?? metrics.n_trials);
  return {
    id: `${model}|${framework}|${effort}`,
    model,
    framework,
    org: meta.model_org?.label ?? null,
    effort,
    score,
    ciHalf: finiteOrNull(metrics.accuracy_ci95_half_width),
    nTrials,
    cost: perTrial(metrics.total_cost_usd, nTrials),
    outTokens: perTrial(metrics.output_tokens, nTrials),
    durationSec: finiteOrNull(metrics.avg_trial_duration_sec),
    releaseDate: meta.date ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

// 容器只校验 Content-Type 含 json，形状异常的 200 也会进缓存；这里抛出可读的错误，
// 让页面走错误面板，而不是在后面某处因 undefined 崩溃。
export function normalizeLeaderboard(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.rows)) {
    throw new Error('官方榜单响应格式异常：rows 不是数组');
  }
  const rawRows = raw.rows;
  const pagination = raw.pagination;
  const rows = rawRows.map(normalizeRow).filter((r) => r !== null);
  const dropped = rawRows.length - rows.length;
  const truncated =
    pagination != null &&
    (pagination.total_pages > 1 || rawRows.length < (pagination.total ?? 0));

  const cis = rows.map((r) => r.ciHalf).filter((v) => v !== null);
  const nTrialsSet = [...new Set(rows.map((r) => r.nTrials).filter((v) => v !== null))].sort((a, b) => a - b);
  return {
    rows,
    truncated,
    notes: {
      ciMin: cis.length ? Math.min(...cis) : null,
      ciMax: cis.length ? Math.max(...cis) : null,
      nTrialsSet,
      dropped,
    },
  };
}

function byIdAsc(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function dominates(q, p) {
  return q.x <= p.x && q.y >= p.y && (q.x < p.x || q.y > p.y);
}

export function computeFrontier(points) {
  return points
    .filter((p) => !points.some((q) => dominates(q, p)))
    .sort((a, b) => a.x - b.x || byIdAsc(a, b))
    .map((p) => p.id);
}

function byBestFirst(a, b) {
  return b.y - a.y || a.x - b.x || byIdAsc(a, b);
}

export function pickBestPerModel(points) {
  const bestByGroup = new Map();
  for (const p of points) {
    const key = JSON.stringify([p.model, p.framework]);
    const current = bestByGroup.get(key);
    if (!current || byBestFirst(p, current) < 0) bestByGroup.set(key, p);
  }
  const chosen = new Set(bestByGroup.values());
  return points.filter((p) => chosen.has(p));
}

export function budgetBest(points, limits) {
  return limits.map((limit) => {
    const within = points.filter((p) => p.x <= limit);
    if (within.length === 0) return { limit, best: [] };
    const topY = Math.max(...within.map((p) => p.y));
    const best = within.filter((p) => p.y === topY).sort((a, b) => a.x - b.x || byIdAsc(a, b));
    return { limit, best };
  });
}

function withEfforts(efforts) {
  return { selected: Object.values(efforts).some(Boolean), efforts };
}

function setAllEfforts(entry, value) {
  const efforts = Object.fromEntries(Object.keys(entry.efforts).map((e) => [e, value]));
  return withEfforts(efforts);
}

function mapModels(filter, fn) {
  return { models: Object.fromEntries(Object.entries(filter.models).map(([m, entry]) => [m, fn(entry)])) };
}

export function defaultFilter(rows) {
  const models = {};
  for (const r of rows) {
    models[r.model] ??= { selected: true, efforts: {} };
    models[r.model].efforts[r.effort] = true;
  }
  return { models };
}

export function toggleEffort(filter, model, effort) {
  const entry = filter.models[model];
  if (!entry || !(effort in entry.efforts)) return filter;
  const efforts = { ...entry.efforts, [effort]: !entry.efforts[effort] };
  return { models: { ...filter.models, [model]: withEfforts(efforts) } };
}

export function toggleModel(filter, model) {
  const entry = filter.models[model];
  if (!entry) return filter;
  const allOn = Object.values(entry.efforts).every(Boolean);
  return { models: { ...filter.models, [model]: setAllEfforts(entry, !allOn) } };
}

export function selectAll(filter) {
  return mapModels(filter, (entry) => setAllEfforts(entry, true));
}

export function clearAll(filter) {
  return mapModels(filter, (entry) => setAllEfforts(entry, false));
}

function costTooltip(nTrials) {
  const formula =
    nTrials === null
      ? '该行试验总成本 ÷ 试验次数'
      : `该行 ${nTrials} 次试验总成本 ÷ ${nTrials}`;
  return (
    `成本 = 官方榜单公布的${formula}。` +
    '官方未说明计价口径（是否按公开单价、是否含缓存折扣），不同厂商之间可能不完全可比。' +
    '每一行是“模型 + 框架 + 档位”的整套结果，不是模型单价。'
  );
}

export const METRICS = {
  cost: {
    key: 'cost',
    label: '成本',
    unit: '美元',
    axisTitle: '平均每任务成本（美元，实测）',
    tooltipHtml: costTooltip(null),
    legendText: '最优前沿：没有“成本更低且分数更高”的行',
  },
  outTokens: {
    key: 'outTokens',
    label: '输出 token',
    unit: 'token',
    axisTitle: '平均每任务输出 token',
    tooltipHtml: '每次试验平均输出 token 数',
    legendText: '最优前沿：没有“输出 token 更低且分数更高”的行',
  },
  duration: {
    key: 'duration',
    label: '耗时',
    unit: '秒',
    axisTitle: '平均单次耗时（秒）',
    tooltipHtml: '官方公布的平均单次试验耗时',
    legendText: '最优前沿：没有“耗时更低且分数更高”的行',
  },
};

const METRIC_FIELD = { cost: 'cost', outTokens: 'outTokens', duration: 'durationSec' };
const BUDGET_LIMITS = [5, 10, 15];

function isRowSelected(filter, row) {
  return filter.models[row.model]?.efforts?.[row.effort] ?? true;
}

function effortRank(effort) {
  const i = EFFORT_ORDER.indexOf(effort);
  return i === -1 ? EFFORT_ORDER.length : i;
}

function byEffort(a, b) {
  return effortRank(a) - effortRank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function buildLines(points) {
  const groups = new Map();
  for (const p of points) {
    const key = `${p.model}|${p.framework}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups]
    .filter(([, members]) => members.length >= 2)
    .map(([key, members]) => ({
      key,
      model: members[0].model,
      framework: members[0].framework,
      org: members[0].org,
      pointIds: members.sort((a, b) => byEffort(a.effort, b.effort)).map((p) => p.id),
    }));
}

function buildFilterTree(rows, filter) {
  const efforts = [...new Set(rows.map((r) => r.effort))].sort(byEffort);
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  return [...byModel].map(([model, modelRows]) => {
    const selected = modelRows.filter((r) => isRowSelected(filter, r)).length;
    const total = modelRows.length;
    return {
      model,
      org: modelRows[0].org,
      total,
      selected,
      state: selected === total ? 'all' : selected === 0 ? 'none' : 'some',
      efforts: efforts.map((effort) => {
        const own = modelRows.filter((r) => r.effort === effort);
        return {
          effort,
          available: own.length > 0,
          selected: own.length > 0 && own.every((r) => isRowSelected(filter, r)),
        };
      }),
    };
  });
}

function metricFor(metric, rows) {
  const meta = METRICS[metric];
  if (metric !== 'cost') return meta;
  const counts = new Set(rows.map((r) => r.nTrials).filter((n) => n !== null));
  return counts.size === 1 ? { ...meta, tooltipHtml: costTooltip([...counts][0]) } : meta;
}

// truncated 由 normalizeLeaderboard 产出，这里作为可选入参透传：契约里的入参没有它，
// 但输出必须有，否则前端无法在此处拿到截断提示。
export function buildOfficialView({ rows, filter, metric, bestOnly, truncated = false }) {
  const activeFilter = filter ?? defaultFilter(rows);
  const field = METRIC_FIELD[metric];
  const selectedRows = rows.filter((r) => isRowSelected(activeFilter, r));
  const plottable = selectedRows.filter((r) => r[field] !== null && r[field] !== undefined);

  let candidates = plottable.map((r) => ({ ...r, x: r[field], y: r.score }));
  if (bestOnly) candidates = pickBestPerModel(candidates);

  const frontierIds = computeFrontier(candidates);
  const onFrontier = new Set(frontierIds);
  const points = candidates.map((p) => ({ ...p, onFrontier: onFrontier.has(p.id) }));

  const cis = rows.map((r) => r.ciHalf).filter((v) => v !== null);
  return {
    metric: metricFor(metric, rows),
    points,
    lines: buildLines(points),
    frontier: { pointIds: frontierIds },
    budgetTable: metric === 'cost' ? budgetBest(points, BUDGET_LIMITS) : null,
    filterTree: buildFilterTree(rows, activeFilter),
    counts: { selected: selectedRows.length, total: rows.length },
    missing: selectedRows.length - plottable.length,
    truncated,
    notes: {
      ciMin: cis.length ? Math.min(...cis) : null,
      ciMax: cis.length ? Math.max(...cis) : null,
    },
  };
}

function positivePrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function olderTimestamp(a, b) {
  const dates = [a, b]
    .filter((v) => v != null && v !== '')
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()));
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
}

export function buildSupplementView({ models, pricing, modelMap, vendorFilter }) {
  const filter = vendorFilter ?? {};
  const officialSlugs = new Set(Object.values(modelMap ?? {}).flat());

  // 价格文件里 slug 为 null 的项不能进 Map，否则 slug 同为 null 的模型会错配到它。
  const priceBySlug = new Map();
  for (const p of pricing?.items ?? []) {
    if (p.slug != null && !priceBySlug.has(p.slug)) priceBySlug.set(p.slug, p.outputPrice);
  }

  const plotted = [];
  const excluded = [];
  for (const m of models?.items ?? []) {
    const score = m.benchmarks?.agentic?.aaTerminalBench4;
    if (score == null || !Number.isFinite(score)) continue;
    const price = m.slug == null ? null : positivePrice(priceBySlug.get(m.slug));
    if (price === null) {
      excluded.push({ slug: m.slug, model: m.model });
      continue;
    }
    plotted.push({
      slug: m.slug,
      model: m.model,
      creator: m.creator,
      score,
      price,
      releaseDate: m.releaseDate ?? null,
      alsoOfficial: officialSlugs.has(m.slug),
    });
  }

  const totals = new Map();
  for (const p of plotted) totals.set(p.creator, (totals.get(p.creator) ?? 0) + 1);
  const vendors = [...totals]
    .map(([creator, total]) => ({ creator, total, selected: filter[creator] !== false }))
    .sort((a, b) => (a.creator < b.creator ? -1 : a.creator > b.creator ? 1 : 0));

  const visible = plotted.filter((p) => filter[p.creator] !== false);
  const frontierIds = computeFrontier(visible.map((p) => ({ id: p.slug, x: p.price, y: p.score })));
  const onFrontier = new Set(frontierIds);

  return {
    points: visible.map((p) => ({ ...p, onFrontier: onFrontier.has(p.slug) })),
    frontier: { pointIds: frontierIds },
    excluded,
    vendors,
    snapshotAt: olderTimestamp(models?.generatedAt, pricing?.generatedAt),
  };
}
