Type: research
Status: resolved
Blocked by:

# BenchLM 数据集 API：实际有哪些端点和字段？

## Question

BenchLM `/data` 声称提供 JSON API（排行榜、定价）。请核实并记录：

1. 端点 URL、请求方式、是否需要 key、返回格式、分页。
2. Terminal-Bench 4.0 的 27 个模型的分数字段：是否含配置（harness/reasoning level）、厂商、快照日期。
3. 定价字段：输入/输出价格单位是否为 $/百万 token；能否按模型对上 Terminal-Bench 的每一行（尤其"同一模型不同推理档位"的行怎么对应价格）。
4. 是否有跨基准的统一模型 ID，能否取到综合分/类别分（如 Agentic 加权分）、速度、上下文长度、发布日期。
5. 更新频率（页面标了快照日期 2026-09-28）和数据体积，抓一份样例落到 `research/` 目录。

产出：一份字段清单 + 模型 ID 联接可行性结论（可联/部分可联/不可联）+ 样例数据文件路径。

## Answer

完整报告：`../research/01-benchlm-api-fields.md`，样例：`../research/benchlm-samples/`。

- 端点：`/api/data/leaderboard`（前50）、`/api/data/pricing`（前100）；完整数据 `/data/{models,pricing,speed,leaderboard,benchmarks,comparisons}.json`。GET、无 key、无分页、CC BY-NC 4.0。
- TB4 的 27 行只在页面内嵌 `__NEXT_DATA__`，无独立 JSON 端点（未验证 `/_next/data/...`）。
- 联接：部分可联。slug 一致；价格、速度只到模型级，不区分推理档位；速度缺 gpt-5-6-terra、gpt-5-6-luna。
- `models.json` 的 `terminalBench4` 仅 13 个模型有值且为聚合单值；`aaTerminalBench4` 有 25 个（Artificial Analysis 口径）。
- 陷阱：GLM-5.3 价格 0/0（自托管占位）；Opus 5 在 models.json 上下文为 0，以 pricing.json 为准。
- 未验证：更新频率、限速、CORS。
- 用户决定（2026-09-29）：有端点就一律不爬 HTML（合规），因此 TB4 页面内嵌数据不可用，引出工单 05。
