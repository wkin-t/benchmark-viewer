# 设计系统规范 (Design System Reference)

> 视觉世界：**纸本手账 (Field Notebook)**——暖米色点阵纸、粗压缩大标题、等宽小写大写标签、芥末黄高光、斜贴贴纸与手写批注。认真记账，但不端着。
> 定位：工程师高密度桌面端与移动端内网决策工作台，解答「每任务花费不超过 X 美元时，Terminal-Bench 4.0 能买到的最高分是多少」。
> 页面结构：报头（徽标 · 标语 · 数据源与主题开关）→ 主标题区（左：大字标题与说明；右：数据快照卡）→ 圆角工具条 → 散点图 → 三张预算票根 → 说明栏。

---

## 1. 调色板与语义令牌 (Color Palette & Semantic Tokens)

所有颜色定义于 `web/css/style.css`，严格基于语义令牌，禁止页面硬编码杂色（半透明色用 `color-mix(in srgb, var(--token) N%, transparent)`）。

### 日间纸面 (Light Theme)
- `--paper`: `#f5f0e3`（叠一层 18px 点阵 `--dots`）
- `--ink`: `#24231f`
- `--surface`: `#fbf8f0`
- `--surface-subtle`: `#efe8d6`
- `--line`: `#ddd3bd`
- `--line-strong`: `#8a8170`
- `--grid`: `#ece5d3`
- `--accent`: `#2b7a72`
- `--frontier`: `#8a5d00`（要当小字用，取深芥末保证 4.5:1）
- `--highlight`: `#f2c53d`（大面积高光：选中分段、硬阴影、标题下划线、贴纸星星，以及图上最优前沿线下 10px 的荧光笔底）
- `--coral`: `#d4685a`（标题句点方块）
- `--danger`: `#b42318`

### 夜间台灯 (Dark Theme)
- `--paper`: `#1b1a17`
- `--ink`: `#f0e9d8`
- `--surface`: `#24221e`
- `--surface-subtle`: `#2c2a25`
- `--line`: `#3a372f`
- `--line-strong`: `#7d7563`
- `--grid`: `#2a2823`
- `--accent`: `#6cc4b8`
- `--frontier` / `--highlight`: `#f2c53d`
- `--coral`: `#e88a7c`
- `--danger`: `#ff8d7a`

### 厂商色 (Vendor Colors)
- Anthropic: `#c2410c` (Light) / `#fb923c` (Dark)
- OpenAI: `#0891b2` (Light) / `#22d3ee` (Dark)
- Google: `#2563eb` (Light) / `#60a5fa` (Dark)
- xAI: `#7c3aed` (Light) / `#a78bfa` (Dark)
- Z.ai: `#0f766e` (Light) / `#2dd4bf` (Dark)（黄、棕留给最优前沿，避免撞色）
- DeepSeek: `#4f46e5` (Light) / `#818cf8` (Dark)
- Moonshot AI: `#db2777` (Light) / `#f472b6` (Dark)
- MiniMax: `#16a34a` (Light) / `#4ade80` (Dark)
- Xiaomi: `#ea580c` (Light) / `#fb923c` (Dark)
- StepFun: `#e11d48` (Light) / `#fb7185` (Dark)
- Mistral: `#b45309` (Light) / `#fcd34d` (Dark)
- Thinking Machines Lab: `#6366f1` (Light) / `#a5b4fc` (Dark)

---

## 2. 字体排印规范 (Typography)

不引入网络字体：正文与数字用内置 Inter / JetBrains Mono，展示与手写都走系统自带字体。

- **展示标题 (`--font-display`)**：自带 Anton（`web/fonts/anton-latin.woff2`，SIL OFL），回落 Impact 等。粗压缩大写，用于主标题与预算票根大价目。自带是因为 Linux 上没有 Impact。
- **等宽小写大写标签 (`.mono-cap`)**：JetBrains Mono 10.5px、`letter-spacing: 0.14em`、全大写，只排英文（报头标语、kicker、工具条标签）。夹在里面的中文包 `.cjk`：回到正文字体、12px、字距 0。纯装饰的英文标签一律 `aria-hidden`，可访问名称保持中文。
- **中文最小 12px**：分段按钮的中文、快照卡字段名都不小于 12px。
- **装饰符号**：伪元素里的 ↻、✳ 写成 `content: "↻" / ""`，读屏器不读。
- **口径随视图**：补充视图（X 轴是每百万 token 单价）下隐藏标语 "Price per task" 与"每任务"说明。
- **手写批注 (`--font-hand`)**：`"Segoe Print", "Bradley Hand", …, KaiTi`，只用于图上的前沿批注这类"随手一笔"。

- **主体文本字体栈 (`--font-body`)**:  
  `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei UI", sans-serif`
- **数值与数据展示 (`--font-num`)**:  
  继承字体栈配合 `font-variant-numeric: tabular-nums`，确保小数点与多位数值在预算梯和表格中严谨对齐。
- **信息层级**:
  - 工具主标题: `18px`, `font-weight: 700`, `letter-spacing: -0.02em`
  - 核心大数字（预算梯大价目）: Anton `34px`（桌面）/ `28px`（移动），`font-weight: 400`, `line-height: 1`。Anton 没有等宽数字特性，价目分属不同票根，不需要跨行对齐。
  - 小节标题: `14px`, `font-weight: 600`
  - 事实指标标签 / 数据项: `11px` / `15px`
  - 正文与图例文本: `13px` / `12px`

---

## 3. 组件与交互状态 (Components & Interactive States)

### 预算梯 (Budget Ladder)
- **定位**: 成本视图首要证据，以 ≤$5、≤$10、≤$15 三档呈现。
- **默认态**: 1px 细线边框，平整嵌入工作台。
- **布局**: 大于 600px 时三档并排为三张票根；手机上竖排，价格居左。
- **激活态 (`.is-active`)**: 墨色全周描边 + 芥末黄硬阴影 `box-shadow: 0 0 0 1px var(--ink), 4px 4px 0 var(--highlight)`，严禁粗单侧边框 (`border-left: 3px`)。
- **联动行为**: 悬停或聚焦某档，主图散点中非该档候选点降透明度（`opacity: 0.15`），对应最优前沿点高亮放大，并显示预算截止虚线。

### 散点图与赫罗主序带 (Scatter Plot & Main Sequence)
- **坐标系**: X 轴为每任务成本（美元），Y 轴为基准测试准确率得分（0-100）。
- **最优前沿**: 前沿点之间直线连接（冒烟测试约束），线下垫一道 `--highlight` 荧光笔底；不用平滑样条。X 轴反向（左贵右便宜），越靠右上越划算。
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
