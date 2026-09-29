Type: grilling
Status: resolved
Blocked by:

# 仅用官方端点时，Y 轴的 Terminal-Bench 数据从哪来？

## Question

用户已决定：有官方端点就不爬 HTML。但 TB4 的 27 行（含 harness 与推理档位）只存在于页面内嵌数据中。端点里可用的替代：

- `models.json` 的 `terminalBench4`：仅 13 个模型有值，单值、聚合规则未知，与榜单表不一致。
- `aaTerminalBench4`：25 个模型，Artificial Analysis 口径，不是 BenchLM 榜单本身。
- 其他相邻基准键：`terminalBench21`、`terminalBench2`、`valsTerminalBench21` 等。
- 顺带核实：`/_next/data/<buildId>/benchmarks/terminal-bench-4.json` 是否属于"官方端点"（倾向不算，需用户裁决）。
- 或先邮件 benchlm.ai/contact 询问是否提供 TB4 明细的官方导出。

需要与用户敲定：Y 轴用哪份数据、覆盖的模型少了是否可接受、图上如何标注口径与覆盖数；以及是否先发邮件询问。
调用 `/grilling` 与 `/domain-modeling`。

## Answer

用户于 2026-09-29 确认：

1. Y 轴数据只用**官方榜单（Harbor hub）**，不设回退；若官方榜单不可用，项目暂停，不换成 `aaTerminalBench4` 等其他口径。
2. 取数优先级：公开数据接口或文件；其次才是低频读取网页（每天一次），且仅当官方条款和 `robots.txt` 不禁止；否则暂停并联系 Terminal-Bench 团队。
3. BenchLM 只提供价格、发布日期等模型级数据，不提供 Y 轴分数。
4. 无价格模型不画，图注写明排除数量。
5. 暂不发邮件给 BenchLM。

依据（来自 BenchLM 自己的数据文件）：页面 27 行是官方榜单的镜像（`displayOnly`），行 = 模型 + 智能体框架；端点里 `terminalBench4` 是折算的每模型单值，`aaTerminalBench4` 是 Artificial Analysis 的独立评测，与官方榜单只有 4 和 8 个模型重合。榜单表 27 行只对应 15 个模型。

衍生：新增研究工单 06；03、04 追加被 06 阻塞。词汇表已写入项目根目录 `CONTEXT.md`。
