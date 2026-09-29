import { EFFORT_ORDER } from './viewmodel.js';

const d3 = window.d3;
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------- DOM 小工具 ---------- */

// 模型名等来自上游数据，一律用 textContent / setAttribute 写入，不拼 innerHTML。
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

function s(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
}

function appendChildren(node, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function clear(node) {
  node.replaceChildren();
}

/* ---------- 颜色 ---------- */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function vendorSlug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// 未知厂商落到 --v-other，保证新增厂商时页面不会出现没有颜色的点。
export function vendorColor(name) {
  return cssVar(`--v-${vendorSlug(name)}`) || cssVar('--v-other');
}

// “越深”通过向纸色混合的比例表达：档位越低混得越多。这样浅色主题里是变深，深色主题里是变亮，两边都保持可辨。
function effortShade(base, effort) {
  const idx = EFFORT_ORDER.indexOf(effort);
  const rank = idx === -1 ? 2 : idx;
  const mix = 0.5 * (1 - rank / (EFFORT_ORDER.length - 1));
  return d3.interpolateRgb(base, cssVar('--paper'))(mix);
}

/* ---------- 格式化 ---------- */

const dash = '—';

function fmtNum(v, digits = 2) {
  return v === null || v === undefined || !Number.isFinite(v) ? dash : Number(v.toFixed(digits)).toString();
}
export function fmtCost(v) {
  return v === null || v === undefined ? dash : `$${v.toFixed(2)}`;
}
function fmtTokens(v) {
  return v === null || v === undefined ? dash : Math.round(v).toLocaleString('en-US');
}
function fmtDuration(v) {
  return v === null || v === undefined ? dash : `${Math.round(v).toLocaleString('en-US')} 秒（约 ${(v / 60).toFixed(1)} 分钟）`;
}
function fmtScore(score, ci) {
  return ci === null || ci === undefined ? `${fmtNum(score)}%` : `${fmtNum(score)}% ± ${fmtNum(ci)}`;
}
function fmtPrice(v) {
  return `$${Number(v.toPrecision(3)).toString()} / 百万 token`;
}

const AXIS_FORMATS = {
  cost: (d) => `$${d}`,
  outTokens: (d) => d3.format('~s')(d),
  duration: (d) => d3.format(',')(d),
};

/* ---------- 动效：阶梯线首次绘制 ---------- */

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 只在页面生命周期内的第一张带前沿线的图上播放：筛选、切换指标与缩放的重绘都不重播。
// 例外：动画进行中恰好被布局变化（滚动条出现、预算梯显隐）触发重绘时，用负延迟接着播剩余部分，
// 否则动画会被新图直接顶掉，用户什么都没看到。
const INTRO_MS = 700;
let introStartedAt = null;

function playFrontierIntro(path) {
  const now = performance.now();
  if (introStartedAt === null) introStartedAt = now;
  const elapsed = now - introStartedAt;
  if (elapsed >= INTRO_MS || reducedMotion() || typeof path.animate !== 'function') return;
  // 阶梯线从成本最低的一端（图的右侧）起笔，所以沿路径方向画出就是自右向左。
  path.animate(
    [
      { strokeDasharray: '1 1', strokeDashoffset: 1 },
      { strokeDasharray: '1 1', strokeDashoffset: 0 },
    ],
    { duration: INTRO_MS, delay: -elapsed, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
  );
}

// 最优前沿连接线：点与点之间以直线直接连接
function straightFrontierPath(pts, xOf, yOf) {
  let d = `M${xOf(pts[0])},${yOf(pts[0])}`;
  for (let i = 1; i < pts.length; i++) d += `L${xOf(pts[i])},${yOf(pts[i])}`;
  return d;
}

/* ---------- 悬停提示 ---------- */

const tipEl = () => document.getElementById('tooltip');

function placeTip(clientX, clientY) {
  const tip = tipEl();
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  let left = clientX + 14;
  let top = clientY + 14;
  if (left + box.width > window.innerWidth - 8) left = clientX - 14 - box.width;
  if (top + box.height > window.innerHeight - 8) top = clientY - 14 - box.height;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function showTip(content, clientX, clientY) {
  const tip = tipEl();
  tip.replaceChildren(content);
  placeTip(clientX, clientY);
}

function showTipAtElement(content, element) {
  const r = element.getBoundingClientRect();
  showTip(content, r.left + r.width / 2, r.top + r.height / 2);
}

export function hideTip() {
  tipEl().hidden = true;
}

function tipTable(title, rows) {
  const dl = h('dl');
  for (const [k, v] of rows) dl.append(h('dt', { text: k }), h('dd', { text: v }));
  return h('div', {}, h('div', { class: 't-title', text: title }), dl);
}

function bindTip(target, buildContent) {
  target.addEventListener('mouseenter', (e) => showTip(buildContent(), e.clientX, e.clientY));
  target.addEventListener('mousemove', (e) => placeTip(e.clientX, e.clientY));
  target.addEventListener('mouseleave', hideTip);
  target.addEventListener('focus', () => showTipAtElement(buildContent(), target));
  target.addEventListener('blur', hideTip);
}

function geometry(container) {
  const scrollBox = container.closest('.chart-scroll') || container.parentElement || container;
  const avail = scrollBox.clientWidth || container.clientWidth || 920;
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 1000;
  const isNarrow = avail < 600;
  const isTablet = !isDesktop && avail >= 600;

  // 画布几何：窄屏（<600px）与平板在滚动容器内给予充分避让宽度；
  // 桌面端（>=1000px）自适应填满容器宽度，不产生多余水平滚动条
  const minWidth = isDesktop ? avail : (isNarrow ? 880 : 960);
  const width = Math.max(avail, minWidth);
  const height = isNarrow ? 530 : (isTablet ? 560 : 580);

  return {
    W: width,
    H: height,
    m: { top: 38, right: 96, bottom: 44, left: 68 },
    isNarrow,
  };
}

function overlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const hh = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && hh > 0 ? w * hh : 0;
}

function generateCandidates(x, y, w, hh, bounds) {
  const gap = 8;
  const cands = [];
  const visL = bounds.visibleLeft;

  const add = (anchor, x0, y0, dist, pref) => {
    // 1. 画布物理边缘硬约束
    if (x0 < bounds.x0 || x0 + w > bounds.x1 || y0 < bounds.y0 || y0 + hh > bounds.y1) {
      return;
    }
    // 2. 窄屏视口边界硬约束：
    // 点在当前视口内（右侧前沿/低成本侧）：文字笔画必须完整位于视口内，绝不向左超出视口左缘被截断
    if (visL !== undefined) {
      if (x >= visL - 6) {
        if (x0 < visL + 4) return;
      } else {
        // 点在当前视口左侧外：标签绝不向右穿过视口边缘造成半切
        if (x0 + w > visL - 3) return;
      }
    }
    cands.push({ anchor, x0, y0, dist, pref });
  };

  // Level 1: 紧凑方位（无需引线，距离 8-16px）
  add('start', x + gap, y - hh / 2, 8, 0);       // 右
  add('start', x + gap, y - hh, 10, 1);          // 右上
  add('start', x + gap, y, 10, 1);               // 右下
  add('middle', x - w / 2, y - gap - hh, 8, 2);  // 上
  add('middle', x - w / 2, y + gap, 8, 2);       // 下
  add('end', x - gap - w, y - hh / 2, 8, 3);     // 左
  add('end', x - gap - w, y - hh, 10, 4);        // 左上
  add('end', x - gap - w, y, 10, 4);             // 左下

  // 微偏移方位（距离 14-24px）
  add('start', x + gap + 8, y - hh / 2 - 10, 16, 5);
  add('start', x + gap + 8, y - hh / 2 + 10, 16, 5);
  add('end', x - gap - 8 - w, y - hh / 2 - 10, 16, 6);
  add('end', x - gap - 8 - w, y - hh / 2 + 10, 16, 6);
  add('middle', x - w / 2, y - gap - hh - 10, 18, 7);
  add('middle', x - w / 2, y + gap + 10, 18, 7);

  // Level 2: 测绘辐射引线方位（当局部拥挤时向外围槽位辐射，距离 32 到 150px）
  const distances = [32, 50, 72, 98, 126, 156];
  const anglesDeg = [
    10, 30, 50, 70, 90, 110, 130, 150, 170,
    190, 210, 230, 250, 270, 290, 310, 330, 350
  ];

  for (const d of distances) {
    for (const deg of anglesDeg) {
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = x + d * cos;
      const cy = y + d * sin;

      let anchor = 'start';
      let x0 = cx;
      let y0 = cy - hh / 2;

      if (cos < -0.3) {
        anchor = 'end';
        x0 = cx - w;
      } else if (Math.abs(cos) <= 0.3) {
        anchor = 'middle';
        x0 = cx - w / 2;
      }

      // 偏向：优先右上、上方与右方，更远距离惩罚更高
      const pref = 10 + d * 0.4 + (anchor === 'end' ? 2 : 0) + (sin > 0 ? 1 : 0);
      add(anchor, x0, y0, d, pref);
    }
  }

  // 极端情况兜底候选：保证至少有位置可选
  if (cands.length === 0) {
    let fallbackX = Math.max(bounds.x0, x + gap);
    if (visL !== undefined) {
      if (x >= visL - 6) {
        fallbackX = visL + 6;
      } else {
        fallbackX = Math.max(bounds.x0, Math.min(x - gap - w, visL - 4 - w));
      }
    }
    cands.push({
      anchor: 'start',
      x0: Math.min(fallbackX, bounds.x1 - w),
      y0: Math.max(bounds.y0, Math.min(y, bounds.y1 - hh)),
      dist: 20,
      pref: 500,
    });
  }

  return cands;
}

// 模拟退火松弛算法（Simulated Annealing Relaxation）：
// 1. 绝对零重叠：重叠面积惩罚极大（1e8+），决不选相交方案；
// 2. 测绘辐射引线：当近处被其他星点占据时，将标签引到外围清空槽位，并用 1px 虚线连接；
// 3. 视口感知：保证落在滚动视窗内的文字笔画完整不被裁切。
function placeLabels(items, bounds) {
  const n = items.length;
  if (n === 0) return new Map();

  const marks = items.map((it) => ({ x0: it.x - 7, y0: it.y - 7, x1: it.x + 7, y1: it.y + 7 }));
  const candidatesPerItem = items.map((it) => generateCandidates(it.x, it.y, it.w, it.h, bounds));

  function evaluateCandidate(itemIdx, cand, currentRects) {
    const { x, y, w, h: hh } = items[itemIdx];
    const rect = { x0: cand.x0, y0: cand.y0, x1: cand.x0 + w, y1: cand.y0 + hh };

    // 1. 越界硬惩罚
    let outPenalty = 0;
    if (rect.x0 < bounds.x0) outPenalty += 1e9 + (bounds.x0 - rect.x0) * 1e4;
    if (rect.x1 > bounds.x1) outPenalty += 1e9 + (rect.x1 - bounds.x1) * 1e4;
    if (rect.y0 < bounds.y0) outPenalty += 1e9 + (bounds.y0 - rect.y0) * 1e4;
    if (rect.y1 > bounds.y1) outPenalty += 1e9 + (rect.y1 - bounds.y1) * 1e4;

    // 2. 标签与标签重叠惩罚：决不容忍任何重叠
    let labelOverlapCost = 0;
    for (let j = 0; j < n; j++) {
      if (j === itemIdx || !currentRects[j]) continue;
      const area = overlapArea(rect, currentRects[j]);
      if (area > 0) {
        labelOverlapCost += 1e8 + area * 1e4;
      }
    }

    // 3. 标签与数据点标记重叠惩罚
    let markOverlapCost = 0;
    for (let j = 0; j < n; j++) {
      if (j === itemIdx) continue;
      const area = overlapArea(rect, marks[j]);
      if (area > 0) {
        markOverlapCost += 1e7 + area * 1e3;
      }
    }

    const prefCost = cand.pref || 0;
    return { ...cand, rect, cost: outPenalty + labelOverlapCost + markOverlapCost + prefCost };
  }

  // 排序：邻居密度最高的点优先选位
  const neighborCount = items.map((a, i) => {
    let count = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j && Math.hypot(a.x - items[j].x, a.y - items[j].y) < 70) count++;
    }
    return { i, count, x: a.x };
  });
  const order = neighborCount.sort((a, b) => b.count - a.count || b.x - a.x).map((o) => o.i);

  const currentRects = new Array(n).fill(null);
  const currentBest = new Array(n).fill(null);

  // 第一轮：贪心初始化
  for (const i of order) {
    let best = null;
    for (const c of candidatesPerItem[i]) {
      const scored = evaluateCandidate(i, c, currentRects);
      if (!best || scored.cost < best.cost) best = scored;
      if (best.cost === 0) break;
    }
    currentRects[i] = best.rect;
    currentBest[i] = best;
  }

  // 多轮退火松弛：8 轮迭代打破死锁，直到零重叠
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const i of order) {
      let best = null;
      for (const c of candidatesPerItem[i]) {
        const scored = evaluateCandidate(i, c, currentRects);
        if (!best || scored.cost < best.cost) best = scored;
      }
      if (best && best.cost < currentBest[i].cost) {
        currentRects[i] = best.rect;
        currentBest[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 计算测绘引线
  const result = new Map();
  for (let i = 0; i < n; i++) {
    const b = currentBest[i];
    const it = items[i];
    let line = null;
    if (b.dist && b.dist > 18) {
      const rx = Math.max(b.rect.x0, Math.min(it.x, b.rect.x1));
      const ry = Math.max(b.rect.y0, Math.min(it.y, b.rect.y1));
      line = { x1: it.x, y1: it.y, x2: rx, y2: ry };
    }
    result.set(i, { ...b, line });
  }
  return result;
}

function labelNode(item, pos) {
  const tx = pos.anchor === 'start' ? pos.rect.x0 : pos.anchor === 'end' ? pos.rect.x1 : (pos.rect.x0 + pos.rect.x1) / 2;
  const g = s('g', {
    class: `lbl${item.onFrontier ? ' on-frontier' : ''}`,
    'data-model': item.model || item.name,
    'data-org': item.org || '',
  });
  g.append(s('text', { class: 'name', x: tx, y: pos.rect.y0 + 10, 'text-anchor': pos.anchor, text: item.name }));
  if (item.sub) g.append(s('text', { class: 'sub', x: tx, y: pos.rect.y0 + 22, 'text-anchor': pos.anchor, text: item.sub }));
  return g;
}

// 11.5px 字号、600 字重加 3px 描边下，拉丁字符估 7.2px、汉字 12.5px，并留 4px 安全缓冲。
function textWidth(text, latin) {
  let w = 0;
  for (const ch of String(text)) w += ch.charCodeAt(0) > 255 ? 12.5 : latin;
  return w;
}

function labelItem(x, y, name, sub) {
  const w = Math.ceil(Math.max(textWidth(name, 7.2), sub ? textWidth(sub, 6.5) : 0)) + 6;
  return { x, y, w, h: sub ? 26 : 16, name, sub };
}

function drawAxes(svg, { W, H, m }, x, y, xTickFormat, yTickValues, xTickValues) {
  const plotBottom = H - m.bottom;
  const grid = s('g', { class: 'grid' });
  for (const t of yTickValues) {
    grid.append(s('g', { class: t === 0 ? 'zero' : '' }, s('line', { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t) })));
  }
  for (const t of xTickValues) {
    grid.append(s('line', { x1: x(t), x2: x(t), y1: m.top, y2: plotBottom }));
  }
  svg.append(grid);

  // 天文坐标边框与四角分划标尺（Astrometric Reticle Frame）
  const reticle = s('g', { class: 'reticle-corners' });
  reticle.append(
    s('rect', {
      x: m.left,
      y: m.top,
      width: W - m.left - m.right,
      height: plotBottom - m.top,
      fill: 'none',
      stroke: 'var(--line)',
      'stroke-width': 1,
    }),
  );
  const cornerLen = 10;
  reticle.append(s('path', { d: `M${m.left},${m.top + cornerLen} V${m.top} H${m.left + cornerLen}`, stroke: 'var(--line-strong)', fill: 'none', 'stroke-width': 1.5 }));
  reticle.append(s('path', { d: `M${W - m.right - cornerLen},${m.top} H${W - m.right} V${m.top + cornerLen}`, stroke: 'var(--line-strong)', fill: 'none', 'stroke-width': 1.5 }));
  reticle.append(s('path', { d: `M${W - m.right},${plotBottom - cornerLen} V${plotBottom} H${W - m.right - cornerLen}`, stroke: 'var(--line-strong)', fill: 'none', 'stroke-width': 1.5 }));
  reticle.append(s('path', { d: `M${m.left + cornerLen},${plotBottom} H${m.left} V${plotBottom - cornerLen}`, stroke: 'var(--line-strong)', fill: 'none', 'stroke-width': 1.5 }));
  svg.append(reticle);

  const xAxis = d3.axisBottom(x).tickValues(xTickValues).tickFormat(xTickFormat).tickSizeOuter(0);
  const yAxis = d3.axisLeft(y).tickValues(yTickValues).tickSizeOuter(0);
  const gx = s('g', { class: 'axis', transform: `translate(0,${plotBottom})` });
  const gy = s('g', { class: 'axis', transform: `translate(${m.left},0)` });
  svg.append(gx, gy);
  d3.select(gx).call(xAxis);
  d3.select(gy).call(yAxis);
}

function yTitle(svg, { H, m }, text) {
  const cy = m.top + (H - m.top - m.bottom) / 2;
  svg.append(s('text', { class: 'y-title', transform: `translate(14,${cy}) rotate(-90)`, 'text-anchor': 'middle', text }));
}

function makeSvg({ W, H }, label) {
  return s('svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'group', 'aria-label': label });
}

function emptyChart(container, text) {
  clear(container);
  container.append(h('div', { class: 'state-panel', role: 'status' }, h('p', { text })));
}

/* ---------- 官方视图 ---------- */

// 预算梯需要知道当前图里有哪些点和预算标尺，每次重绘时更新。
let activeChart = null;

export function drawOfficialChart(container, view, options = {}) {
  clear(container);
  hideTip();
  activeChart = null;
  const showFrontier = options.showFrontier ?? true;
  if (view.points.length === 0) {
    emptyChart(
      container,
      view.counts.selected === 0
        ? '没有选中的配置，请全选或选一个模型'
        : '没有可显示的榜单行：请在“配置”里选择模型与档位，或换一个指标。',
    );
    return;
  }
  const geo = geometry(container);
  const { W, H, m } = geo;
  const pts = view.points;
  const byId = new Map(pts.map((p) => [p.id, p]));

  const xMax = d3.max(pts, (p) => p.x) * 1.06 || 1;
  const x = d3.scaleLinear().domain([xMax, 0]).nice().range([m.left, W - m.right]);
  const yTop = d3.max(pts, (p) => p.y + (p.ciHalf ?? 0));
  const y = d3.scaleLinear().domain([0, yTop]).nice().range([H - m.bottom, m.top]);
  y.domain([0, Math.min(100, y.domain()[1])]);

  const svg = makeSvg(geo, `${view.metric.axisTitle}与分数的散点图，共 ${pts.length} 个点`);
  if (!showFrontier) svg.classList.add('hide-frontier');
  drawAxes(svg, geo, x, y, AXIS_FORMATS[view.metric.key], y.ticks(6), x.ticks(6));
  yTitle(svg, geo, 'Terminal-Bench 4.0 分数（任务完成率）');

  // 预算标尺放在点和线的下面：高亮区域只是背景，不能盖住悬停目标。
  const marks = new Map();
  if (view.budgetTable) {
    const plotRight = W - m.right;
    const plotBottom = H - m.bottom;
    for (const { limit } of view.budgetTable) {
      const xr = Math.min(plotRight, Math.max(m.left, x(limit)));
      const flip = xr + 56 > plotRight;
      const mark = s(
        'g',
        { class: 'budget-mark', 'data-limit': limit },
        s('rect', { class: 'zone', x: xr, y: m.top, width: plotRight - xr, height: plotBottom - m.top }),
        s('line', { class: 'ruler', x1: xr, x2: xr, y1: m.top - 6, y2: plotBottom }),
        s('text', { x: flip ? xr - 6 : xr + 6, y: m.top - 8, 'text-anchor': flip ? 'end' : 'start', text: `≤$${limit}` }),
      );
      marks.set(limit, mark);
      svg.append(mark);
    }
  }

  const colorOf = (p) => effortShade(vendorColor(p.org), p.effort);

  const linesG = s('g');
  for (const line of view.lines) {
    const coords = line.pointIds.map((id) => byId.get(id)).map((p) => [x(p.x), y(p.y)]);
    linesG.append(
      s('path', {
        class: 'trajectory-line',
        'data-model': line.model,
        'data-org': line.org,
        d: d3.line()(coords),
        fill: 'none',
        stroke: vendorColor(line.org),
        'stroke-width': 2,
        'stroke-opacity': 0.55,
        'stroke-linejoin': 'round',
      }),
    );
  }
  svg.append(linesG);

  const frontierPts = view.frontier.pointIds.map((id) => byId.get(id));
  let frontierPath = null;
  if (frontierPts.length >= 2) {
    frontierPath = s('path', {
      class: `frontier-line${showFrontier ? '' : ' is-hidden'}`,
      pathLength: 1,
      d: straightFrontierPath(frontierPts, (p) => x(p.x), (p) => y(p.y)),
    });
    if (!showFrontier) frontierPath.style.display = 'none';
    svg.append(frontierPath);
  }

  const reticleG = s('g', { class: 'crosshairs' });
  const overlay = s('g', { class: 'ci-bar' });
  const pointsG = s('g');
  const groups = new Map();

  function showCrosshairs(p) {
    clear(reticleG);
    const px = x(p.x);
    const py = y(p.y);
    reticleG.append(
      s('line', { class: 'crosshair-line crosshair-x', x1: px, x2: px, y1: py, y2: H - m.bottom }),
      s('line', { class: 'crosshair-line crosshair-y', x1: m.left, x2: px, y1: py, y2: py }),
    );
  }
  function clearCrosshairs() {
    clear(reticleG);
  }

  function showModelFocus(model) {
    svg.classList.add('has-model-focus');
    for (const pt of pts) {
      const el = groups.get(pt.id);
      if (el) el.classList.toggle('model-match', pt.model === model);
    }
    for (const lineEl of linesG.children) {
      lineEl.classList.toggle('model-match', lineEl.getAttribute('data-model') === model);
    }
    // 标签不在点的分组里。只给点打 model-match 时，同模型各档位的名字会和别人一起被淡掉。
    for (const el of svg.querySelectorAll('.lbl')) {
      el.classList.toggle('model-match', el.getAttribute('data-model') === model);
    }
  }
  function clearModelFocus() {
    svg.classList.remove('has-model-focus');
    for (const el of groups.values()) el.classList.remove('model-match');
    for (const lineEl of linesG.children) lineEl.classList.remove('model-match');
    for (const el of svg.querySelectorAll('.lbl.model-match')) el.classList.remove('model-match');
  }

  function linkBudgetLadder(p) {
    if (!view.budgetTable) return;
    for (const { limit, best } of view.budgetTable) {
      if (best.some((b) => b.id === p.id)) {
        document.querySelector(`.tier[data-limit="${limit}"]`)?.classList.add('linked-highlight');
      }
    }
  }
  function clearBudgetLadderLink() {
    for (const el of document.querySelectorAll('.tier.linked-highlight')) {
      el.classList.remove('linked-highlight');
    }
  }

  for (const p of pts) {
    const r = p.onFrontier ? 7 : 5;
    const mark = s('circle', {
      class: `pt-mark${p.onFrontier ? ' on-frontier-mark' : ''}`,
      r,
      fill: colorOf(p),
      stroke: p.onFrontier ? (cssVar('--frontier') || cssVar('--accent')) : cssVar('--paper'),
      'stroke-width': p.onFrontier ? 3 : 1.5,
    });
    const g = s(
      'g',
      {
        class: `pt${p.onFrontier ? ' on-frontier' : ''}`,
        'data-id': p.id,
        'data-model': p.model,
        'data-org': p.org,
        transform: `translate(${x(p.x)},${y(p.y)})`,
        tabindex: 0,
        role: 'img',
        'aria-label': `${p.model}，${p.framework}，${p.effort}，分数 ${fmtNum(p.score)}，${view.metric.label} ${fmtMetricValue(view.metric.key, p.x)}`,
      },
      s('circle', { r: 13, fill: 'transparent' }),
      s('circle', { class: 'best-ring', r: r + 6 }),
      mark,
    );
    bindTip(g, () => {
      drawCi(overlay, x, y, p);
      return officialTip(p);
    });
    g.addEventListener('mouseenter', () => {
      showCrosshairs(p);
      showModelFocus(p.model);
      linkBudgetLadder(p);
    });
    g.addEventListener('mouseleave', () => {
      clear(overlay);
      clearCrosshairs();
      clearModelFocus();
      clearBudgetLadderLink();
    });
    g.addEventListener('focus', () => {
      showCrosshairs(p);
      showModelFocus(p.model);
      linkBudgetLadder(p);
    });
    g.addEventListener('blur', () => {
      clear(overlay);
      clearCrosshairs();
      clearModelFocus();
      clearBudgetLadderLink();
    });
    groups.set(p.id, g);
    pointsG.append(g);
  }
  svg.append(reticleG, pointsG);

  const items = pts.map((p) => {
    const it = labelItem(x(p.x), y(p.y), p.model, p.effort);
    it.model = p.model;
    it.org = p.org;
    it.onFrontier = p.onFrontier;
    return it;
  });
  const scrollBox = document.getElementById('chart-scroll');
  const viewWidth = scrollBox ? scrollBox.clientWidth : container.clientWidth;
  const visibleLeft = W > viewWidth ? Math.max(0, W - viewWidth) : undefined;
  const bounds = {
    x0: 4,
    y0: 4,
    x1: W - 4,
    y1: H - m.bottom,
    visibleLeft,
  };
  const placed = placeLabels(items, bounds);

  const leadersG = s('g', { class: 'lbl-leaders' });
  const labelsG = s('g', { class: 'lbls' });
  items.forEach((it, i) => {
    const pos = placed.get(i);
    if (pos && pos.line) {
      leadersG.append(s('line', {
        class: 'lbl-line',
        x1: pos.line.x1,
        y1: pos.line.y1,
        x2: pos.line.x2,
        y2: pos.line.y2,
      }));
    }
    labelsG.append(labelNode(it, pos));
  });
  svg.append(leadersG, labelsG, overlay);

  container.append(svg);
  activeChart = { view, marks, groups };
  if (scrollBox && scrollBox.scrollWidth > scrollBox.clientWidth) {
    scrollBox.scrollLeft = scrollBox.scrollWidth - scrollBox.clientWidth;
  }
  if (frontierPath && showFrontier) playFrontierIntro(frontierPath);
}

function fmtMetricValue(key, v) {
  if (key === 'cost') return fmtCost(v);
  if (key === 'outTokens') return fmtTokens(v);
  return fmtDuration(v);
}

function drawCi(overlay, x, y, p) {
  clear(overlay);
  if (p.ciHalf === null || p.ciHalf === undefined) return;
  const px = x(p.x);
  const lo = y(Math.max(0, p.y - p.ciHalf));
  const hi = y(Math.min(100, p.y + p.ciHalf));
  overlay.append(
    s('line', { x1: px, x2: px, y1: lo, y2: hi }),
    s('line', { x1: px - 5, x2: px + 5, y1: lo, y2: lo }),
    s('line', { x1: px - 5, x2: px + 5, y1: hi, y2: hi }),
  );
}

function officialTip(p) {
  return tipTable(p.model, [
    ['框架', p.framework],
    ['档位', p.effort],
    ['分数', fmtScore(p.score, p.ciHalf)],
    ['成本', fmtCost(p.cost)],
    ['输出 token', fmtTokens(p.outTokens)],
    ['耗时', fmtDuration(p.durationSec)],
    ['发布日期', p.releaseDate ?? dash],
  ]);
}

// limit 为 null 表示恢复原状。区域外的点变淡、该档的最佳点加外圈，键盘聚焦与悬停走同一条路径。
export function setBudgetHighlight(limit) {
  const chart = activeChart;
  if (!chart) return;
  for (const [l, mark] of chart.marks) mark.classList.toggle('is-on', l === limit);
  const entry = limit === null ? null : chart.view.budgetTable?.find((t) => t.limit === limit);
  const bestIds = new Set((entry?.best ?? []).map((p) => p.id));
  for (const p of chart.view.points) {
    const g = chart.groups.get(p.id);
    g.classList.toggle('is-best', bestIds.has(p.id));
    g.classList.toggle('is-out', entry != null && !(p.x <= limit));
  }
}

/* ---------- 补充视图 ---------- */

const PRICE_TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];

export function drawSupplementChart(container, view, options = {}) {
  clear(container);
  hideTip();
  activeChart = null;
  const showFrontier = options.showFrontier ?? true;
  if (view.points.length === 0) {
    emptyChart(container, '没有可显示的模型：请在“厂商”筛选里选择至少一家。');
    return;
  }
  const geo = geometry(container);
  const { W, H, m } = geo;
  const pts = view.points;
  const byId = new Map(pts.map((p) => [p.slug, p]));

  const pMin = d3.min(pts, (p) => p.price);
  const pMax = d3.max(pts, (p) => p.price);
  const x = d3.scaleLog().domain([pMax * 1.5, pMin / 1.5]).range([m.left, W - m.right]);
  const yHi = Math.min(100, d3.max(pts, (p) => p.score) + 6);
  // 分数为 0 的点是有效数据，下边界留出空间才不会被压在坐标轴上。
  const y = d3.scaleLinear().domain([-5, yHi]).range([H - m.bottom, m.top]);
  const [dLo, dHi] = x.domain();
  const xTicks = PRICE_TICKS.filter((t) => t <= dLo && t >= dHi);
  const yTicks = y.ticks(6).filter((t) => t >= 0);

  const svg = makeSvg(geo, `输出单价与 Artificial Analysis 分数的散点图，共 ${pts.length} 个模型`);
  if (!showFrontier) svg.classList.add('hide-frontier');
  drawAxes(svg, geo, x, y, (d) => `$${d}`, yTicks, xTicks);
  yTitle(svg, geo, 'Terminal-Bench 4.0 分数（AA 评测）');

  const frontierPts = view.frontier.pointIds.map((id) => byId.get(id));
  let frontierPath = null;
  if (frontierPts.length >= 2) {
    const xOf = (p) => x(p.price);
    const yOf = (p) => y(p.score);
    frontierPath = s('path', {
      class: `frontier-line${showFrontier ? '' : ' is-hidden'}`,
      pathLength: 1,
      d: straightFrontierPath(frontierPts, xOf, yOf),
    });
    if (!showFrontier) frontierPath.style.display = 'none';
    svg.append(frontierPath);
    // 注记放在两点间距最长的一段线段上方
    let longest = { len: -1, cx: 0, cy: 0 };
    for (let i = 0; i < frontierPts.length - 1; i++) {
      const len = Math.hypot(xOf(frontierPts[i + 1]) - xOf(frontierPts[i]), yOf(frontierPts[i + 1]) - yOf(frontierPts[i]));
      if (len > longest.len) longest = { len, cx: (xOf(frontierPts[i]) + xOf(frontierPts[i + 1])) / 2, cy: (yOf(frontierPts[i]) + yOf(frontierPts[i + 1])) / 2 };
    }
    const noteEl = s('text', {
      class: `frontier-note${showFrontier ? '' : ' is-hidden'}`,
      x: longest.cx,
      y: longest.cy - 10,
      'text-anchor': 'middle',
      text: '最优前沿（按单价）',
    });
    if (!showFrontier) noteEl.style.display = 'none';
    svg.append(noteEl);
  }

  const reticleG = s('g', { class: 'crosshairs' });
  const pointsG = s('g');

  function showCrosshairs(p) {
    clear(reticleG);
    const px = x(p.price);
    const py = y(p.score);
    reticleG.append(
      s('line', { class: 'crosshair-line crosshair-x', x1: px, x2: px, y1: py, y2: H - m.bottom }),
      s('line', { class: 'crosshair-line crosshair-y', x1: m.left, x2: px, y1: py, y2: py }),
    );
  }
  function clearCrosshairs() {
    clear(reticleG);
  }

  for (const p of pts) {
    const size = p.onFrontier ? 110 : 64;
    const symbol = p.alsoOfficial ? d3.symbolDiamond : d3.symbolCircle;
    const mark = s('path', {
      class: `pt-mark${p.onFrontier ? ' on-frontier-mark' : ''}`,
      d: d3.symbol().type(symbol).size(p.alsoOfficial ? size * 1.6 : size)(),
      fill: vendorColor(p.creator),
      stroke: p.onFrontier ? (cssVar('--frontier') || cssVar('--accent')) : cssVar('--paper'),
      'stroke-width': p.onFrontier ? 2.5 : 1.5,
    });
    const g = s(
      'g',
      {
        class: `pt${p.onFrontier ? ' on-frontier' : ''}`,
        'data-model': p.model,
        'data-org': p.creator,
        transform: `translate(${x(p.price)},${y(p.score)})`,
        tabindex: 0,
        role: 'img',
        'aria-label': `${p.model}，${p.creator}，分数 ${fmtNum(p.score)}，输出单价 ${fmtPrice(p.price)}${p.alsoOfficial ? '，官方榜单也收录' : ''}`,
      },
      s('circle', { r: 13, fill: 'transparent' }),
      mark,
    );
    bindTip(g, () => supplementTip(p));
    g.addEventListener('mouseenter', () => showCrosshairs(p));
    g.addEventListener('mouseleave', () => clearCrosshairs());
    g.addEventListener('focus', () => showCrosshairs(p));
    g.addEventListener('blur', () => clearCrosshairs());
    pointsG.append(g);
  }
  svg.append(reticleG, pointsG);

  const items = pts.map((p) => {
    const it = labelItem(x(p.price), y(p.score), p.model, null);
    it.model = p.model;
    it.org = p.creator;
    it.onFrontier = p.onFrontier;
    return it;
  });
  const scrollBox = document.getElementById('chart-scroll');
  const viewWidth = scrollBox ? scrollBox.clientWidth : container.clientWidth;
  const visibleLeft = W > viewWidth ? Math.max(0, W - viewWidth) : undefined;
  const bounds = {
    x0: 4,
    y0: 4,
    x1: W - 4,
    y1: H - m.bottom,
    visibleLeft,
  };
  const placed = placeLabels(items, bounds);

  const leadersG = s('g', { class: 'lbl-leaders' });
  const labelsG = s('g', { class: 'lbls' });
  items.forEach((it, i) => {
    const pos = placed.get(i);
    if (pos && pos.line) {
      leadersG.append(s('line', {
        class: 'lbl-line',
        x1: pos.line.x1,
        y1: pos.line.y1,
        x2: pos.line.x2,
        y2: pos.line.y2,
      }));
    }
    labelsG.append(labelNode(it, pos));
  });
  svg.append(leadersG, labelsG);

  container.append(svg);
  if (scrollBox && scrollBox.scrollWidth > scrollBox.clientWidth) {
    scrollBox.scrollLeft = scrollBox.scrollWidth - scrollBox.clientWidth;
  }
  if (frontierPath && showFrontier) playFrontierIntro(frontierPath);
}

function supplementTip(p) {
  const rows = [
    ['厂商', p.creator],
    ['分数（AA 评测）', `${fmtNum(p.score)}%`],
    ['输出单价', fmtPrice(p.price)],
    ['发布日期', p.releaseDate ?? dash],
  ];
  if (p.alsoOfficial) rows.push(['官方榜单', '也收录了此模型（官方分数见官方视图）']);
  return tipTable(p.model, rows);
}

/* ---------- X 轴标题、图例、图注 ---------- */

export function renderXTitle(host, title, tipText) {
  clear(host);
  host.append(h('span', { text: title }));
  if (!tipText) return;
  const btn = h('button', { type: 'button', class: 'info-icon', 'aria-label': `${title} 的说明`, text: 'ⓘ' });
  bindTip(btn, () => h('div', { text: tipText }));
  btn.addEventListener('click', () => showTipAtElement(h('div', { text: tipText }), btn));
  host.append(btn);
}

function frontierSwatch(active = true) {
  const color = cssVar('--frontier') || cssVar('--accent');
  return s(
    'svg',
    { width: 28, height: 16, 'aria-hidden': 'true', class: 'swatch-svg' },
    s('line', {
      x1: 2,
      y1: 14,
      x2: 26,
      y2: 2,
      stroke: active ? color : 'var(--muted)',
      'stroke-width': 2.5,
      'stroke-linecap': 'round',
    }),
    s('circle', {
      cx: 14,
      cy: 8,
      r: 3.5,
      fill: active ? color : 'var(--muted)',
      stroke: 'var(--paper)',
      'stroke-width': 1.5,
    }),
  );
}

export function setVendorHighlight(org) {
  const svg = document.querySelector('.chart-svg');
  if (!svg) return;
  if (!org) {
    svg.classList.remove('has-vendor-focus');
    for (const el of svg.querySelectorAll('.vendor-match')) el.classList.remove('vendor-match');
    return;
  }
  svg.classList.add('has-vendor-focus');
  for (const el of svg.querySelectorAll('[data-org]')) {
    el.classList.toggle('vendor-match', el.getAttribute('data-org') === org);
  }
}

export function setFrontierHighlight(highlight) {
  const svg = document.querySelector('.chart-svg');
  if (!svg) return;
  svg.classList.toggle('highlight-frontier', Boolean(highlight));
}

export function renderOfficialLegend(host, view, options = {}) {
  clear(host);
  const showFrontier = options.showFrontier ?? true;
  const onToggle = options.onToggleFrontier;

  // 第一行：最优前沿交互切换与连线说明
  const rulesRow = h('div', { class: 'legend-row legend-rules' });
  const frontierBtn = h(
    'button',
    {
      type: 'button',
      class: `legend-btn frontier-toggle${showFrontier ? ' is-active' : ' is-muted'}`,
      'aria-pressed': showFrontier ? 'true' : 'false',
      title: showFrontier ? '点击隐藏最优前沿' : '点击显示最优前沿',
      onclick: onToggle,
    },
    frontierSwatch(showFrontier),
    h('span', { text: view.metric.legendText }),
    h('span', { class: 'legend-action-hint', text: showFrontier ? '显示中' : '已隐藏' }),
  );
  frontierBtn.addEventListener('mouseenter', () => options.onHoverFrontier?.(true));
  frontierBtn.addEventListener('mouseleave', () => options.onHoverFrontier?.(false));
  rulesRow.append(frontierBtn);
  rulesRow.append(h('span', { class: 'legend-item', text: '同色系深浅连线：同一模型不同推理档位' }));

  // 第二行：厂商标注芯片（支持反复点击隐藏与重新显示）
  const vendorsRow = h('div', { class: 'legend-row legend-vendors', role: 'group', 'aria-label': '厂商筛选与图例' });
  vendorsRow.append(h('span', { class: 'legend-label', text: '厂商：' }));

  const allOrgs = view.filterTree
    ? [...new Set(view.filterTree.map((n) => n.org))]
    : [...new Set(view.points.map((p) => p.org))];

  for (const org of allOrgs) {
    const orgNodes = view.filterTree ? view.filterTree.filter((n) => n.org === org) : [];
    const totalCount = orgNodes.length > 0
      ? orgNodes.reduce((acc, n) => acc + n.total, 0)
      : view.points.filter((p) => p.org === org).length;
    const selectedCount = orgNodes.length > 0
      ? orgNodes.reduce((acc, n) => acc + n.selected, 0)
      : view.points.filter((p) => p.org === org).length;
    const isVisible = selectedCount > 0;

    const chip = h(
      'button',
      {
        type: 'button',
        class: `legend-btn vendor-chip${isVisible ? ' is-active' : ' is-muted'}${options.activeVendor === org ? ' is-focused' : ''}`,
        'data-vendor': org,
        'aria-pressed': isVisible ? 'true' : 'false',
        title: isVisible
          ? `${org ?? '其他'}：${selectedCount}/${totalCount} 个配置（点击隐藏）`
          : `${org ?? '其他'}：已隐藏（点击显示）`,
        onclick: () => options.onSelectVendor?.(org),
      },
      h('span', { class: 'dot', style: `background:${vendorColor(org)}` }),
      h('span', { text: org ?? '其他' }),
      h('span', {
        class: 'chip-count num',
        text: selectedCount === totalCount || selectedCount === 0
          ? String(totalCount)
          : `${selectedCount}/${totalCount}`,
      }),
    );
    chip.addEventListener('mouseenter', () => options.onHoverVendor?.(org));
    chip.addEventListener('mouseleave', () => options.onHoverVendor?.(null));
    vendorsRow.append(chip);
  }

  host.append(rulesRow, vendorsRow);
}

export function renderSupplementLegend(host, view, options = {}) {
  clear(host);
  const showFrontier = options.showFrontier ?? true;
  const onToggle = options.onToggleFrontier;

  // 第一行：官方收录注记与最优前沿交互切换
  const rulesRow = h('div', { class: 'legend-row legend-rules' });
  const diamond = s(
    'svg',
    { width: 16, height: 16, 'aria-hidden': 'true' },
    s('path', { d: d3.symbol().type(d3.symbolDiamond).size(110)(), transform: 'translate(8,8)', fill: cssVar('--muted') }),
  );
  rulesRow.append(h('span', { class: 'legend-item' }, diamond, '官方榜单也收录了此模型（这里的分数来自另一套评测）'));

  const frontierBtn = h(
    'button',
    {
      type: 'button',
      class: `legend-btn frontier-toggle${showFrontier ? ' is-active' : ' is-muted'}`,
      'aria-pressed': showFrontier ? 'true' : 'false',
      title: showFrontier ? '点击隐藏最优前沿' : '点击显示最优前沿',
      onclick: onToggle,
    },
    frontierSwatch(showFrontier),
    h('span', { text: '最优前沿（按单价）：没有“单价更低且分数更高”的模型' }),
    h('span', { class: 'legend-action-hint', text: showFrontier ? '显示中' : '已隐藏' }),
  );
  frontierBtn.addEventListener('mouseenter', () => options.onHoverFrontier?.(true));
  frontierBtn.addEventListener('mouseleave', () => options.onHoverFrontier?.(false));
  rulesRow.append(frontierBtn);

  // 第二行：厂商标注芯片（支持反复点击隐藏与重新显示）
  const vendorsRow = h('div', { class: 'legend-row legend-vendors', role: 'group', 'aria-label': '厂商筛选与图例' });
  vendorsRow.append(h('span', { class: 'legend-label', text: '厂商：' }));

  for (const v of view.vendors) {
    const isVisible = v.selected;
    const chip = h(
      'button',
      {
        type: 'button',
        class: `legend-btn vendor-chip${isVisible ? ' is-active' : ' is-muted'}${options.activeVendor === v.creator ? ' is-focused' : ''}`,
        'data-vendor': v.creator,
        'aria-pressed': isVisible ? 'true' : 'false',
        title: isVisible
          ? `${v.creator}：${v.total} 个模型（点击隐藏）`
          : `${v.creator}：已隐藏（点击显示）`,
        onclick: () => options.onSelectVendor?.(v.creator),
      },
      h('span', { class: 'dot', style: `background:${vendorColor(v.creator)}` }),
      h('span', { text: v.creator }),
      h('span', { class: 'chip-count num', text: String(v.total) }),
    );
    chip.addEventListener('mouseenter', () => options.onHoverVendor?.(v.creator));
    chip.addEventListener('mouseleave', () => options.onHoverVendor?.(null));
    vendorsRow.append(chip);
  }

  host.append(rulesRow, vendorsRow);
}

function roundedRange(v) {
  return `±${Number(v.toFixed(2))}`;
}

export function renderOfficialNotes(host, view) {
  clear(host);
  if (view.truncated) {
    host.append(h('p', { class: 'warn-note', text: '官方接口返回的数据不完整（分页没有取完），图中可能缺少部分榜单行。' }));
  }
  if (view.missing > 0) {
    host.append(h('p', { text: `${view.missing} 行缺少该指标（${view.metric.label}），未画在图上。` }));
  }
  const { ciMin, ciMax } = view.notes;
  if (ciMin !== null && ciMax !== null) {
    host.append(
      h('p', {
        text: `分数接近的行在统计上分不出高下：每行有 95% 置信区间（悬停查看），约 ${roundedRange(ciMin)} 到 ${roundedRange(ciMax)} 个百分点。`,
      }),
    );
  }
  host.append(
    h('p', {
      text: '官方榜单只收录维护者评测过的模型；未收录且有公开价格的（如 DeepSeek、Kimi、MiniMax）请看「补充」视图。无公开价格的开源或自托管模型（如 Qwen、GLM 的部分型号）两个视图都无法绘制。',
    }),
  );
}

export function renderSupplementNotes(host, view) {
  clear(host);
  const n = view.excluded.length;
  const names = n === 0 ? '没有被排除的模型' : view.excluded.map((e) => e.model ?? e.slug ?? '（未命名）').join('、');
  const trigger = h('button', { type: 'button', class: 'excluded-trigger', text: `已排除 ${n} 个无公开价格的模型` });
  bindTip(trigger, () => h('div', { text: names }));
  trigger.addEventListener('click', () => showTipAtElement(h('div', { text: names }), trigger));
  host.append(h('p', {}, trigger));
  host.append(h('p', { text: '补充视图的分数来自另一套评测，只画输出单价（美元 / 百万 token），不是每任务成本；分数为 0 的模型也会显示。' }));
}

/* ---------- 预算梯 ---------- */

// 悬停、键盘聚焦与点按固定三条来源合成同一个“当前档”：悬停优先，其次聚焦，最后是固定。
const ladder = { host: null, hover: null, focus: null, pinned: null };

// 图重绘后必须再调用一次，把当前档的高亮补回新图上。
export function applyLadder() {
  const active = ladder.hover ?? ladder.focus ?? ladder.pinned;
  if (ladder.host) {
    for (const btn of ladder.host.querySelectorAll('.tier')) {
      const limit = Number(btn.dataset.limit);
      btn.classList.toggle('is-active', limit === active);
      btn.setAttribute('aria-pressed', String(limit === ladder.pinned));
    }
  }
  setBudgetHighlight(active);
}

function tierLabel(limit, best) {
  if (best.length === 0) return `预算 ≤$${limit}，没有榜单行`;
  const rows = best.map((p) => `${p.model}，${p.framework}，${p.effort}，分数 ${fmtScore(p.score, p.ciHalf)}，成本 ${fmtCost(p.cost)}`);
  return `预算 ≤$${limit}，最佳榜单行 ${rows.join('；')}`;
}

function bestRow(p) {
  return h(
    'span',
    { class: 'tier-best' },
    h('span', { class: 'tier-model', text: p.model }),
    h('span', { class: 'tier-meta' }, h('span', { text: p.framework }), h('span', { class: 'tag', text: p.effort })),
    h(
      'span',
      { class: 'tier-figs' },
      h('span', { class: 'tier-score num', text: fmtScore(p.score, p.ciHalf) }),
      h('span', { class: 'tier-cost' }, '成本 ', h('span', { class: 'num', text: fmtCost(p.cost) })),
    ),
  );
}

function tierButton(limit, best) {
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'tier',
      'data-limit': limit,
      'aria-pressed': ladder.pinned === limit ? 'true' : 'false',
      'aria-label': tierLabel(limit, best),
    },
    h('span', { class: 'tier-price' }, h('span', { class: 'cap', text: '≤' }), h('span', { text: `$${limit}` })),
    h('span', { class: 'tier-body' }, best.length === 0 ? h('span', { class: 'tier-none', text: dash }) : best.map(bestRow)),
  );
  btn.addEventListener('mouseenter', () => {
    ladder.hover = limit;
    applyLadder();
  });
  btn.addEventListener('mouseleave', () => {
    ladder.hover = null;
    applyLadder();
  });
  // 鼠标点击也会让按钮获得焦点，只有键盘焦点才算“聚焦”，否则点按取消固定后高亮会一直留着。
  btn.addEventListener('focus', () => {
    if (btn.matches(':focus-visible')) {
      ladder.focus = limit;
      applyLadder();
    }
  });
  btn.addEventListener('blur', () => {
    ladder.focus = null;
    applyLadder();
  });
  btn.addEventListener('click', () => {
    ladder.pinned = ladder.pinned === limit ? null : limit;
    applyLadder();
  });
  return btn;
}

// 预算梯是散点图的文字等价物：屏幕阅读器读到的就是每档最佳榜单行。
export function renderBudgetLadder(host, table) {
  const focusedLimit = host.contains(document.activeElement) ? document.activeElement.dataset?.limit : null;
  clear(host);
  ladder.host = host;
  ladder.hover = null;
  ladder.focus = null;
  const stage = host.parentElement;
  if (table === null) {
    ladder.pinned = null;
    host.hidden = true;
    stage?.classList.add('no-ladder');
    return;
  }
  host.hidden = false;
  stage?.classList.remove('no-ladder');

  host.append(
    h('h2', { class: 'ladder-title', text: '预算档内分数最高的榜单行' }),
    h('ol', { class: 'tiers' }, table.map(({ limit, best }) => h('li', {}, tierButton(limit, best)))),
    h('p', {
      class: 'ladder-hint',
      text: '预算档是累计阈值（≤$10 包含 ≤$5 的行），只统计当前可见的点；分数并列时并列显示，成本更低者靠前。悬停或聚焦某一档，图中成本不超过该档的区域会亮起，点按可固定。',
    }),
  );
  if (focusedLimit) host.querySelector(`.tier[data-limit="${focusedLimit}"]`)?.focus({ preventScroll: true });
  applyLadder();
}

/* ---------- 筛选下拉 ---------- */

const openState = new WeakMap();
let dropdownSeq = 0;

document.addEventListener('click', (e) => {
  const path = e.composedPath();
  for (const host of document.querySelectorAll('.dropdown')) {
    if (openState.get(host) && !path.includes(host)) closeDropdown(host);
  }
});

function setDropdownOpen(host, open) {
  openState.set(host, open);
  const panel = host.querySelector('.dropdown-panel');
  const btn = host.querySelector('.dropdown-btn');
  if (panel) panel.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeDropdown(host, restoreFocus = false) {
  setDropdownOpen(host, false);
  if (restoreFocus) host.querySelector('.dropdown-btn')?.focus();
}

// 键盘约定：Escape 关闭并把焦点还给触发按钮；触发按钮或行复选框上用上下方向键在模型行之间移动；Tab 离开面板时自动收起。
function bindDropdownKeys(host) {
  if (host.dataset.keysBound) return;
  host.dataset.keysBound = '1';
  host.addEventListener('keydown', (e) => {
    const open = openState.get(host) === true;
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      closeDropdown(host, true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const boxes = [...host.querySelectorAll('input[data-fk^="row:"]')];
    const active = document.activeElement;
    const onToggle = active?.classList?.contains('dropdown-btn');
    const index = boxes.indexOf(active);
    if (!onToggle && index === -1) return;
    e.preventDefault();
    if (onToggle) {
      if (!open && e.key === 'ArrowUp') return;
      if (!open) setDropdownOpen(host, true);
      boxes[e.key === 'ArrowDown' ? 0 : boxes.length - 1]?.focus();
      return;
    }
    boxes[index + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  });
  // relatedTarget 为空说明是窗口失焦或控件被重绘摘掉，这两种都不该收起面板。
  host.addEventListener('focusout', (e) => {
    if (openState.get(host) && e.relatedTarget instanceof Node && !host.contains(e.relatedTarget)) closeDropdown(host);
  });
}

function rowElement(row, handlers) {
  const checkbox = h('input', {
    type: 'checkbox',
    'data-fk': `row:${row.key}`,
    checked: row.state === 'all',
    onchange: () => handlers.onToggleRow(row.key),
  });
  checkbox.indeterminate = row.state === 'some';
  const head = h(
    'div',
    { class: 'model-head' },
    h(
      'label',
      {},
      checkbox,
      row.color ? h('span', { class: 'dot', style: `background:${row.color}` }) : null,
      h('span', { class: 'model-name', text: row.name, title: row.name }),
    ),
    h('span', { class: 'count num', text: `${row.selected}/${row.total}` }),
  );
  const el = h('div', { class: 'model-row' }, head);
  if (row.efforts) {
    el.append(
      h(
        'div',
        { class: 'effort-btns', role: 'group', 'aria-label': `${row.name} 的档位` },
        row.efforts.map((ef) =>
          h('button', {
            type: 'button',
            class: 'effort-btn',
            text: ef.effort,
            'data-fk': `eff:${row.key}:${ef.effort}`,
            'aria-pressed': ef.available && ef.selected ? 'true' : 'false',
            disabled: !ef.available,
            title: ef.available ? null : `${row.name} 没有 ${ef.effort} 档位的数据`,
            onclick: () => handlers.onToggleEffort(row.key, ef.effort),
          }),
        ),
      ),
    );
  }
  return el;
}

// 重绘会销毁刚被点击的控件，所以按 data-fk 记住焦点并在重绘后恢复，否则键盘用户每按一次就丢焦点。
export function renderFilterDropdown(host, spec) {
  const focusKey = host.contains(document.activeElement) ? document.activeElement.getAttribute?.('data-fk') : null;
  const scrollTop = host.querySelector('.dropdown-list')?.scrollTop ?? 0;
  const wasOpen = openState.get(host) === true;
  if (!host.dataset.dropdownId) host.dataset.dropdownId = String(++dropdownSeq);
  const panelId = `dropdown-panel-${host.dataset.dropdownId}`;
  bindDropdownKeys(host);
  clear(host);

  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn dropdown-btn',
      'aria-haspopup': 'true',
      'aria-expanded': wasOpen ? 'true' : 'false',
      'aria-controls': panelId,
      'data-fk': 'toggle',
    },
    h('span', { text: `${spec.label}（${spec.selected}/${spec.total}）` }),
    h('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }),
  );
  const list = h('div', { class: 'dropdown-list' }, spec.rows.map((row) => rowElement(row, spec)));
  const foot = h(
    'div',
    { class: 'dropdown-foot' },
    h('button', { type: 'button', class: 'btn', text: '全选', 'data-fk': 'all', onclick: spec.onSelectAll }),
    h('button', { type: 'button', class: 'btn', text: '清空', 'data-fk': 'clear', onclick: spec.onClear }),
  );
  const panel = h('div', { class: 'dropdown-panel', id: panelId, role: 'group', 'aria-label': spec.label, hidden: !wasOpen }, list, foot);

  btn.addEventListener('click', () => setDropdownOpen(host, !(openState.get(host) === true)));
  host.append(btn, panel);
  list.scrollTop = scrollTop;

  if (focusKey) {
    const target = [...host.querySelectorAll('[data-fk]')].find((n) => n.getAttribute('data-fk') === focusKey && !n.disabled);
    if (target) target.focus({ preventScroll: true });
  }
}

export function officialFilterSpec(view, handlers) {
  return {
    label: '配置',
    selected: view.counts.selected,
    total: view.counts.total,
    rows: view.filterTree.map((node) => ({
      key: node.model,
      name: node.model,
      color: vendorColor(node.org),
      state: node.state,
      selected: node.selected,
      total: node.total,
      efforts: node.efforts,
    })),
    ...handlers,
  };
}

export function supplementFilterSpec(view, handlers) {
  const selectedVendors = view.vendors.filter((v) => v.selected).length;
  return {
    label: '厂商',
    selected: selectedVendors,
    total: view.vendors.length,
    rows: view.vendors.map((v) => ({
      key: v.creator,
      name: v.creator,
      color: vendorColor(v.creator),
      state: v.selected ? 'all' : 'none',
      selected: v.selected ? v.total : 0,
      total: v.total,
      efforts: null,
    })),
    ...handlers,
  };
}

/* ---------- 状态面板（加载、失败） ---------- */

// kind：loading 用 status（不打断朗读），error 用 alert 并带竖线标记。
export function renderStatePanel(host, { title, message, actions = [], kind = 'loading' }) {
  clear(host);
  hideTip();
  activeChart = null;
  const isError = kind === 'error';
  host.append(
    h(
      'div',
      { class: `state-panel${isError ? ' is-error' : ''}`, role: isError ? 'alert' : 'status' },
      title ? h('h2', { text: title }) : null,
      message ? h('p', { text: message }) : null,
      actions.map((a) => h('button', { type: 'button', class: `btn${a.primary ? ' primary' : ''}`, text: a.label, onclick: a.onClick })),
    ),
  );
}
