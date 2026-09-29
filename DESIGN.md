# 设计系统规范 (Design System Reference)

> 视觉世界：**恒星巡天图谱与赫罗主序带 (Astronomy Catalog & Hertzsprung–Russell Diagram)**
> 定位：工程师高密度桌面端与移动端内网决策工作台，解答「每任务花费不超过 X 美元时，Terminal-Bench 4.0 能买到的最高分是多少」。

---

## 1. 调色板与语义令牌 (Color Palette & Semantic Tokens)

所有颜色定义于 `web/css/style.css`，严格基于语义令牌，禁止页面硬编码杂色。

### 日间工作台 (Light Theme)
蓝晒星图：纸是带蓝的晒图纸，交互是仪器青，前沿是铜金。
- `--paper`: `#dce7f2`
- `--ink`: `#142033`
- `--surface`: `#f4f8fb`
- `--surface-subtle`: `#e5eef6`
- `--line`: `#b4c7da`
- `--line-strong`: `#6d8aa6`
- `--grid`: `#e8f0f7`
- `--accent`: `#0f6a78`
- `--frontier`: `#9a4a10`
- `--amber`: `#8f4b12`
- `--danger`: `#b42318`
- `--shadow`: `0 1px 3px rgba(20, 32, 51, 0.08)`

### 夜间控制台 (Dark Theme / 深空巡天)
磷光夜空：底是蓝黑，字是淡磷光，交互是仪器青，前沿是恒星黄。
- `--paper`: `#07141c`
- `--ink`: `#d5efe8`
- `--surface`: `#0e2430`
- `--surface-subtle`: `#14303c`
- `--line`: `#1d4c58`
- `--line-strong`: `#3e7580`
- `--grid`: `#0c2832`
- `--accent`: `#3ec4c0`
- `--frontier`: `#e8b03a`
- `--amber`: `#e6b15c`
- `--danger`: `#ff8d7a`
- `--shadow`: `0 2px 6px rgba(0, 0, 0, 0.5)`

### 厂商光谱星谱色 (Vendor Stellar Spectral Colors)
各厂商根据恒星光谱分类呈现独特的光谱发射色：
- Anthropic: `#c2410c` (Light) / `#fb923c` (Dark)
- OpenAI: `#0891b2` (Light) / `#22d3ee` (Dark)
- Google: `#2563eb` (Light) / `#60a5fa` (Dark)
- xAI: `#7c3aed` (Light) / `#a78bfa` (Dark)
- Z-AI: `#ca8a04` (Light) / `#facc15` (Dark)
- DeepSeek: `#4f46e5` (Light) / `#818cf8` (Dark)
- Moonshot AI: `#db2777` (Light) / `#f472b6` (Dark)
- MiniMax: `#16a34a` (Light) / `#4ade80` (Dark)
- Xiaomi: `#ea580c` (Light) / `#fb923c` (Dark)
- StepFun: `#e11d48` (Light) / `#fb7185` (Dark)
- Mistral: `#b45309` (Light) / `#fcd34d` (Dark)
- Thinking Machines Lab: `#6366f1` (Light) / `#a5b4fc` (Dark)

---

## 2. 字体排印规范 (Typography)

彻底弃用外部网络字体（如 Barlow Condensed 或 Google Fonts），采用高质量系统原生字体栈与严格等宽数字。

- **主体文本字体栈 (`--font-body`)**:  
  `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei UI", sans-serif`
- **数值与数据展示 (`--font-num`)**:  
  继承字体栈配合 `font-variant-numeric: tabular-nums`，确保小数点与多位数值在预算梯和表格中严谨对齐。
- **信息层级**:
  - 工具主标题: `18px`, `font-weight: 700`, `letter-spacing: -0.02em`
  - 核心大数字（预算梯大价目）: `36px`（桌面）/ `34px`（移动），`font-weight: 700`, `line-height: 1.05`
  - 小节标题: `14px`, `font-weight: 600`
  - 事实指标标签 / 数据项: `11px` / `15px`
  - 正文与图例文本: `13px` / `12px`

---

## 3. 组件与交互状态 (Components & Interactive States)

### 预算梯 (Budget Ladder)
- **定位**: 成本视图首要证据，以 ≤$5、≤$10、≤$15 三档呈现。
- **默认态**: 1px 细线边框，平整嵌入工作台。
- **激活态 (`.is-active`)**: 全周高亮边框 `1px solid var(--frontier)` + 内部发光环 `box-shadow: inset 0 0 0 1px var(--frontier)`，严禁粗单侧边框 (`border-left: 3px`)，保持工业级精致度。
- **联动行为**: 悬停或聚焦某档，主图散点中非该档候选点降透明度（`opacity: 0.15`），对应最优前沿点高亮放大，并显示预算截止虚线。

### 散点图与赫罗主序带 (Scatter Plot & Main Sequence)
- **坐标系**: X 轴为每任务成本（美元），Y 轴为基准测试准确率得分（0-100）。
- **帕累托前沿**: 阶梯线（Step-after），严禁斜角连线或伪平滑样条线，忠实体现阶梯算力成本递增。
- **非前沿点**: 半透明星点（`opacity: 0.82`），带 1.5px 纯净轮廓。
- **前沿点**: 赫罗主序金黄色实体点，带高对比外环与厂商微点。
- **标签避让**: 动态四象限力导向防重叠算法，严格限制在视口边界内，窄屏与宽屏均不越界。

### 筛选与指标切换 (Controls & Filters)
- **分段控制 (Segmented Control)**: 紧凑包胶胶囊外框，活动项以背景对比与细微阴影突显。
- **下拉复选单 (Dropdown)**: 支持完整键盘交互（上下箭头导航、空格键切换、Escape 退出并还原焦点），无外溢裁切。

---

## 4. 响应式布局规范 (Responsive Adaptations)

- **桌面端 (> 1000px)**:
  - 舞台采用 `grid-template-columns: 300px minmax(0, 1fr)` 双栏，左侧为预算梯决策证据，右侧为主图。
- **平板端 (600px - 1000px)**:
  - 舞台折叠为单栏，预算梯转为图表上方三等分等宽横格，主图保持全宽。
- **移动端 (≤ 600px)**:
  - 预算梯转为三档纵向左右卡片（价格居左，模型及明细居右）。
  - 图表容器支持独立区域内横向滚动，**页面整页严格禁止出现横向滚动条**。
  - 打开或切换至移动端时，图表容器自动平移至右侧，优先让低成本与最优前沿区域进入视线。

---

## 5. 动效预算与无障碍原则 (Motion & Accessibility)

- **无障碍优先**:
  - 色彩对比度严格达标 WCAG AA 级标准（文本 ≥ 4.5:1，UI 组件 ≥ 3:1）。
  - 支持系统及用户级浅色/深色/跟随系统模式持久化切换。
- **动效克制 (Restraint)**:
  - 仅保留 `0.12s - 0.2s` 线性或缓出微过渡。
  - 严格响应 `@media (prefers-reduced-motion: reduce)`：关闭前沿线生长动画，散点图即时呈现，无任何多余弹簧或摆动效果。
