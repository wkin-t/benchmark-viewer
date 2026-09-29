import {
  normalizeLeaderboard,
  defaultFilter,
  toggleModel,
  toggleEffort,
  selectAll,
  clearAll,
  buildOfficialView,
  buildSupplementView,
} from './viewmodel.js';
import { evaluateFreshness, formatAgo, summarizeRefresh } from './freshness.js';
import { loadAll, postRefresh } from './api.js';
import {
  h,
  drawOfficialChart,
  drawSupplementChart,
  renderXTitle,
  renderOfficialLegend,
  renderSupplementLegend,
  renderOfficialNotes,
  renderSupplementNotes,
  renderBudgetLadder,
  applyLadder,
  renderFilterDropdown,
  officialFilterSpec,
  supplementFilterSpec,
  renderStatePanel,
  hideTip,
  setVendorHighlight,
  setFrontierHighlight,
} from './render.js';

const $ = (id) => document.getElementById(id);

const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };
const AGO_TICK_MS = 30 * 1000;

const state = {
  source: 'official',
  metric: 'cost',
  bestOnly: false,
  filter: null,
  vendorFilter: {},
  data: { leaderboard: null, benchlm: null, modelMap: null },
  norm: null,
  loading: true,
  themeMode: 'auto',
  refreshing: false,
  cooldownUntil: 0,
  syncMessage: null,
  lastSupplementVendors: [],
  showFrontier: true,
  activeVendor: null,
};

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- 主题 ---------- */

function readThemeMode() {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' || attr === 'dark' ? attr : 'auto';
}

function applyTheme(mode) {
  state.themeMode = mode;
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  $('theme-btn').textContent = THEME_LABELS[mode];
  try {
    if (mode === 'auto') localStorage.removeItem('bv-theme');
    else localStorage.setItem('bv-theme', mode);
  } catch {
    // 本地存储不可用（隐私模式、被禁用）时只是不记忆选择，页面照常工作。
  }
}

/* ---------- 数据装载 ---------- */

// 刷新失败时保留旧数据：一次网络抖动不应该把已经在看的图换成错误页。
function pick(fresh, old) {
  return fresh.ok || !old?.ok ? fresh : old;
}

function mergeFilter(previous, rows) {
  const next = defaultFilter(rows);
  if (!previous) return next;
  for (const [model, entry] of Object.entries(next.models)) {
    const prev = previous.models[model];
    if (!prev) continue;
    for (const effort of Object.keys(entry.efforts)) {
      if (effort in prev.efforts) entry.efforts[effort] = prev.efforts[effort];
    }
    entry.selected = Object.values(entry.efforts).some(Boolean);
  }
  return next;
}

function warnMappingGaps() {
  const { leaderboard, modelMap } = state.data;
  if (modelMap && !modelMap.ok) {
    console.warn(`模型映射表加载失败（${modelMap.error}），补充视图不会标记“官方榜单也收录”的模型`);
    return;
  }
  if (!leaderboard?.ok || !state.norm) return;
  const map = modelMap?.map ?? {};
  const missing = [...new Set(state.norm.rows.map((r) => r.model))].filter((m) => !(m in map));
  if (missing.length > 0) {
    console.warn(`模型映射缺失：官方榜单里的这些模型没有对应的 BenchLM slug，补充视图不会给它们标 ◆：${missing.join('、')}`);
  }
}

// 上游返回形状异常但状态码 200 时，视图模型可能抛错。这里把抛错折成 { ok:false }，
// 有旧数据就继续用旧数据，否则交给错误面板，页面不能因此卡在“正在加载”。
function applyLoaded(loaded) {
  const previous = state.data;
  const next = {
    leaderboard: pick(loaded.leaderboard, previous.leaderboard),
    benchlm: pick(loaded.benchlm, previous.benchlm),
    modelMap: pick(loaded.modelMap, previous.modelMap),
  };

  if (next.leaderboard.ok) {
    try {
      const norm = normalizeLeaderboard(next.leaderboard.raw);
      if (norm.rows.length === 0) throw new Error('官方榜单没有返回任何可用的榜单行');
      const filter = mergeFilter(state.filter, norm.rows);
      state.norm = norm;
      state.filter = filter;
    } catch (err) {
      if (previous.leaderboard?.ok && next.leaderboard !== previous.leaderboard) {
        next.leaderboard = previous.leaderboard;
      } else {
        next.leaderboard = { ok: false, error: errorText(err) };
        state.norm = null;
      }
    }
  }

  if (next.benchlm.ok) {
    try {
      buildSupplementView({
        models: next.benchlm.models,
        pricing: next.benchlm.pricing,
        modelMap: next.modelMap?.map ?? {},
        vendorFilter: {},
      });
    } catch (err) {
      next.benchlm =
        previous.benchlm?.ok && next.benchlm !== previous.benchlm ? previous.benchlm : { ok: false, error: errorText(err) };
    }
  }

  state.data = next;
  warnMappingGaps();
}

async function reload() {
  let loaded;
  try {
    loaded = await loadAll();
  } catch (err) {
    const failure = { ok: false, error: errorText(err) };
    loaded = { leaderboard: failure, benchlm: failure, modelMap: { ...failure, map: {} } };
  }
  try {
    applyLoaded(loaded);
  } catch (err) {
    state.norm = null;
    const failure = { ok: false, error: errorText(err) };
    state.data = { leaderboard: failure, benchlm: failure, modelMap: { ...failure, map: {} } };
  }
}

/* ---------- 视图模型 ---------- */

function officialView() {
  return buildOfficialView({
    rows: state.norm.rows,
    filter: state.filter,
    metric: state.metric,
    bestOnly: state.bestOnly,
    truncated: state.norm.truncated,
  });
}

function supplementView() {
  const { benchlm, modelMap } = state.data;
  return buildSupplementView({
    models: benchlm.models,
    pricing: benchlm.pricing,
    modelMap: modelMap?.map ?? {},
    vendorFilter: state.vendorFilter,
  });
}

function currentUpstreamDate() {
  const lb = state.data.leaderboard;
  if (!lb?.ok || !state.norm) return null;
  return evaluateFreshness({
    upstreamUpdatedAtList: state.norm.rows.map((r) => r.updatedAt),
    fetchedAt: lb.fetchedAt,
    now: new Date(),
  }).upstreamUpdatedAt;
}

/* ---------- 顶部信息行与同步按钮 ---------- */

function isoDay(date) {
  return date ? date.toISOString().slice(0, 10) : '—';
}

function clockTime(date) {
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function fact(label, value) {
  return h('div', { class: 'fact' }, h('dt', { text: label }), h('dd', { class: 'num', text: value }));
}

function syncItems(fetchedAt, stale) {
  const fresh = evaluateFreshness({ upstreamUpdatedAtList: [], fetchedAt, now: new Date() });
  const facts = [fact('上次同步', fresh.fetchedAt ? formatAgo(fresh.agoMs) : '未知')];
  const flags = [];
  if (fresh.warn) {
    flags.push(h('p', { class: 'flag warn', role: 'status' }, h('span', { 'aria-hidden': 'true', text: '⚠ ' }), '已超过 48 小时未同步，数据可能已陈旧'));
  }
  // STALE/UPDATING 只表示正在给已过期的缓存并在后台更新，不代表上游故障，所以只陈述事实。
  if (stale) flags.push(h('p', { class: 'flag', text: '正在显示缓存数据，后台更新中' }));
  return { facts, flags };
}

function updateSyncButton() {
  const btn = $('sync-btn');
  if (!btn) return;
  const remaining = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
  if (state.loading) {
    // 首次加载没结束就点同步，"同步前的日期"是空的，结果提示会失去比较基准。
    btn.textContent = '立即同步';
    btn.disabled = true;
  } else if (state.refreshing) {
    btn.textContent = '同步中…';
    btn.disabled = true;
  } else if (remaining > 0) {
    const mm = Math.floor(remaining / 60);
    const ss = String(remaining % 60).padStart(2, '0');
    btn.textContent = `冷却中 ${mm}:${ss}`;
    btn.disabled = true;
  } else {
    btn.textContent = '立即同步';
    btn.disabled = false;
  }
}

function renderInfo() {
  const focusedId = document.activeElement?.id;
  const { leaderboard, benchlm } = state.data;
  let facts = [];
  let flags = [];
  let plain = null;

  if (state.loading) {
    plain = '正在加载数据…';
  } else if (state.source === 'official') {
    if (leaderboard?.ok && state.norm) {
      const { rows, notes } = state.norm;
      facts.push(fact('榜单行数', String(rows.length)));
      if (notes.nTrialsSet.length > 0) facts.push(fact('每行试验次数', notes.nTrialsSet.join(' / ')));
      facts.push(fact('官方数据更新于', isoDay(currentUpstreamDate())));
      const sync = syncItems(leaderboard.fetchedAt, leaderboard.stale);
      facts.push(...sync.facts);
      flags = sync.flags;
    } else {
      plain = '官方榜单数据暂不可用';
    }
  } else if (benchlm?.ok) {
    facts.push(fact('BenchLM 快照日期', isoDay(supplementView().snapshotAt)));
    const sync = syncItems(benchlm.fetchedAt, benchlm.stale);
    facts.push(...sync.facts);
    flags = sync.flags;
  } else {
    plain = 'BenchLM 数据暂不可用';
  }

  const nodes = [];
  nodes.push(plain ? h('p', { class: 'info-plain', text: plain }) : h('dl', { class: 'facts' }, facts));
  if (flags.length > 0) nodes.push(h('div', { class: 'flags' }, flags));
  nodes.push(h('button', { type: 'button', class: 'btn primary', id: 'sync-btn', onclick: onRefresh }));
  $('info-row').replaceChildren(...nodes);
  updateSyncButton();
  if (focusedId === 'sync-btn') $('sync-btn').focus({ preventScroll: true });
}

function renderSyncMessage() {
  const box = $('sync-msg');
  const msg = state.syncMessage;
  box.replaceChildren(msg ? h('span', { class: `msg ${msg.kind}`, text: msg.text }) : '');
}

/* ---------- 同步 ---------- */

let cooldownTimer = null;

function startCooldownTicker() {
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    updateSyncButton();
    if (state.cooldownUntil - Date.now() <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }, 1000);
}

// 服务端不论已刷新还是冷却中都可能带剩余冷却秒数，取最小者：它是“下一次可能成功”的最早时刻。
// 有失败时不禁用按钮：失败要能立刻重试，服务端自己会以 cooldown 回应并给出倒计时。
function cooldownSecondsFrom(result) {
  const parts = [result.leaderboard, result.benchlm];
  if (parts.some((p) => p?.status === 'failed')) return 0;
  const waits = parts.map((p) => p?.retryAfterSeconds).filter((n) => Number.isFinite(n) && n > 0);
  return waits.length > 0 ? Math.min(...waits) : 0;
}

function startCooldown(seconds) {
  if (seconds <= 0) return;
  state.cooldownUntil = Date.now() + seconds * 1000;
  startCooldownTicker();
}

async function onRefresh() {
  if (state.loading || state.refreshing || state.cooldownUntil > Date.now()) return;
  const before = currentUpstreamDate();
  state.refreshing = true;
  state.syncMessage = null;
  renderSyncMessage();
  updateSyncButton();

  let summary;
  try {
    const response = await postRefresh();
    if (response.ok) {
      await reload();
      summary = summarizeRefresh({
        beforeUpstreamUpdatedAt: before,
        afterUpstreamUpdatedAt: currentUpstreamDate(),
        result: response.result,
      });
      startCooldown(cooldownSecondsFrom(response.result));
    } else {
      summary = { kind: 'failed', text: `同步失败（${response.error}），仍显示旧数据` };
    }
  } catch (err) {
    summary = { kind: 'failed', text: `同步失败（${errorText(err)}），仍显示旧数据` };
  } finally {
    state.refreshing = false;
  }
  if (summary.kind === 'failed') summary = { ...summary, text: `${summary.text}，失败时间 ${clockTime(new Date())}` };

  state.syncMessage = summary;
  renderSyncMessage();
  render();
}

/* ---------- 主渲染 ---------- */

function setChromeVisible({ toolbar, legend, xTitle, notes }) {
  document.querySelector('.toolbar').hidden = !toolbar;
  $('legend').hidden = !legend;
  $('x-title').hidden = !xTitle;
  $('scroll-hint').hidden = !toolbar;
  $('notes').hidden = !notes;
  const dock = $('dock-panel');
  if (dock) dock.hidden = !notes;
}

function hideLadder() {
  renderBudgetLadder($('ladder'), null);
}

function showErrorPanel(name, error, otherAvailable, otherSource, otherLabel) {
  setChromeVisible({ toolbar: false, legend: false, xTitle: false, notes: false });
  hideLadder();
  const actions = [{ label: '重试', primary: true, onClick: onRetry }];
  if (otherAvailable) actions.push({ label: otherLabel, onClick: () => switchSource(otherSource) });
  renderStatePanel($('chart'), {
    kind: 'error',
    title: `${name}暂时无法加载`,
    message: `${error ?? '未知错误'}。服务端没有可用的缓存，请稍后重试。${otherAvailable ? '另一个视图的数据仍然可用。' : ''}`,
    actions,
  });
}

function showLoadingPanel(title) {
  setChromeVisible({ toolbar: false, legend: false, xTitle: false, notes: false });
  hideLadder();
  renderStatePanel($('chart'), { title });
}

async function onRetry() {
  state.loading = true;
  render();
  try {
    await reload();
  } finally {
    state.loading = false;
    render();
  }
}

function renderOfficial() {
  const { leaderboard, benchlm } = state.data;
  $('banner').hidden = true;
  $('metric-seg').hidden = false;
  $('best-only-label').hidden = false;

  if (state.loading) {
    showLoadingPanel('正在加载官方榜单…');
    return;
  }
  if (!leaderboard?.ok || !state.norm) {
    showErrorPanel('官方榜单', leaderboard?.error, benchlm?.ok, 'supplement', '查看补充视图');
    return;
  }

  const view = officialView();
  const hasPoints = view.points.length > 0;
  setChromeVisible({ toolbar: true, legend: true, xTitle: hasPoints, notes: true });
  renderFilterDropdown(
    $('filter-host'),
    officialFilterSpec(view, {
      onToggleRow: (model) => update(() => (state.filter = toggleModel(state.filter, model))),
      onToggleEffort: (model, effort) => update(() => (state.filter = toggleEffort(state.filter, model, effort))),
      onSelectAll: () => update(() => (state.filter = selectAll(state.filter))),
      onClear: () => update(() => (state.filter = clearAll(state.filter))),
    }),
  );
  // 先摆好预算梯再画图：预算梯显隐会改变图区宽度，晚于绘图就会触发一次重绘并打断阶梯线的首次动画。
  renderBudgetLadder($('ladder'), hasPoints ? view.budgetTable : null);
  renderOfficialLegend($('legend'), view, {
    showFrontier: state.showFrontier,
    onToggleFrontier: () => {
      state.showFrontier = !state.showFrontier;
      render();
    },
    onHoverFrontier: (hovered) => setFrontierHighlight(hovered),
    activeVendor: state.activeVendor,
    onHoverVendor: (vendor) => setVendorHighlight(vendor),
    onSelectVendor: (org) => {
      const tree = view.filterTree.filter((n) => n.org === org);
      if (tree.length === 0) return;
      const anySelected = tree.some((n) => n.selected > 0);
      let nextFilter = { ...state.filter, models: { ...state.filter.models } };
      for (const node of tree) {
        const entry = nextFilter.models[node.model];
        if (entry) {
          const targetValue = !anySelected;
          const updatedEfforts = Object.fromEntries(
            Object.keys(entry.efforts).map((e) => [e, targetValue])
          );
          nextFilter.models[node.model] = {
            selected: targetValue,
            efforts: updatedEfforts,
          };
        }
      }
      update(() => (state.filter = nextFilter));
    },
  });
  drawOfficialChart($('chart'), view, { showFrontier: state.showFrontier });
  applyLadder();
  renderXTitle($('x-title'), view.metric.axisTitle, view.metric.tooltipHtml);
  renderOfficialNotes($('notes'), view);
}

function renderSupplement() {
  const { leaderboard, benchlm } = state.data;
  $('metric-seg').hidden = true;
  $('best-only-label').hidden = true;

  if (state.loading) {
    $('banner').hidden = true;
    showLoadingPanel('正在加载 BenchLM 数据…');
    return;
  }
  $('banner').hidden = false;
  if (!benchlm?.ok) {
    showErrorPanel('BenchLM 数据', benchlm?.error, leaderboard?.ok, 'official', '查看官方视图');
    return;
  }

  setChromeVisible({ toolbar: true, legend: true, xTitle: true, notes: true });
  hideLadder();
  const view = supplementView();
  state.lastSupplementVendors = view.vendors;
  renderFilterDropdown(
    $('filter-host'),
    supplementFilterSpec(view, {
      onToggleRow: (creator) =>
        update(() => (state.vendorFilter = { ...state.vendorFilter, [creator]: state.vendorFilter[creator] === false })),
      onToggleEffort: () => {},
      onSelectAll: () => update(() => (state.vendorFilter = {})),
      onClear: () =>
        update(() => (state.vendorFilter = Object.fromEntries(state.lastSupplementVendors.map((v) => [v.creator, false])))),
    }),
  );
  renderSupplementLegend($('legend'), view, {
    showFrontier: state.showFrontier,
    onToggleFrontier: () => {
      state.showFrontier = !state.showFrontier;
      render();
    },
    onHoverFrontier: (hovered) => setFrontierHighlight(hovered),
    activeVendor: state.activeVendor,
    onHoverVendor: (vendor) => setVendorHighlight(vendor),
    onSelectVendor: (creator) => {
      update(() => {
        state.vendorFilter = {
          ...state.vendorFilter,
          [creator]: state.vendorFilter[creator] === false,
        };
      });
    },
  });
  drawSupplementChart($('chart'), view, { showFrontier: state.showFrontier });
  renderXTitle($('x-title'), '输出单价（美元 / 百万 token，不是每任务成本）', null);
  renderSupplementNotes($('notes'), view);
}

function syncControls() {
  for (const btn of document.querySelectorAll('#source-seg button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.source === state.source));
  }
  for (const btn of document.querySelectorAll('#metric-seg button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.metric === state.metric));
  }
  $('best-only').checked = state.bestOnly;
}

// 渲染中任何一步抛错都落到可重试的错误面板，而不是留下半张页面。
function render() {
  try {
    hideTip();
    syncControls();
    renderInfo();
    if (state.source === 'official') renderOfficial();
    else renderSupplement();
  } catch (err) {
    console.error('页面渲染失败', err);
    setChromeVisible({ toolbar: false, legend: false, xTitle: false, notes: false });
    hideLadder();
    renderStatePanel($('chart'), {
      kind: 'error',
      title: '页面渲染出错',
      message: `${errorText(err)}。请重试；如果反复出现，说明上游数据的格式有变化。`,
      actions: [{ label: '重试', primary: true, onClick: onRetry }],
    });
  }
}

function update(mutate) {
  mutate();
  render();
}

function switchSource(source) {
  state.source = source;
  render();
}

/* ---------- 事件与启动 ---------- */

function bindEvents() {
  for (const btn of document.querySelectorAll('#source-seg button')) {
    btn.addEventListener('click', () => switchSource(btn.dataset.source));
  }
  for (const btn of document.querySelectorAll('#metric-seg button')) {
    btn.addEventListener('click', () => update(() => (state.metric = btn.dataset.metric)));
  }
  $('best-only').addEventListener('change', (e) => update(() => (state.bestOnly = e.target.checked)));
  $('theme-btn').addEventListener('click', () => {
    applyTheme(THEME_MODES[(THEME_MODES.indexOf(state.themeMode) + 1) % THEME_MODES.length]);
    render();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.themeMode === 'auto') render();
  });

  let lastWidth = $('chart-scroll').clientWidth;
  let raf = 0;
  new ResizeObserver(() => {
    const width = $('chart-scroll').clientWidth;
    if (width === lastWidth) return;
    lastWidth = width;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }).observe($('chart-scroll'));

  setInterval(() => {
    if (!state.loading && !state.refreshing) {
      try {
        renderInfo();
      } catch (err) {
        console.error('顶部信息刷新失败', err);
      }
    }
  }, AGO_TICK_MS);
}

async function start() {
  state.themeMode = readThemeMode();
  $('theme-btn').textContent = THEME_LABELS[state.themeMode];
  bindEvents();
  render();
  try {
    await reload();
  } finally {
    state.loading = false;
    render();
  }
}

start();
