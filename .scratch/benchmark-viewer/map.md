# Map: Benchmark Viewer（Terminal-Bench 4.0 多视图散点图）

## Destination

一个可 `docker run` 的容器：网页上有与 DeepSWE 样式基本一致的散点图，**主视图为官方 Terminal-Bench 4.0 榜单：X=每任务平均实测成本（可切换输出 token、耗时），Y=官方分数**，带 Pareto 前沿线和"预算档内最好的榜单行"小表，用来回答"每个成本下最好的模型是谁"；另有一个补充视图（Artificial Analysis 分数 vs BenchLM 单价，用于覆盖官方榜单没收录的模型，含中国厂商）；数据由容器缓存并自动更新（官方榜单 6 小时、BenchLM 24 小时），页面显示数据截止时间，并提供带冷却的"立即同步"按钮。到达本地图终点 = 上面这些被一份 spec 完整描述、无待决问题，然后交给实现。

## Notes

- 语言：中文。项目规则见 `CLAUDE.md`。
- 架构：单个 OpenResty 容器 + 静态前端 + `proxy_cache`，详见架构工单。
- 数据源：**Y 轴（Terminal-Bench 4.0 分数）只用官方榜单（Harbor hub），不设回退**；价格、发布日期等模型级数据来自 BenchLM 官方数据集 `https://benchlm.ai/data`（JSON；CC BY-NC 4.0，需署名并附链接，仅非商业）。术语见 `CONTEXT.md`。
- 参考视觉：`https://deepswe.datacurve.ai/` 的散点图（气泡、厂商图标、推理档位着色、Pareto 前沿、悬停详情、指标切换）。
- 口径红线："价格"（$/百万 token，BenchLM）与"成本"（每任务实测美元，官方接口）不可混用，轴标签和图注必须写清；补充视图的分数是 AA 独立评测，不可与官方分数混画或直接比较。
- 数据诚实：无基线对照的结论一律声明"仅描述性"。
- Plan, don't do：本地图只产出决策和 spec，不写实现。
- 用户决定（2026-09-29）：**有官方端点就一律不爬 HTML**（合规优先）。数据运行时拉取，不烘进镜像；BenchLM 优先 `/data/*.json`，不用 `/api/`（robots.txt 有 Disallow）。
- Y 轴取数接口（已核实）：`POST https://api.harborframework.com/functions/v1/leaderboard-read`（官方榜单，27 行，免 key，含实测成本与 token）。

## Decisions so far

<!-- 每关闭一个工单追加一行：[标题](issues/NN-slug.md) — 一句话结论 -->

- [BenchLM 数据集 API：实际有哪些端点和字段？](issues/01-benchlm-api-fields.md) — 官方 JSON 端点无 key；价格/速度只到模型级；TB4 的 27 行仅在页面内嵌数据里，端点里 `terminalBench4` 只覆盖 13 个模型
- [BenchLM 数据许可与署名要求怎么落地？](issues/02-license-attribution.md) — 页脚署名 "Data from BenchLM.ai"+链接+CC BY-NC 4.0；数据运行时拉取，勿烘进镜像；robots.txt 与官方端点冲突，建议邮件确认
- [仅用官方端点时，Y 轴的 Terminal-Bench 数据从哪来？](issues/05-y-axis-data-source.md) — Y 轴只用官方榜单（Harbor hub），无回退；无接口时仅在条款允许下低频读网页；无价格模型不画并注明；BenchLM 只供模型级数据
- [官方榜单（Harbor hub）有没有公开数据接口？条款允许怎么取？](issues/06-harbor-official-leaderboard.md) — 有公开 POST 接口、免 key、27 行与 BenchLM 镜像一致，并自带实测成本和 token；条款未见禁止，接口数据许可未验证；联价格靠 15 项显式映射
- [做哪几张图？每张图的 X/Y 和口径是什么？](issues/03-views-and-metrics.md) — 官方榜单（成本/输出 token/耗时）为主 + AA 补充视图；样式与 DeepSWE 一致；默认 27 点可切最佳档；Pareto 线 + 预算档小表；悬停显示置信区间；不做地区筛选和步数
- [容器怎么组织？同步和前端怎么做？](issues/04-architecture-sync-container.md) — 单个 OpenResty 容器、纯静态前端（D3，无构建）；`proxy_cache` 代理官方榜单（6h）与 BenchLM 数据（24h），上游故障返回旧数据最长 7 天；仅局域网，端口 8088
- [数据截止时间的展示与"立即同步"按钮](issues/08-data-date-and-sync-now.md) — 顶部信息行显示官方数据更新日期与上次同步时间；按钮同时刷新两个上游并明确提示"是否有更新"；服务端全局冷却（官方 10 分钟、BenchLM 1 小时、失败 1 分钟），用 OpenResty Lua 实现
- [补充视图的细节与图上必须出现的说明文字](issues/07-caveats-and-supplement-details.md) — 补充视图只画最优前沿（按单价）不做预算档表；官方成本口径提示放 X 轴 ⓘ；说明文字与页脚清单已定；映射表只用于补充视图的 ◆ 标记

## Not yet specified

- 实现阶段才能验证的技术点（POST 缓存写法、SNI 与 DNS、大文件压缩、Set-Cookie 与缓存、故障与刷新时的缓存行为）——已列在架构和数据日期两份工单的结论里，交给实现时处理

## Out of scope

- 自己估算或推算每任务成本（官方已提供实测成本，不需要也不做估算）
- 解析 BenchLM 页面 HTML / `__NEXT_DATA__`（用户决定：有官方端点就不爬 HTML）
- 商业使用（CC BY-NC 4.0 不允许）
- 按地区筛选模型（数据无国家字段，用户决定不做，只提供按厂商筛选）
- 步数指标（官方接口无该字段）
