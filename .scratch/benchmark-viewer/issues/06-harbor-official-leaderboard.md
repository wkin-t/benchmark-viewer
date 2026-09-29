Type: research
Status: resolved
Blocked by:

# 官方榜单（Harbor hub）有没有公开数据接口？条款允许怎么取？

## Question

官方 Terminal-Bench 4.0 榜单地址（来自 BenchLM 数据）：
`https://hub.harborframework.com/datasets/terminal-bench/terminal-bench/latest?tab=leaderboard&leaderboard=4-0-0`
方法说明：`https://www.tbench.ai/news/terminal-bench-4-0`；任务仓库：`https://github.com/harbor-framework/terminal-bench`。

请核实并记录：

1. 是否有公开数据接口、下载文件或开源仓库里的结果文件（JSON/CSV）；端点 URL、是否需要 key、字段（模型、智能体框架、推理档位、分数、试验次数、日期、成本或 token 若有）。
2. 是否含成本、token 用量、步数等字段——若有，能否改变"只能用价格"这个前提。
3. 条款、许可、`robots.txt` 对自动读取与再展示的规定；每天一次是否允许；署名要求。
4. 若无接口，页面是否为前端渲染（背后是否有 XHR 接口）——只记录事实，不实施抓取。
5. 与 BenchLM 镜像的 27 行对照：榜单行数、模型数、是否一致。
6. 模型 ID 如何对上 BenchLM 的 slug（用于联价格）：是否可联、缺口有哪些。

产出：字段清单、取数方式结论（接口/文件/仅网页/不可用）、许可红线、联接可行性、样例保存路径。

## Answer

完整报告：`../research/06-harbor-official-leaderboard.md`，样例：`../research/harbor-samples/`。主要数字已由主会话用样例文件核对（27 行、分数、`total_cost_usd`、`n_trials=330`）。

- **取数方式：官方公开接口**，无需解析 HTML。`POST https://api.harborframework.com/functions/v1/leaderboard-read`，body `{"package":"terminal-bench/terminal-bench","name":"4-0-0","page":1,"page_size":100}`；官方文档写明公开榜单免 key，实测 200、27 行、一页取完，响应带 CORS `*`。
- **字段**：模型/框架/`reasoning_effort`、`accuracy`（0-100）、置信区间、`n_trials`、`pass@k`、**`total_cost_usd`、`total_tokens`**、输出/缓存 token、`avg_trial_duration_sec`、模型发布日期、`updated_at`。无步数字段，无原始 model id。
- **与 BenchLM 镜像一致**：27/27 行分数、档位、顺序相同；去重后 15 个模型。GitHub 仓库 submissions 只有 13 个文件且滞后，仅可交叉校验。
- **成本可用**：官方带实测成本，每次试验平均成本 = `total_cost_usd / n_trials`（例如 GPT-6 Astra max 约 $9.90，Fable 5.1 max 约 $18.92，Sonnet 5 max 约 $29.10）。**计价口径未验证**：GLM-5.3 官方成本非零，而 BenchLM 单价为 0，两个口径不可混用。
- **合规（描述性，非法律意见）**：hub 与 tbench.ai 的 robots.txt 均 404；条款和使用政策未见禁止自动读取，无署名要求；仓库 Apache-2.0，接口数据本身的许可未验证；每天一次无明文限制。建议带可识别 User-Agent、每日一次、缓存落盘。api.harborframework.com 的 robots.txt 未验证。
- **联价格**：官方行无 model id，需用（模型名 + 框架 + 档位）映射到 BenchLM slug，15 项显式映射表，价格 15/15 全覆盖；GLM-5.3 价格为 0 要特殊处理；Fable 5 与 Fable 5.1 是两个 slug。
- **未验证**：接口限流与 `page_size` 上限、成本计价口径、接口数据独立许可、前端页面背后的真实 XHR。

影响：官方成本存在，"只能用价格"的前提不再成立，主视图口径交由 03 决定。
